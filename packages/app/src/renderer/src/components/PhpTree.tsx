import { useState } from 'react';
import {
  phpTypeLabel,
  type PhpKey,
  type PhpProperty,
  type PhpValue,
  type PhpVisibility,
} from '../lib/php-serialize';

interface Props {
  value: PhpValue;
  editable: boolean;
  onChange: (next: PhpValue) => void;
}

type Path = (number | string)[];

const SCALAR_TYPES = ['string', 'int', 'float', 'bool', 'null'] as const;
type ScalarType = (typeof SCALAR_TYPES)[number];

/** A fresh value of a type, used when adding entries or converting a scalar. */
function defaultOf(type: ScalarType | 'array' | 'object', from?: PhpValue): PhpValue {
  const text = from && 'v' in from && typeof from.v !== 'boolean' ? String(from.v) : '';
  switch (type) {
    case 'string':
      return { t: 'string', v: text };
    case 'int':
      return { t: 'int', v: /^-?\d+$/.test(text) ? text : '0' };
    case 'float':
      return { t: 'float', v: /^-?\d+(\.\d+)?$/.test(text) ? text : '0' };
    case 'bool':
      return { t: 'bool', v: from?.t === 'bool' ? from.v : text === '1' || text === 'true' };
    case 'null':
      return { t: 'null' };
    case 'array':
      return { t: 'array', entries: [] };
    case 'object':
      return { t: 'object', class: 'stdClass', props: [] };
  }
}

/** Immutable update of the node at `path` (entry indexes for arrays and objects). */
function updateAt(root: PhpValue, path: Path, fn: (node: PhpValue) => PhpValue): PhpValue {
  if (path.length === 0) return fn(root);
  const [head, ...rest] = path;
  if (root.t === 'array') {
    return {
      ...root,
      entries: root.entries.map((e, i) =>
        i === head ? { ...e, value: updateAt(e.value, rest, fn) } : e,
      ),
    };
  }
  if (root.t === 'object') {
    return {
      ...root,
      props: root.props.map((p, i) =>
        i === head ? { ...p, value: updateAt(p.value, rest, fn) } : p,
      ),
    };
  }
  return root;
}

/**
 * The editor for PHP-serialized data. Every PHP notion stays visible and editable: key types,
 * class names, property visibility, scalar types. References and custom-serialized classes are
 * shown but not edited; they serialize back verbatim.
 */
export function PhpTree({ value, editable, onChange }: Props): React.JSX.Element {
  return (
    <div className="php-tree">
      <Node
        value={value}
        path={[]}
        editable={editable}
        update={(path, fn) => onChange(updateAt(value, path, fn))}
      />
    </div>
  );
}

interface NodeProps {
  value: PhpValue;
  path: Path;
  editable: boolean;
  update: (path: Path, fn: (node: PhpValue) => PhpValue) => void;
  /** Rendered by the parent: key or property header. */
  label?: React.ReactNode;
  onRemove?: () => void;
}

function Node({ value, path, editable, update, label, onRemove }: NodeProps): React.JSX.Element {
  const [open, setOpen] = useState(path.length < 2);
  const container = value.t === 'array' || value.t === 'object';
  const set = (fn: (node: PhpValue) => PhpValue): void => update(path, fn);

  return (
    <div className="php-node">
      <div className="php-row">
        {container ? (
          <button className="php-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="php-toggle" />
        )}
        {label}
        <span className={`php-type php-type-${value.t}`}>
          {value.t === 'object' ? 'object' : phpTypeLabel(value)}
        </span>
        <Scalar value={value} editable={editable} set={set} />
        {value.t === 'object' && (
          <input
            className="php-class"
            value={value.class}
            readOnly={!editable}
            title="Class name"
            onChange={(e) => set((n) => (n.t === 'object' ? { ...n, class: e.target.value } : n))}
          />
        )}
        {editable &&
          !container &&
          value.t !== 'ref' &&
          value.t !== 'custom' &&
          value.t !== 'enum' && (
            <select
              className="php-retype"
              value={value.t}
              title="Change the type"
              onChange={(e) => set((n) => defaultOf(e.target.value as ScalarType, n))}
            >
              {SCALAR_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        {editable && onRemove && (
          <button className="php-remove" title="Remove" onClick={onRemove}>
            ×
          </button>
        )}
      </div>
      {container && open && (
        <div className="php-children">
          {value.t === 'array' &&
            value.entries.map((e, i) => (
              <Node
                key={i}
                value={e.value}
                path={[...path, i]}
                editable={editable}
                update={update}
                label={
                  <KeyLabel
                    k={e.key}
                    editable={editable}
                    onChange={(k) =>
                      set((n) =>
                        n.t === 'array'
                          ? {
                              ...n,
                              entries: n.entries.map((x, j) => (j === i ? { ...x, key: k } : x)),
                            }
                          : n,
                      )
                    }
                  />
                }
                onRemove={() =>
                  set((n) =>
                    n.t === 'array' ? { ...n, entries: n.entries.filter((_, j) => j !== i) } : n,
                  )
                }
              />
            ))}
          {value.t === 'object' &&
            value.props.map((p, i) => (
              <Node
                key={i}
                value={p.value}
                path={[...path, i]}
                editable={editable}
                update={update}
                label={
                  <PropLabel
                    p={p}
                    editable={editable}
                    onChange={(np) =>
                      set((n) =>
                        n.t === 'object'
                          ? {
                              ...n,
                              props: n.props.map((x, j) =>
                                j === i ? { ...np, value: x.value } : x,
                              ),
                            }
                          : n,
                      )
                    }
                  />
                }
                onRemove={() =>
                  set((n) =>
                    n.t === 'object' ? { ...n, props: n.props.filter((_, j) => j !== i) } : n,
                  )
                }
              />
            ))}
          {editable && <AddEntry kind={value.t} set={set} />}
        </div>
      )}
    </div>
  );
}

function Scalar({
  value,
  editable,
  set,
}: {
  value: PhpValue;
  editable: boolean;
  set: (fn: (n: PhpValue) => PhpValue) => void;
}): React.JSX.Element | null {
  switch (value.t) {
    case 'string':
      return (
        <input
          className="php-value php-string"
          value={value.v}
          readOnly={!editable}
          title={value.binary ? 'Not valid UTF-8; shown as latin1, bytes kept' : undefined}
          onChange={(e) => set(() => ({ t: 'string', v: e.target.value }))}
        />
      );
    case 'int':
    case 'float':
      return (
        <input
          className="php-value php-number"
          value={value.v}
          readOnly={!editable}
          onChange={(e) => set((n) => ({ ...n, v: e.target.value }) as PhpValue)}
        />
      );
    case 'bool':
      return (
        <select
          className="php-value"
          value={value.v ? '1' : '0'}
          disabled={!editable}
          onChange={(e) => set(() => ({ t: 'bool', v: e.target.value === '1' }))}
        >
          <option value="1">true</option>
          <option value="0">false</option>
        </select>
      );
    case 'null':
      return <span className="php-value php-null">NULL</span>;
    case 'enum':
      return (
        <span className="php-value">
          {value.class}::{value.case}
        </span>
      );
    case 'ref':
      return (
        <span className="php-value php-muted">
          {value.kind}:{value.index} (reference)
        </span>
      );
    case 'custom':
      return (
        <span className="php-value php-muted">
          {value.data.length} bytes of custom serialization
        </span>
      );
    default:
      return null;
  }
}

function KeyLabel({
  k,
  editable,
  onChange,
}: {
  k: PhpKey;
  editable: boolean;
  onChange: (k: PhpKey) => void;
}): React.JSX.Element {
  return (
    <span className="php-key">
      <select
        className="php-key-type"
        value={k.t}
        disabled={!editable}
        title="Key type"
        onChange={(e) =>
          onChange(
            e.target.value === 'int'
              ? { t: 'int', v: /^-?\d+$/.test(k.v) ? k.v : '0' }
              : { t: 'string', v: k.v },
          )
        }
      >
        <option value="int">int</option>
        <option value="string">str</option>
      </select>
      <input
        value={k.v}
        readOnly={!editable}
        onChange={(e) => onChange({ ...k, v: e.target.value })}
      />
    </span>
  );
}

function PropLabel({
  p,
  editable,
  onChange,
}: {
  p: PhpProperty;
  editable: boolean;
  onChange: (p: PhpProperty) => void;
}): React.JSX.Element {
  const setVisibility = (visibility: PhpVisibility): void => {
    const next: PhpProperty = { ...p, visibility };
    if (visibility !== 'private') delete next.declaringClass;
    onChange(next);
  };
  return (
    <span className="php-key">
      <select
        className="php-key-type"
        value={p.visibility}
        disabled={!editable}
        title="Visibility"
        onChange={(e) => setVisibility(e.target.value as PhpVisibility)}
      >
        <option value="public">public</option>
        <option value="protected">protected</option>
        <option value="private">private</option>
      </select>
      {p.visibility === 'private' && (
        <input
          className="php-declaring"
          value={p.declaringClass ?? ''}
          readOnly={!editable}
          title="Declaring class"
          onChange={(e) => onChange({ ...p, declaringClass: e.target.value })}
        />
      )}
      <input
        value={p.name}
        readOnly={!editable}
        onChange={(e) => onChange({ ...p, name: e.target.value })}
      />
    </span>
  );
}

function AddEntry({
  kind,
  set,
}: {
  kind: 'array' | 'object';
  set: (fn: (n: PhpValue) => PhpValue) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [type, setType] = useState<ScalarType | 'array' | 'object'>('string');
  const add = (): void => {
    const value = defaultOf(type);
    set((n) => {
      if (n.t === 'array') {
        const key: PhpKey = /^-?\d+$/.test(name)
          ? { t: 'int', v: name }
          : { t: 'string', v: name || String(n.entries.length) };
        return { ...n, entries: [...n.entries, { key, value }] };
      }
      if (n.t === 'object')
        return { ...n, props: [...n.props, { name: name || 'prop', visibility: 'public', value }] };
      return n;
    });
    setName('');
  };
  return (
    <div className="php-row php-add">
      <span className="php-toggle" />
      <input
        placeholder={kind === 'array' ? 'key' : 'property'}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
      <select
        value={type}
        onChange={(e) => setType(e.target.value as ScalarType | 'array' | 'object')}
      >
        {[...SCALAR_TYPES, 'array', 'object'].map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button onClick={add}>+ Add</button>
    </div>
  );
}
