import type { Value } from '@rasql/driver-protocol';

const hex = (b: Uint8Array, max = 16): string => {
  let s = '';
  const n = Math.min(b.length, max);
  for (let i = 0; i < n; i++) s += (b[i] as number).toString(16).padStart(2, '0');
  return b.length > max ? `${s}…` : s;
};

const truncate = (s: string, max = 200): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * The only place a Value becomes text (docs/GOAL.md principle 4). One renderer per type.
 * This is the Phase 0 version; the JSON and bytes inspectors come with the real grid.
 */
export function ValueCell({ value }: { value: Value }): React.JSX.Element {
  switch (value.t) {
    case 'null':
      return <span className="cell cell-null">NULL</span>;
    case 'bool':
      return <span className="cell cell-bool">{value.v ? 'true' : 'false'}</span>;
    case 'int':
    case 'decimal':
      return <span className="cell cell-number">{value.v}</span>;
    case 'float':
      return <span className="cell cell-number">{String(value.v)}</span>;
    case 'text':
      return (
        <span className="cell cell-text" title={value.charset}>
          {truncate(value.v)}
        </span>
      );
    case 'date':
    case 'time':
    case 'datetime':
      return <span className="cell cell-temporal">{value.v}</span>;
    case 'json':
      return <span className="cell cell-json">{truncate(value.v)}</span>;
    case 'enum':
      return <span className="cell cell-text">{value.v}</span>;
    case 'set':
      return <span className="cell cell-text">{value.v.join(', ')}</span>;
    case 'bit':
      return (
        <span className="cell cell-number">
          b&apos;
          {[...value.v]
            .map((b) => b.toString(2).padStart(8, '0'))
            .join('')
            .slice(-value.bits)}
          &apos;
        </span>
      );
    case 'bytes':
      return (
        <span
          className="cell cell-bytes"
          title={value.charsetHint ? `undecodable as ${value.charsetHint}` : undefined}
        >
          0x{hex(value.v)} <em>({value.v.length} B)</em>
        </span>
      );
    case 'geometry':
      return (
        <span className="cell cell-bytes">
          geometry{' '}
          <em>
            ({value.v.length} B{value.srid !== undefined ? `, SRID ${value.srid}` : ''})
          </em>
        </span>
      );
    case 'unknown':
      return (
        <span className="cell cell-bytes" title={value.nativeType}>
          {value.nativeType} <em>({value.v.length} B)</em>
        </span>
      );
  }
}
