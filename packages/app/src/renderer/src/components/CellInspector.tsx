import { useEffect, useMemo, useState } from 'react';
import { V, type ColumnMeta, type Value } from '@rasql/driver-protocol';
import { rasql } from '../api';
import { formatSize, hexDumpLines, toBase64, toHex } from '../lib/bytes';
import { detectBase64, detectBytes, type Detection } from '../lib/detect';
import { parseEditText } from '../lib/edit-values';

interface Props {
  /** Identifies the cell; the inspector resets its messages when it changes. */
  cellKey: string;
  column: ColumnMeta;
  value: Value;
  /** Staging is offered only for table rows; query results and views are read-only. */
  editable: boolean;
  onStage: (value: Value) => void;
  onClose: () => void;
}

const CHARSETS = ['utf-8', 'iso-8859-1', 'windows-1252', 'utf-16le', 'macintosh'];

/** Bytes of a string whose code points all fit in one byte, i.e. text decoded as latin1. */
function singleByteCodes(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 255) return null;
    out[i] = c;
  }
  return out;
}

function decode(bytes: Uint8Array, charset: string): string | null {
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The selected cell in full, with the operations that make sense for its type. The only place
 * where binary data is edited: replace from a file, or round-trip through an external editor.
 */
export function CellInspector({
  cellKey,
  column,
  value,
  editable,
  onStage,
  onClose,
}: Props): React.JSX.Element {
  const [message, setMessage] = useState<string | null>(null);
  // Reset the message when another cell is selected, during render rather than in an effect.
  const [prevKey, setPrevKey] = useState(cellKey);
  if (prevKey !== cellKey) {
    setPrevKey(cellKey);
    setMessage(null);
  }

  const body = (() => {
    switch (value.t) {
      case 'null':
        return <div className="inspector-null">NULL</div>;
      case 'bytes':
      case 'geometry':
      case 'unknown':
        return (
          <BytesView
            bytes={value.v}
            column={column}
            editable={editable}
            onStage={onStage}
            setMessage={setMessage}
          />
        );
      case 'bit':
        return <BitView value={value} editable={editable} onStage={onStage} />;
      case 'json':
        return (
          <TextView
            text={value.v}
            column={column}
            editable={editable}
            onStage={onStage}
            json
            setMessage={setMessage}
          />
        );
      case 'text':
        return (
          <TextView
            text={value.v}
            column={column}
            editable={editable}
            onStage={onStage}
            setMessage={setMessage}
          />
        );
      case 'set':
        return (
          <TextView
            text={value.v.join(',')}
            column={column}
            editable={editable}
            onStage={onStage}
            setMessage={setMessage}
          />
        );
      default:
        return (
          <TextView
            text={'v' in value ? String(value.v) : ''}
            column={column}
            editable={editable}
            onStage={onStage}
            setMessage={setMessage}
          />
        );
    }
  })();

  return (
    <aside className="inspector">
      <header className="inspector-header">
        <strong>{column.name}</strong>
        <span className="inspector-type">
          {column.nativeType || column.valueType}
          {column.charset ? ` · ${column.charset}` : ''}
        </span>
        <span className="spacer" />
        {editable && value.t !== 'null' && (
          <button onClick={() => onStage(V.null())} title="Stage NULL for this cell">
            Set NULL
          </button>
        )}
        <button onClick={onClose} title="Close the inspector (⌘I)">
          ×
        </button>
      </header>
      {message && <div className="inspector-message">{message}</div>}
      <div className="inspector-body">{body}</div>
    </aside>
  );
}

function BytesView({
  bytes,
  column,
  editable,
  onStage,
  setMessage,
}: {
  bytes: Uint8Array;
  column: ColumnMeta;
  editable: boolean;
  onStage: (v: Value) => void;
  setMessage: (m: string | null) => void;
}): React.JSX.Element {
  const detection = useMemo(() => detectBytes(bytes), [bytes]);
  const [externalPath, setExternalPath] = useState<string | null>(null);
  return (
    <>
      <div className="inspector-row">
        <span>
          {detection.label}, {formatSize(bytes.length)}
        </span>
        <span className="spacer" />
        <button onClick={() => void rasql.clipboard.writeText(toHex(bytes))}>Copy hex</button>
        <button onClick={() => void rasql.clipboard.writeText(toBase64(bytes))}>Copy base64</button>
        <button
          onClick={() => void rasql.cells.saveFile(bytes, `${column.name}.${detection.extension}`)}
        >
          Save…
        </button>
        <button
          onClick={() =>
            void rasql.cells.openExternally(bytes, detection.extension).then(({ path }) => {
              setExternalPath(path);
              setMessage(
                `Opened in an external application. Edit and save there, then press "Reload from file".`,
              );
            })
          }
        >
          Open externally
        </button>
        {editable && externalPath && (
          <button
            className="primary"
            onClick={() =>
              void rasql.cells.readFile(externalPath).then((data) => {
                onStage(V.bytes(data));
                setMessage(`Staged ${formatSize(data.length)} from the edited file.`);
              })
            }
          >
            Reload from file
          </button>
        )}
        {editable && <ReplaceFromFile column={column} onStage={onStage} setMessage={setMessage} />}
      </div>
      <Preview bytes={bytes} detection={detection} />
      <HexDump bytes={bytes} />
    </>
  );
}

function ReplaceFromFile({
  column,
  onStage,
  setMessage,
  asBase64 = false,
}: {
  column: ColumnMeta;
  onStage: (v: Value) => void;
  setMessage: (m: string | null) => void;
  asBase64?: boolean;
}): React.JSX.Element {
  return (
    <button
      className="primary"
      onClick={() =>
        void rasql.cells
          .pickFile({ title: `Replace ${column.name} with a file` })
          .then((picked) => {
            if (!picked) return;
            onStage(asBase64 ? V.text(toBase64(picked.bytes)) : V.bytes(picked.bytes));
            setMessage(
              `Staged ${picked.name} (${formatSize(picked.bytes.length)})${asBase64 ? ', base64-encoded' : ''}.`,
            );
          })
      }
    >
      Replace from file…
    </button>
  );
}

function Preview({
  bytes,
  detection,
}: {
  bytes: Uint8Array;
  detection: Detection;
}): React.JSX.Element | null {
  const url = useMemo(
    () =>
      detection.isImage
        ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: detection.mime }))
        : null,
    [bytes, detection],
  );
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  if (url) return <img className="inspector-image" src={url} alt={detection.label} />;
  if (detection.isText) {
    const text = new TextDecoder(detection.kind === 'utf16le-text' ? 'utf-16le' : 'utf-8').decode(
      bytes,
    );
    return (
      <pre className="inspector-text">{detection.kind === 'json' ? prettyJson(text) : text}</pre>
    );
  }
  return null;
}

function HexDump({ bytes }: { bytes: Uint8Array }): React.JSX.Element {
  const dump = useMemo(() => hexDumpLines(bytes), [bytes]);
  return (
    <pre className="inspector-hex">
      {dump.lines.map((l) => `${l.offset}  ${l.hex}  ${l.ascii}`).join('\n')}
      {dump.truncated
        ? `\n… ${formatSize(dump.total)} in total, showing the first ${formatSize(65536)}`
        : ''}
    </pre>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function TextView({
  text,
  column,
  editable,
  onStage,
  json = false,
  setMessage,
}: {
  text: string;
  column: ColumnMeta;
  editable: boolean;
  onStage: (v: Value) => void;
  json?: boolean;
  setMessage: (m: string | null) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(text);
  // Follow the stored text when it changes underneath us (refresh, staged edit), without an effect.
  const [prevText, setPrevText] = useState(text);
  if (prevText !== text) {
    setPrevText(text);
    setDraft(text);
  }
  const [pretty, setPretty] = useState(json);
  const base64 = useMemo(() => (json ? null : detectBase64(text)), [text, json]);
  const [showDecoded, setShowDecoded] = useState(false);
  const [charset, setCharset] = useState<string | null>(null);
  const reinterpreted = useMemo(() => {
    if (!charset) return null;
    const codes = singleByteCodes(text);
    return codes ? decode(codes, charset) : null;
  }, [text, charset]);

  const stage = (): void => {
    if (json) {
      try {
        JSON.parse(draft);
      } catch (err) {
        setMessage(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      onStage(V.json(draft));
      return;
    }
    const parsed = parseEditText(draft, column);
    if ('error' in parsed) {
      setMessage(parsed.error);
      return;
    }
    onStage(parsed.value);
  };

  const shown = pretty && json ? prettyJson(draft) : draft;
  return (
    <>
      <div className="inspector-row">
        <span>
          {json ? 'JSON' : 'Text'}, {text.length.toLocaleString()} characters
          {base64
            ? ` · looks like base64-encoded ${base64.detection.label} (${formatSize(base64.bytes.length)})`
            : ''}
        </span>
        <span className="spacer" />
        {json && (
          <button className={pretty ? 'active' : ''} onClick={() => setPretty((p) => !p)}>
            Pretty
          </button>
        )}
        {base64 && (
          <button className={showDecoded ? 'active' : ''} onClick={() => setShowDecoded((s) => !s)}>
            Decoded
          </button>
        )}
        {!json && !base64 && (
          <select
            value={charset ?? ''}
            onChange={(e) => setCharset(e.target.value || null)}
            title="Re-decode the stored bytes as another charset (for text stored in the wrong one)"
          >
            <option value="">Interpret as…</option>
            {CHARSETS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        {charset && reinterpreted !== null && editable && (
          <button className="primary" onClick={() => onStage(V.text(reinterpreted))}>
            Stage as {charset}
          </button>
        )}
        <button onClick={() => void rasql.clipboard.writeText(text)}>Copy</button>
        {editable && base64 && (
          <ReplaceFromFile column={column} onStage={onStage} setMessage={setMessage} asBase64 />
        )}
        {editable && !base64 && draft !== text && (
          <button className="primary" onClick={stage}>
            Stage
          </button>
        )}
      </div>
      {charset && (
        <pre className="inspector-text">
          {reinterpreted ?? `The stored bytes are not valid ${charset}.`}
        </pre>
      )}
      {showDecoded && base64 && (
        <>
          <Preview bytes={base64.bytes} detection={base64.detection} />
          <HexDump bytes={base64.bytes} />
        </>
      )}
      {!charset && !showDecoded && (
        <textarea
          className="inspector-editor"
          value={shown}
          readOnly={!editable}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
    </>
  );
}

function BitView({
  value,
  editable,
  onStage,
}: {
  value: Extract<Value, { t: 'bit' }>;
  editable: boolean;
  onStage: (v: Value) => void;
}): React.JSX.Element {
  // Most significant bit first, like the b'...' literal.
  const bits = useMemo(() => {
    const out: boolean[] = [];
    const total = value.v.length * 8;
    for (let i = total - value.bits; i < total; i++) {
      const byte = value.v[i >> 3] as number;
      out.push(((byte >> (7 - (i & 7))) & 1) === 1);
    }
    return out;
  }, [value]);
  const toggle = (index: number): void => {
    const next = bits.map((b, i) => (i === index ? !b : b));
    const bytes = new Uint8Array(Math.ceil(next.length / 8));
    const offset = bytes.length * 8 - next.length;
    next.forEach((b, i) => {
      if (b)
        bytes[(i + offset) >> 3] =
          (bytes[(i + offset) >> 3] as number) | (1 << (7 - ((i + offset) & 7)));
    });
    onStage(V.bit(bytes, value.bits));
  };
  return (
    <div className="inspector-bits">
      {bits.map((b, i) => (
        <label key={i} title={`bit ${bits.length - 1 - i}`}>
          <input type="checkbox" checked={b} disabled={!editable} onChange={() => toggle(i)} />
          {b ? 1 : 0}
        </label>
      ))}
    </div>
  );
}
