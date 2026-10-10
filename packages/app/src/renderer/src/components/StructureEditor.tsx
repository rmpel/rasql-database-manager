import { useEffect, useMemo, useState } from 'react';
import type {
  AlterCapabilities,
  DialectInfo,
  StructureChange,
  TableDefinition,
  TypeDescriptor,
} from '@rasql/driver-protocol';
import { rasql } from '../api';
import {
  columnChanged,
  descriptorFor,
  destructive,
  diffStructure,
  draftFromColumn,
  draftFromDefinition,
  draftProblem,
  formatDefault,
  kindLabel,
  kindOf,
  kindsFor,
  newColumnDraft,
  newForeignKeyDraft,
  partsForKind,
  typesOfKind,
  type ColumnDraft,
  type DefaultMode,
  type ForeignKeyDraft,
  type IndexDraft,
  type IndexKind,
  type StructureDraft,
  type TypeParts,
} from '../lib/structure';

interface Props {
  sessionKey: string;
  definition: TableDefinition;
  /** False for views and read-only connections: the same layout, nothing editable. */
  editable: boolean;
  /** Called after the changes ran; with the new name when the table was renamed. */
  onApplied: (renamedTo?: string) => void;
}

const stripIpc = (err: unknown): string =>
  err instanceof Error
    ? err.message.replace(/^Error invoking remote method '[^']+': /, '').replace(/^\w+Error: /, '')
    : String(err);

const RULES = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'];
const NO_CAPS: AlterCapabilities = {
  addColumn: false,
  dropColumn: false,
  renameColumn: false,
  modifyColumn: false,
  moveColumn: false,
  indexes: false,
  primaryKey: false,
  foreignKeys: false,
  tableComment: false,
  columnComments: false,
  renameTable: false,
  collations: false,
};

let indexSeq = 0;

export function StructureEditor({
  sessionKey,
  definition,
  editable,
  onApplied,
}: Props): React.JSX.Element {
  const [info, setInfo] = useState<DialectInfo | null>(null);
  useEffect(() => {
    let alive = true;
    rasql.session
      .dialect(sessionKey, 'describe', [])
      .then((d) => alive && setInfo(d as DialectInfo))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [sessionKey]);
  const types = useMemo(() => info?.types ?? [], [info]);
  const caps = editable && info?.alter ? info.alter : NO_CAPS;
  const canEdit = Object.values(caps).some(Boolean);

  // The draft restarts whenever the definition changes underneath (after apply, refresh).
  const [draft, setDraft] = useState<StructureDraft | null>(null);
  const [draftFor, setDraftFor] = useState<{
    def: TableDefinition;
    types: TypeDescriptor[];
  } | null>(null);
  if (info && (draftFor?.def !== definition || draftFor.types !== types)) {
    setDraftFor({ def: definition, types });
    setDraft(draftFromDefinition(definition, types));
  }

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ sql: string[]; error: string | null }>({
    sql: [],
    error: null,
  });

  const changes: StructureChange[] = useMemo(
    () => (draft ? diffStructure(definition, draft, types, caps) : []),
    [draft, definition, types, caps],
  );
  const problem = draft ? draftProblem(draft, types) : null;

  // The SQL comes from the driver, so the preview is exactly what will run.
  useEffect(() => {
    if (!changes.length || problem) {
      const t = setTimeout(() => setPreview({ sql: [], error: null }), 0);
      return () => clearTimeout(t);
    }
    let alive = true;
    const t = setTimeout(() => {
      rasql.session
        .dialect(sessionKey, 'buildAlter', [definition, changes])
        .then((sql) => alive && setPreview({ sql: sql as string[], error: null }))
        .catch((e: unknown) => alive && setPreview({ sql: [], error: stripIpc(e) }));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [sessionKey, definition, changes, problem]);

  if (!draft || !info) return <div className="hint">Loading structure…</div>;

  const setColumn = (key: string, patch: Partial<ColumnDraft>): void =>
    setDraft({
      ...draft,
      columns: draft.columns.map((c) => (c.key === key ? { ...c, ...patch } : c)),
    });
  const setIndex = (key: string, patch: Partial<IndexDraft>): void =>
    setDraft({
      ...draft,
      indexes: draft.indexes.map((x) => (x.key === key ? { ...x, ...patch } : x)),
    });
  const setForeignKey = (key: string, patch: Partial<ForeignKeyDraft>): void =>
    setDraft({
      ...draft,
      foreignKeys: draft.foreignKeys.map((x) => (x.key === key ? { ...x, ...patch } : x)),
    });

  const move = (key: string, by: -1 | 1): void => {
    const cols = [...draft.columns];
    const i = cols.findIndex((c) => c.key === key);
    const j = i + by;
    if (j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j] as ColumnDraft, cols[i] as ColumnDraft];
    setDraft({ ...draft, columns: cols });
  };

  const addColumn = (): void => {
    const col = newColumnDraft(
      types,
      draft.columns.map((c) => c.name),
    );
    setDraft({ ...draft, columns: [...draft.columns, col] });
    setFocusKey(col.key);
  };

  /** Rename-aware: indexes and keys show a column's current name in the draft. */
  const liveName = (original: string): string =>
    draft.columns.find((c) => c.original?.name === original)?.name ?? original;
  const liveColumns = draft.columns.filter((c) => !c.dropped).map((c) => c.name.trim());

  const discard = (): void => {
    setDraft(draftFromDefinition(definition, types));
    setError(null);
  };

  const apply = async (): Promise<void> => {
    if (!preview.sql.length) return;
    const warnings = destructive(definition, changes);
    const ok = await rasql.dialog.confirm({
      title: `Apply ${changes.length} change${changes.length === 1 ? '' : 's'} to ${definition.name}?`,
      message: warnings.length
        ? warnings.join('\n')
        : 'Large tables can take a while; the table may be locked meanwhile.',
      detail: preview.sql.join(';\n\n'),
      confirmLabel: 'Apply',
      danger: warnings.length > 0,
    });
    if (!ok) return;
    setApplying(true);
    setError(null);
    try {
      await rasql.session.transaction(sessionKey, preview.sql);
      const renamed = changes.find((c) => c.kind === 'renameTable');
      onApplied(renamed?.kind === 'renameTable' ? renamed.to : undefined);
    } catch (err) {
      setError(stripIpc(err));
    } finally {
      setApplying(false);
    }
  };

  const focused = draft.columns.find((c) => c.key === focusKey);
  const focusedType = focused ? descriptorFor(types, focused.type.base) : undefined;
  const focusedHint =
    focused && focusedType?.description
      ? `${focused.name || 'New column'}: ${focusedType.name} — ${focusedType.description}`
      : null;
  const changeCount = changes.length;
  const fulltext = info.id === 'mysql';

  return (
    <div className="structure structure-editor">
      {canEdit && (
        <div className="structure-actions">
          <span className={`pending-badge${changeCount ? ' has-pending' : ''}`}>
            {changeCount} change{changeCount === 1 ? '' : 's'}
          </span>
          <button
            className="primary"
            onClick={() => void apply()}
            disabled={!preview.sql.length || applying || Boolean(problem)}
          >
            {applying ? 'Applying…' : 'Review and apply'}
          </button>
          <button onClick={discard} disabled={!changeCount || applying}>
            Discard
          </button>
          {problem && <span className="error">{problem}</span>}
          {!problem && preview.error && <span className="error">{preview.error}</span>}
          {error && <span className="error">{error}</span>}
        </div>
      )}

      <h3>Columns</h3>
      <table className="plain structure-columns">
        <thead>
          <tr>
            {caps.moveColumn && <th />}
            <th>Name</th>
            <th>Type</th>
            <th title="May the column be empty (NULL)?">Null</th>
            <th>Default</th>
            <th>Extra</th>
            <th>Comment</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {draft.columns.map((c, i) => {
            const isNew = !c.original;
            const canModify = isNew ? caps.addColumn : caps.modifyColumn;
            const changed = !isNew && columnChanged(c, types);
            const d = descriptorFor(types, c.type.base);
            const category = d?.category;
            const primary = c.original && definition.primaryKey?.includes(c.original.name);
            return (
              <tr
                key={c.key}
                className={c.dropped ? 'dropped' : isNew ? 'added' : changed ? 'changed' : ''}
                onFocusCapture={() => setFocusKey(c.key)}
              >
                {caps.moveColumn && (
                  <td className="move">
                    <button
                      disabled={i === 0 || c.dropped}
                      onClick={() => move(c.key, -1)}
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      disabled={i === draft.columns.length - 1 || c.dropped}
                      onClick={() => move(c.key, 1)}
                      title="Move down"
                    >
                      ↓
                    </button>
                  </td>
                )}
                <td className="name-cell">
                  {primary && <span title="primary key">🔑 </span>}
                  <input
                    className="col-name"
                    value={c.name}
                    disabled={c.dropped || !(isNew || caps.renameColumn || caps.modifyColumn)}
                    onChange={(e) => setColumn(c.key, { name: e.target.value })}
                    spellCheck={false}
                  />
                </td>
                <td className="type-cell">
                  <TypePicker
                    types={types}
                    parts={c.type}
                    disabled={c.dropped || !canModify}
                    onChange={(type) => setColumn(c.key, { type })}
                  />
                </td>
                <td className="center">
                  <input
                    type="checkbox"
                    checked={c.nullable}
                    disabled={c.dropped || !canModify}
                    onChange={(e) =>
                      setColumn(c.key, {
                        nullable: e.target.checked,
                        ...(!e.target.checked && c.defaultMode === 'null'
                          ? { defaultMode: 'none' as const }
                          : {}),
                      })
                    }
                  />
                </td>
                <td>
                  {canModify && !c.dropped ? (
                    <DefaultPicker
                      draft={c}
                      category={category}
                      onChange={(p) => setColumn(c.key, p)}
                    />
                  ) : (
                    <span className="default-text">
                      {c.original?.generated
                        ? `= ${c.original.generated.expression}`
                        : formatDefault(c.original?.default)}
                    </span>
                  )}
                </td>
                <td className="extras">
                  {category === 'integer' && (
                    <label title="The database fills in the next number when a row is added">
                      <input
                        type="checkbox"
                        checked={c.autoIncrement}
                        disabled={c.dropped || !canModify}
                        onChange={(e) => setColumn(c.key, { autoIncrement: e.target.checked })}
                      />
                      auto increment
                    </label>
                  )}
                  {category === 'datetime' && info.id === 'mysql' && (
                    <label title="Set to the current time whenever the row changes">
                      <input
                        type="checkbox"
                        checked={c.onUpdate}
                        disabled={c.dropped || !canModify}
                        onChange={(e) => setColumn(c.key, { onUpdate: e.target.checked })}
                      />
                      on update now
                    </label>
                  )}
                  {c.original?.generated && (
                    <span className="muted">
                      generated, {c.original.generated.stored ? 'stored' : 'virtual'}
                    </span>
                  )}
                </td>
                <td>
                  <input
                    className="col-comment"
                    value={c.comment}
                    placeholder={caps.columnComments ? '' : '—'}
                    disabled={c.dropped || !(caps.columnComments && canModify)}
                    onChange={(e) => setColumn(c.key, { comment: e.target.value })}
                  />
                </td>
                {canEdit && (
                  <td className="row-actions">
                    {c.dropped ? (
                      <button
                        onClick={() => setColumn(c.key, { dropped: false })}
                        title="Keep this column"
                      >
                        ↺
                      </button>
                    ) : isNew ? (
                      <button
                        onClick={() =>
                          setDraft({
                            ...draft,
                            columns: draft.columns.filter((x) => x.key !== c.key),
                          })
                        }
                        title="Remove this new column"
                      >
                        ✕
                      </button>
                    ) : (
                      caps.dropColumn && (
                        <button
                          onClick={() => setColumn(c.key, { dropped: true })}
                          title="Drop this column and its data"
                        >
                          ✕
                        </button>
                      )
                    )}
                    {changed && !c.dropped && c.original && (
                      <button
                        onClick={() =>
                          setDraft({
                            ...draft,
                            columns: draft.columns.map((x) =>
                              x.key === c.key
                                ? { ...draftFromColumn(c.original!, types), key: c.key }
                                : x,
                            ),
                          })
                        }
                        title="Undo the changes to this column"
                      >
                        ↺
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* One fixed line, so focusing a row never shifts the rows under the pointer. */}
      <div className="type-hint">{focusedHint ?? '\u00a0'}</div>
      {caps.addColumn && (
        <button className="add-row" onClick={addColumn}>
          + Column
        </button>
      )}
      {editable && info.alter && !caps.modifyColumn && (
        <p className="hint">
          {info.id === 'sqlite'
            ? 'SQLite can add, rename and drop columns, but changing a column’s type, default or nullability needs the table rebuilt, which RaSQL does not do yet.'
            : 'This driver cannot change existing columns.'}
        </p>
      )}

      <h3>Indexes</h3>
      <table className="plain structure-indexes">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Columns</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {draft.indexes.map((ix) => {
            const isNew = !ix.original;
            const locked = ix.dropped || !caps.indexes;
            return (
              <tr key={ix.key} className={ix.dropped ? 'dropped' : isNew ? 'added' : ''}>
                <td>
                  <input
                    value={ix.kind === 'primary' ? 'PRIMARY' : ix.name}
                    disabled={locked || ix.kind === 'primary'}
                    onChange={(e) => setIndex(ix.key, { name: e.target.value })}
                    spellCheck={false}
                  />
                </td>
                <td>
                  <select
                    value={ix.kind}
                    disabled={locked}
                    onChange={(e) => setIndex(ix.key, { kind: e.target.value as IndexKind })}
                  >
                    {(caps.primaryKey || ix.kind === 'primary') && (
                      <option value="primary">primary key</option>
                    )}
                    <option value="unique">unique</option>
                    <option value="index">index</option>
                    {(fulltext || ix.kind === 'fulltext') && (
                      <option value="fulltext">full text</option>
                    )}
                  </select>
                </td>
                <td className="index-columns">
                  {ix.columns.map((col, n) => (
                    <span key={n} className="index-column">
                      <select
                        value={isNew ? col.name : liveName(col.name)}
                        disabled={locked}
                        onChange={(e) =>
                          setIndex(ix.key, {
                            columns: ix.columns.map((x, m) =>
                              m === n ? { ...x, name: e.target.value } : x,
                            ),
                          })
                        }
                      >
                        {!liveColumns.includes(isNew ? col.name : liveName(col.name)) && (
                          <option value={col.name}>{col.name || 'choose…'}</option>
                        )}
                        {liveColumns.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                      {info.id === 'mysql' && (
                        <input
                          className="prefix"
                          value={col.length}
                          placeholder="len"
                          title="Index only the first characters (needed for long text)"
                          disabled={locked}
                          onChange={(e) =>
                            setIndex(ix.key, {
                              columns: ix.columns.map((x, m) =>
                                m === n ? { ...x, length: e.target.value } : x,
                              ),
                            })
                          }
                        />
                      )}
                      {!locked && ix.columns.length > 1 && (
                        <button
                          className="mini"
                          onClick={() =>
                            setIndex(ix.key, { columns: ix.columns.filter((_, m) => m !== n) })
                          }
                          title="Remove this column from the index"
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  ))}
                  {!locked && (
                    <button
                      className="mini"
                      onClick={() =>
                        setIndex(ix.key, { columns: [...ix.columns, { name: '', length: '' }] })
                      }
                      title="Add a column to the index"
                    >
                      +
                    </button>
                  )}
                </td>
                {canEdit && (
                  <td className="row-actions">
                    {caps.indexes &&
                      (ix.dropped ? (
                        <button
                          onClick={() => setIndex(ix.key, { dropped: false })}
                          title="Keep this index"
                        >
                          ↺
                        </button>
                      ) : (
                        <button
                          onClick={() =>
                            isNew
                              ? setDraft({
                                  ...draft,
                                  indexes: draft.indexes.filter((x) => x.key !== ix.key),
                                })
                              : setIndex(ix.key, { dropped: true })
                          }
                          title="Drop this index"
                        >
                          ✕
                        </button>
                      ))}
                  </td>
                )}
              </tr>
            );
          })}
          {draft.indexes.length === 0 && (
            <tr>
              <td colSpan={4} className="hint">
                No indexes.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {caps.indexes && (
        <button
          className="add-row"
          onClick={() =>
            setDraft({
              ...draft,
              indexes: [
                ...draft.indexes,
                {
                  key: `ix${++indexSeq}`,
                  original: null,
                  name: `${definition.name}_idx${draft.indexes.length + 1}`,
                  kind: 'index',
                  columns: [{ name: liveColumns[0] ?? '', length: '' }],
                  dropped: false,
                },
              ],
            })
          }
        >
          + Index
        </button>
      )}

      {(definition.foreignKeys.length > 0 || caps.foreignKeys) && (
        <ForeignKeys
          sessionKey={sessionKey}
          schema={definition.schema}
          drafts={draft.foreignKeys}
          liveColumns={liveColumns}
          liveName={liveName}
          editable={caps.foreignKeys}
          onChange={setForeignKey}
          onAdd={() =>
            setDraft({ ...draft, foreignKeys: [...draft.foreignKeys, newForeignKeyDraft()] })
          }
          onRemoveNew={(key) =>
            setDraft({ ...draft, foreignKeys: draft.foreignKeys.filter((x) => x.key !== key) })
          }
        />
      )}

      {(caps.renameTable || caps.tableComment || definition.comment) && (
        <>
          <h3>Table</h3>
          <div className="structure-table">
            <label>
              Name
              <input
                value={draft.name}
                disabled={!caps.renameTable}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                spellCheck={false}
              />
            </label>
            {(caps.tableComment || definition.comment) && (
              <label className="grow">
                Comment
                <input
                  value={draft.comment}
                  disabled={!caps.tableComment}
                  onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
                />
              </label>
            )}
          </div>
        </>
      )}

      {preview.sql.length > 0 && (
        <>
          <h3>SQL to run</h3>
          <pre className="structure-sql">{preview.sql.join(';\n\n')};</pre>
        </>
      )}

      {definition.ddl && (
        <details className="structure-ddl">
          <summary>CREATE statement</summary>
          <pre>{definition.ddl}</pre>
        </details>
      )}
    </div>
  );
}

function TypePicker({
  types,
  parts,
  disabled,
  onChange,
}: {
  types: TypeDescriptor[];
  parts: TypeParts;
  disabled: boolean;
  onChange: (parts: TypeParts) => void;
}): React.JSX.Element {
  const d = descriptorFor(types, parts.base);
  const kind = kindOf(types, parts.base);
  if (!d) {
    // A type the driver does not list, e.g. SQLite's free-form declarations: shown as written.
    return (
      <span className="type-picker">
        <code>
          {[parts.base.toLowerCase(), parts.length && `(${parts.length})`].filter(Boolean).join('')}
        </code>
      </span>
    );
  }
  const num = (v: string): string => v.replace(/[^\d]/g, '');
  return (
    <span className="type-picker">
      <select
        value={kind?.id ?? ''}
        disabled={disabled}
        title="What kind of data the column holds"
        onChange={(e) => onChange(partsForKind(types, e.target.value))}
      >
        {kindsFor(types).map((k) => (
          <option key={k.id} value={k.id}>
            {kindLabel(k, types)}
          </option>
        ))}
      </select>
      <select
        value={d.name}
        disabled={disabled}
        title={d.description ?? d.name}
        onChange={(e) => {
          const next = descriptorFor(types, e.target.value);
          onChange({
            ...parts,
            base: e.target.value,
            // Sizes only carry over when the new type takes the same ones.
            length: next?.hasLength ? parts.length : '',
            precision: next?.hasPrecision ? parts.precision : '',
            scale: next?.hasScale ? parts.scale : '',
            unsigned: next?.unsignedAllowed ? parts.unsigned : false,
            values: next?.hasValues ? parts.values : [],
          });
        }}
      >
        {typesOfKind(types, kind?.id ?? '').map((t) => (
          <option key={t.name} value={t.name} title={t.description}>
            {t.name}
          </option>
        ))}
      </select>
      {d.hasLength && (
        <input
          className="size"
          value={parts.length}
          disabled={disabled}
          placeholder={d.category === 'integer' ? 'width' : 'length'}
          title={
            d.category === 'integer'
              ? 'Display width only; it does not limit the value. Usually left empty.'
              : 'Maximum length'
          }
          onChange={(e) => onChange({ ...parts, length: num(e.target.value) })}
        />
      )}
      {d.hasPrecision && d.hasScale && (
        <>
          <input
            className="size"
            value={parts.precision}
            disabled={disabled}
            placeholder="digits"
            title="Total number of digits"
            onChange={(e) => onChange({ ...parts, precision: num(e.target.value) })}
          />
          <input
            className="size"
            value={parts.scale}
            disabled={disabled}
            placeholder="decimals"
            title="Digits after the decimal point"
            onChange={(e) => onChange({ ...parts, scale: num(e.target.value) })}
          />
        </>
      )}
      {d.hasPrecision && !d.hasScale && !d.hasLength && (
        <input
          className="size"
          value={parts.precision}
          disabled={disabled}
          placeholder="fsp"
          title="Fractions of a second to keep, 0 to 6"
          onChange={(e) => onChange({ ...parts, precision: num(e.target.value) })}
        />
      )}
      {d.unsignedAllowed && (
        <label className="unsigned" title="No negative numbers; doubles the positive range">
          <input
            type="checkbox"
            checked={parts.unsigned}
            disabled={disabled}
            onChange={(e) => onChange({ ...parts, unsigned: e.target.checked })}
          />
          unsigned
        </label>
      )}
      {d.hasValues && (
        <input
          className="values"
          value={parts.values.join(', ')}
          disabled={disabled}
          placeholder="draft, publish, private"
          title="The allowed values, separated by commas"
          onChange={(e) =>
            onChange({ ...parts, values: e.target.value.split(',').map((v) => v.trim()) })
          }
        />
      )}
    </span>
  );
}

function DefaultPicker({
  draft: c,
  category,
  onChange,
}: {
  draft: ColumnDraft;
  category: string | undefined;
  onChange: (patch: Partial<ColumnDraft>) => void;
}): React.JSX.Element {
  const temporal = category === 'datetime' || category === 'date' || category === 'time';
  const values = category === 'enum' ? c.type.values.filter(Boolean) : null;
  return (
    <span className="default-picker">
      <select
        value={c.defaultMode}
        onChange={(e) => {
          const mode = e.target.value as DefaultMode;
          onChange({
            defaultMode: mode,
            defaultText:
              mode === 'expression' && temporal && !c.defaultText
                ? 'CURRENT_TIMESTAMP'
                : mode === 'value' && values?.length && !values.includes(c.defaultText)
                  ? (values[0] as string)
                  : c.defaultText,
          });
        }}
        title="What a new row gets when no value is given"
      >
        <option value="none">no default</option>
        {c.nullable && <option value="null">NULL</option>}
        <option value="value">value</option>
        <option value="expression">expression</option>
      </select>
      {c.defaultMode === 'value' &&
        (values ? (
          <select value={c.defaultText} onChange={(e) => onChange({ defaultText: e.target.value })}>
            {values.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={c.defaultText}
            placeholder="empty string"
            onChange={(e) => onChange({ defaultText: e.target.value })}
          />
        ))}
      {c.defaultMode === 'expression' && (
        <>
          <input
            value={c.defaultText}
            list="rasql-default-expressions"
            placeholder="CURRENT_TIMESTAMP"
            spellCheck={false}
            onChange={(e) => onChange({ defaultText: e.target.value })}
          />
          <datalist id="rasql-default-expressions">
            <option value="CURRENT_TIMESTAMP" />
            <option value="(UUID())" />
            <option value="(CURRENT_DATE)" />
          </datalist>
        </>
      )}
    </span>
  );
}

function ForeignKeys({
  sessionKey,
  schema,
  drafts,
  liveColumns,
  liveName,
  editable,
  onChange,
  onAdd,
  onRemoveNew,
}: {
  sessionKey: string;
  schema: string;
  drafts: ForeignKeyDraft[];
  liveColumns: string[];
  liveName: (original: string) => string;
  editable: boolean;
  onChange: (key: string, patch: Partial<ForeignKeyDraft>) => void;
  onAdd: () => void;
  onRemoveNew: (key: string) => void;
}): React.JSX.Element {
  const [tables, setTables] = useState<string[]>([]);
  const [targetColumns, setTargetColumns] = useState<Record<string, string[]>>({});
  const needsTables = editable && drafts.some((f) => !f.original);
  useEffect(() => {
    if (!needsTables || tables.length) return;
    rasql.session
      .listObjects(sessionKey, schema)
      .then((objs) => setTables(objs.filter((o) => o.kind === 'table').map((o) => o.name)))
      .catch(() => undefined);
  }, [needsTables, tables.length, sessionKey, schema]);
  const wanted = drafts
    .filter((f) => !f.original && f.referencedTable && !targetColumns[f.referencedTable])
    .map((f) => f.referencedTable);
  useEffect(() => {
    for (const t of new Set(wanted)) {
      rasql.session
        .describeTable(sessionKey, schema, t)
        .then((d) => setTargetColumns((m) => ({ ...m, [t]: d.columns.map((c) => c.name) })))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted.join('\u0000'), sessionKey, schema]);

  return (
    <>
      <h3>Foreign keys</h3>
      <table className="plain structure-fks">
        <thead>
          <tr>
            <th>Name</th>
            <th>Column</th>
            <th>References</th>
            <th>On delete</th>
            <th>On update</th>
            {editable && <th />}
          </tr>
        </thead>
        <tbody>
          {drafts.map((fk) => {
            if (fk.original) {
              return (
                <tr key={fk.key} className={fk.dropped ? 'dropped' : ''}>
                  <td>{fk.name}</td>
                  <td>{fk.columns.map(liveName).join(', ')}</td>
                  <td>
                    {fk.referencedTable} ({fk.referencedColumns.join(', ')})
                  </td>
                  <td>{fk.onDelete}</td>
                  <td>{fk.onUpdate}</td>
                  {editable && (
                    <td className="row-actions">
                      <button
                        onClick={() => onChange(fk.key, { dropped: !fk.dropped })}
                        title={fk.dropped ? 'Keep this foreign key' : 'Drop this foreign key'}
                      >
                        {fk.dropped ? '↺' : '✕'}
                      </button>
                    </td>
                  )}
                </tr>
              );
            }
            const target = targetColumns[fk.referencedTable] ?? [];
            return (
              <tr key={fk.key} className="added">
                <td>
                  <input
                    value={fk.name}
                    placeholder="automatic"
                    onChange={(e) => onChange(fk.key, { name: e.target.value })}
                  />
                </td>
                <td>
                  <select
                    value={fk.columns[0] ?? ''}
                    onChange={(e) => onChange(fk.key, { columns: [e.target.value] })}
                  >
                    <option value="">choose…</option>
                    {liveColumns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={fk.referencedTable}
                    onChange={(e) =>
                      onChange(fk.key, { referencedTable: e.target.value, referencedColumns: [''] })
                    }
                  >
                    <option value="">table…</option>
                    {tables.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>{' '}
                  <select
                    value={fk.referencedColumns[0] ?? ''}
                    disabled={!fk.referencedTable}
                    onChange={(e) => onChange(fk.key, { referencedColumns: [e.target.value] })}
                  >
                    <option value="">column…</option>
                    {target.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={fk.onDelete}
                    onChange={(e) => onChange(fk.key, { onDelete: e.target.value })}
                  >
                    {RULES.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={fk.onUpdate}
                    onChange={(e) => onChange(fk.key, { onUpdate: e.target.value })}
                  >
                    {RULES.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </td>
                <td className="row-actions">
                  <button onClick={() => onRemoveNew(fk.key)} title="Remove this new foreign key">
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
          {drafts.length === 0 && (
            <tr>
              <td colSpan={6} className="hint">
                No foreign keys.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {editable && (
        <button className="add-row" onClick={onAdd}>
          + Foreign key
        </button>
      )}
    </>
  );
}
