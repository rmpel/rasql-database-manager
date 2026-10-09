import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  MariaSQL,
  MySQL,
  SQLite,
  StandardSQL,
  keywordCompletionSource,
  sql,
  type SQLDialect,
} from '@codemirror/lang-sql';
import { tags } from '@lezer/highlight';
import { splitStatements, statementAt, type Statement } from '../lib/sql-split';

export interface RunTarget {
  sql: string;
  /** Where it came from: the selection, or statement n of total. */
  source:
    { kind: 'selection' } | { kind: 'statement'; index: number; total: number } | { kind: 'all' };
}

export interface SqlEditorHandle {
  /** The selection if any, otherwise the statement under the cursor. */
  runTarget(): RunTarget | null;
  getDoc(): string;
  setDoc(text: string): void;
  focus(): void;
}

interface Props {
  engine: string;
  initialDoc: string;
  completion: CompletionSource | null;
  onRun: () => void;
  onExplain: () => void;
  onToggleHistory: () => void;
  onEscape: () => void;
}

function dialectFor(engine: string): SQLDialect {
  switch (engine) {
    case 'mariadb':
      return MariaSQL;
    case 'mysql':
    case 'percona':
    case 'aurora-mysql':
    case 'tidb':
    case 'vitess':
      return MySQL;
    case 'sqlite':
      return SQLite;
    default:
      return StandardSQL;
  }
}

/** Colors come from CSS variables in query-editor.scss, so light and dark follow the OS. */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--cm-keyword)', fontWeight: '600' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--cm-type)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string)' },
  { tag: tags.number, color: 'var(--cm-number)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--cm-comment)',
    fontStyle: 'italic',
  },
  { tag: tags.operator, color: 'var(--cm-operator)' },
  { tag: tags.punctuation, color: 'var(--cm-punct)' },
  { tag: [tags.variableName, tags.propertyName], color: 'var(--cm-name)' },
  { tag: tags.bool, color: 'var(--cm-number)' },
  { tag: tags.null, color: 'var(--cm-null)', fontStyle: 'italic' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--fg)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    {
      backgroundColor: 'var(--cm-selection)',
    },
  '.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--cm-active-line)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-2)',
    color: 'var(--fg-2)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--cm-bracket)',
    outline: '1px solid var(--accent)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--cm-selection-match)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg)',
    border: '1px solid var(--border)',
    color: 'var(--fg)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-fg)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-2)',
    color: 'var(--fg)',
    borderBottom: '1px solid var(--border)',
  },
  '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  '.cm-searchMatch': { backgroundColor: 'var(--cm-search)' },
});

/**
 * The SQL editor: CodeMirror 6 with the engine's dialect, schema completion, and the shortcuts
 * the query tab needs. Document state lives inside CodeMirror; React reads it through the handle.
 */
export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(
  { engine, initialDoc, completion, onRun, onExplain, onToggleHistory, onEscape },
  ref,
): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Handlers change identity on every render; the keymap reads the latest through a ref.
  const handlers = useRef({ onRun, onExplain, onToggleHistory, onEscape });
  useEffect(() => {
    handlers.current = { onRun, onExplain, onToggleHistory, onEscape };
  });

  useEffect(() => {
    if (!host.current) return;
    const dialect = dialectFor(engine);
    const sources: CompletionSource[] = [keywordCompletionSource(dialect, true)];
    if (completion) sources.push(completion);
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      autocompletion({ override: sources, activateOnTyping: true, maxRenderedOptions: 40 }),
      sql({ dialect }),
      syntaxHighlighting(highlight),
      theme,
      keymap.of([
        { key: 'Mod-Enter', run: () => (handlers.current.onRun(), true) },
        { key: 'Mod-Shift-e', run: () => (handlers.current.onExplain(), true) },
        { key: 'Mod-Shift-h', run: () => (handlers.current.onToggleHistory(), true) },
        { key: 'Mod-/', run: toggleComment },
        { key: 'Escape', run: () => (handlers.current.onEscape(), false) },
        indentWithTab,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
      ]),
    ];
    const v = new EditorView({
      state: EditorState.create({ doc: initialDoc, extensions }),
      parent: host.current,
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once per engine/completion source; the document is owned by CodeMirror.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, completion]);

  useImperativeHandle(
    ref,
    (): SqlEditorHandle => ({
      runTarget: () => {
        const v = view.current;
        if (!v) return null;
        const sel = v.state.selection.main;
        if (!sel.empty) {
          const text = v.state.sliceDoc(sel.from, sel.to).trim();
          return text ? { sql: text, source: { kind: 'selection' } } : null;
        }
        const doc = v.state.doc.toString();
        const all = splitStatements(doc);
        if (all.length === 0) return null;
        if (all.length === 1) return { sql: (all[0] as Statement).sql, source: { kind: 'all' } };
        const st = statementAt(doc, sel.head);
        if (!st) return null;
        return {
          sql: st.sql,
          source: {
            kind: 'statement',
            index: all.findIndex((x) => x.start === st.start) + 1,
            total: all.length,
          },
        };
      },
      getDoc: () => view.current?.state.doc.toString() ?? '',
      setDoc: (text) => {
        const v = view.current;
        if (!v) return;
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: text },
          selection: { anchor: text.length },
        });
        v.focus();
      },
      focus: () => view.current?.focus(),
    }),
    [],
  );

  return <div className="sql-editor-host" ref={host} />;
});
