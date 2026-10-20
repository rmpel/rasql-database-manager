import { tokenize, type Flavor, type Token } from './sql.js';

/**
 * Column types, reduced to what decides whether a change can lose data: the family, the
 * range or length, and the character set. Written for MySQL and MariaDB first (MCP.md
 * section 6); PostgreSQL and SQL Server names map onto the same families.
 */
export type TypeFamily =
  | 'int'
  | 'decimal'
  | 'float'
  | 'char'
  | 'text'
  | 'binary'
  | 'enum'
  | 'set'
  | 'date'
  | 'datetime'
  | 'time'
  | 'other';

export interface ColumnType {
  family: TypeFamily;
  /** Normalized type name, for same-type comparisons. */
  base: string;
  /** Integers: inclusive range as bigint. */
  min?: bigint;
  max?: bigint;
  /** Decimals: precision and scale. */
  precision?: number;
  scale?: number;
  /** Floats: 4 or 8 bytes. */
  floatBytes?: number;
  /** char: maximum characters. text and binary: maximum bytes. */
  length?: number;
  /** char lengths count characters; text and binary lengths count bytes. */
  lengthIn?: 'chars' | 'bytes';
  values?: string[];
  /** Fractional seconds for temporal types. */
  fsp?: number;
  /** The rest of the type text, for exact comparison of 'other' types. */
  raw: string;
}

const UNLIMITED = 2 ** 31 - 1;

const INT_BYTES: Record<string, number> = {
  TINYINT: 1,
  INT1: 1,
  SMALLINT: 2,
  INT2: 2,
  SMALLSERIAL: 2,
  MEDIUMINT: 3,
  INT3: 3,
  INT: 4,
  INTEGER: 4,
  INT4: 4,
  SERIAL: 4,
  BIGINT: 8,
  INT8: 8,
  BIGSERIAL: 8,
};

const TEXT_BYTES: Record<string, number> = {
  TINYTEXT: 255,
  TEXT: 65535,
  MEDIUMTEXT: 16777215,
  LONGTEXT: 4294967295,
  NTEXT: UNLIMITED,
  CLOB: UNLIMITED,
};

const BLOB_BYTES: Record<string, number> = {
  TINYBLOB: 255,
  BLOB: 65535,
  MEDIUMBLOB: 16777215,
  LONGBLOB: 4294967295,
  BYTEA: UNLIMITED,
  IMAGE: UNLIMITED,
};

function intRange(bytes: number, unsigned: boolean): { min: bigint; max: bigint } {
  const bits = BigInt(bytes * 8);
  if (unsigned) return { min: 0n, max: 2n ** bits - 1n };
  return { min: -(2n ** (bits - 1n)), max: 2n ** (bits - 1n) - 1n };
}

const MULTIWORD: [string[], string][] = [
  [['DOUBLE', 'PRECISION'], 'DOUBLE'],
  [['CHARACTER', 'VARYING'], 'VARCHAR'],
  [['CHAR', 'VARYING'], 'VARCHAR'],
  [['NATIONAL', 'CHARACTER', 'VARYING'], 'NVARCHAR'],
  [['NATIONAL', 'CHAR', 'VARYING'], 'NVARCHAR'],
  [['NATIONAL', 'CHARACTER'], 'NCHAR'],
  [['NATIONAL', 'CHAR'], 'NCHAR'],
  [['NATIONAL', 'VARCHAR'], 'NVARCHAR'],
  [['BINARY', 'VARYING'], 'VARBINARY'],
  [['BIT', 'VARYING'], 'VARBIT'],
  [['LONG', 'VARCHAR'], 'MEDIUMTEXT'],
  [['LONG', 'VARBINARY'], 'MEDIUMBLOB'],
  [['TIMESTAMP', 'WITH', 'TIME', 'ZONE'], 'TIMESTAMPTZ'],
  [['TIMESTAMP', 'WITHOUT', 'TIME', 'ZONE'], 'TIMESTAMP'],
  [['TIME', 'WITH', 'TIME', 'ZONE'], 'TIMETZ'],
  [['TIME', 'WITHOUT', 'TIME', 'ZONE'], 'TIME'],
];

/**
 * Parse a type as written in a column definition or reported by describeTable, such as
 * "int(11) unsigned", "character varying(50)", "decimal(10,2)" or "enum('a','b')".
 * Returns the type and the index of the first token after it.
 */
export function parseColumnType(
  tokens: Token[],
  flavor: Flavor,
  from = 0,
): { type: ColumnType; next: number } | null {
  let i = from;
  const first = tokens[i];
  if (!first || (first.kind !== 'word' && first.kind !== 'ident')) return null;
  let base = first.kind === 'ident' ? first.value.toUpperCase() : first.value;
  i++;
  for (const [words, name] of MULTIWORD) {
    if (words[0] !== base) continue;
    const rest = words.slice(1);
    if (rest.every((w, k) => tokens[i + k]?.kind === 'word' && tokens[i + k]?.value === w)) {
      base = name;
      i += rest.length;
      break;
    }
  }
  // Arguments in parentheses: numbers, MAX, or quoted enum values.
  const args: string[] = [];
  if (tokens[i]?.kind === 'punct' && tokens[i]?.value === '(') {
    i++;
    while (i < tokens.length && !(tokens[i]?.kind === 'punct' && tokens[i]?.value === ')')) {
      const t = tokens[i] as Token;
      if (t.kind === 'string') args.push(t.value.replace(/''/g, "'"));
      else if (t.kind === 'number' || t.kind === 'word')
        args.push(t.kind === 'word' ? t.value : t.text);
      i++;
    }
    i++;
  }
  // Timestamps written as timestamp(3) with time zone.
  if (
    (base === 'TIMESTAMP' || base === 'TIME') &&
    tokens[i]?.value === 'WITH' &&
    tokens[i + 1]?.value === 'TIME'
  ) {
    base = `${base}TZ`;
    i += 3;
  } else if ((base === 'TIMESTAMP' || base === 'TIME') && tokens[i]?.value === 'WITHOUT') {
    i += 3;
  }
  let unsigned = false;
  while (
    tokens[i]?.kind === 'word' &&
    ['UNSIGNED', 'SIGNED', 'ZEROFILL'].includes(tokens[i]?.value as string)
  ) {
    if (tokens[i]?.value !== 'SIGNED') unsigned = true;
    i++;
  }
  const num = (k: number): number | undefined => {
    const a = args[k];
    if (a === undefined) return undefined;
    if (a === 'MAX') return UNLIMITED;
    const n = Number(a);
    return Number.isFinite(n) ? n : undefined;
  };
  const raw = `${base}${args.length ? `(${args.join(',')})` : ''}${unsigned ? ' UNSIGNED' : ''}`;
  const type = describeBase(base, args, num, unsigned, flavor, raw);
  return { type, next: i };
}

function describeBase(
  base: string,
  args: string[],
  num: (k: number) => number | undefined,
  unsigned: boolean,
  flavor: Flavor,
  raw: string,
): ColumnType {
  if (base in INT_BYTES) {
    const bytes = INT_BYTES[base] as number;
    // SQL Server's TINYINT runs from 0 to 255.
    const range = intRange(bytes, unsigned || (flavor === 'mssql' && base === 'TINYINT'));
    return { family: 'int', base: `INT${bytes}`, ...range, raw };
  }
  if (base === 'BOOL' || base === 'BOOLEAN') {
    if (flavor === 'mysql') return { family: 'int', base: 'INT1', ...intRange(1, false), raw };
    return { family: 'other', base: 'BOOLEAN', raw };
  }
  if (base === 'BIT' && flavor === 'mssql')
    return { family: 'int', base: 'BIT', min: 0n, max: 1n, raw };
  if (['DECIMAL', 'NUMERIC', 'DEC', 'FIXED'].includes(base)) {
    // MySQL and SQL Server default to (10,0) and (18,0); PostgreSQL's bare NUMERIC is unbounded.
    if (flavor === 'postgres' && args.length === 0)
      return { family: 'decimal', base: 'DECIMAL', precision: 1000, scale: 500, raw };
    const precision = num(0) ?? (flavor === 'mssql' ? 18 : 10);
    const scale = num(1) ?? 0;
    return { family: 'decimal', base: 'DECIMAL', precision, scale, raw };
  }
  if (['FLOAT', 'REAL', 'DOUBLE', 'FLOAT4', 'FLOAT8'].includes(base)) {
    let bytes: number;
    if (base === 'DOUBLE' || base === 'FLOAT8') bytes = 8;
    else if (base === 'FLOAT4') bytes = 4;
    else if (base === 'REAL') bytes = flavor === 'mysql' ? 8 : 4;
    else {
      const p = num(0);
      if (p !== undefined) bytes = p <= 24 ? 4 : 8;
      else bytes = flavor === 'mysql' || flavor === 'sqlite' ? 4 : 8;
    }
    return { family: 'float', base: bytes === 8 ? 'DOUBLE' : 'FLOAT', floatBytes: bytes, raw };
  }
  if (['CHAR', 'CHARACTER', 'NCHAR', 'BPCHAR'].includes(base))
    return { family: 'char', base: 'CHAR', length: num(0) ?? 1, lengthIn: 'chars', raw };
  if (['VARCHAR', 'NVARCHAR', 'VARCHAR2', 'NVARCHAR2'].includes(base))
    return { family: 'char', base: 'VARCHAR', length: num(0) ?? UNLIMITED, lengthIn: 'chars', raw };
  if (base in TEXT_BYTES || base === 'TEXT') {
    // PostgreSQL TEXT is unbounded; MySQL's is 64 KB; SQL Server's legacy TEXT is unbounded.
    const bytes = flavor === 'mysql' ? (TEXT_BYTES[base] as number) : UNLIMITED;
    return { family: 'text', base: 'TEXT', length: bytes, lengthIn: 'bytes', raw };
  }
  if (base === 'BINARY')
    return { family: 'binary', base: 'BINARY', length: num(0) ?? 1, lengthIn: 'bytes', raw };
  if (base === 'VARBINARY')
    return {
      family: 'binary',
      base: 'VARBINARY',
      length: num(0) ?? UNLIMITED,
      lengthIn: 'bytes',
      raw,
    };
  if (base in BLOB_BYTES) {
    const bytes = flavor === 'mysql' ? (BLOB_BYTES[base] as number) : UNLIMITED;
    return { family: 'binary', base: 'BLOB', length: bytes, lengthIn: 'bytes', raw };
  }
  if (base === 'ENUM') return { family: 'enum', base, values: args, raw };
  if (base === 'SET') return { family: 'set', base, values: args, raw };
  if (base === 'DATE') return { family: 'date', base, raw };
  if (['DATETIME', 'DATETIME2', 'TIMESTAMP', 'SMALLDATETIME'].includes(base)) {
    const fsp = num(0) ?? (base === 'DATETIME2' ? 7 : flavor === 'postgres' ? 6 : 0);
    return {
      family: 'datetime',
      base: base === 'TIMESTAMP' && flavor === 'mysql' ? 'TIMESTAMP' : 'DATETIME',
      fsp,
      raw,
    };
  }
  if (base === 'TIME')
    return { family: 'time', base, fsp: num(0) ?? (flavor === 'postgres' ? 6 : 0), raw };
  return { family: 'other', base, raw };
}

/** Parse a type from a string such as describeTable's nativeType. */
export function parseTypeText(text: string, flavor: Flavor): ColumnType | null {
  return parseColumnType(tokenize(text, flavor), flavor)?.type ?? null;
}

/** Bytes per character for a character set, for comparing character lengths with byte limits. */
export function bytesPerChar(charset: string | undefined): number {
  const cs = (charset ?? '').toLowerCase();
  if (cs === 'latin1' || cs === 'ascii' || cs === 'binary' || cs.startsWith('cp125')) return 1;
  if (cs === 'utf8' || cs === 'utf8mb3' || cs === 'ucs2') return 3;
  return 4;
}

/** A condition on the column, true for every row whose value would not survive the change. */
export type LossCondition = (column: string) => string;

export type TypeChange =
  | { safety: 'safe'; reason: string }
  | { safety: 'check'; reason: string; condition: LossCondition }
  | { safety: 'destructive'; reason: string };

const pow10 = (n: number): string => (n <= 0 ? '1' : `1${'0'.repeat(n)}`);

function digits(n: bigint): number {
  return (n < 0n ? -n : n).toString().length;
}

/** SQL for a value's length per engine: characters or bytes. */
function lengthSql(flavor: Flavor, unit: 'chars' | 'bytes', column: string): string {
  if (flavor === 'mssql')
    return unit === 'chars' ? `LEN(${column} + N'.') - 1` : `DATALENGTH(${column})`;
  if (flavor === 'postgres')
    return unit === 'chars' ? `CHAR_LENGTH(${column})` : `OCTET_LENGTH(${column})`;
  if (flavor === 'sqlite')
    return unit === 'chars' ? `LENGTH(${column})` : `LENGTH(CAST(${column} AS BLOB))`;
  return unit === 'chars' ? `CHAR_LENGTH(${column})` : `LENGTH(${column})`;
}

/**
 * Whether changing a column from one type to another can lose data (MCP.md section 6):
 * safe by its shape, safe only if the data fits (with the condition that finds rows that do
 * not), or destructive.
 */
export function compareTypes(
  from: ColumnType,
  to: ColumnType,
  flavor: Flavor,
  charset?: string,
): TypeChange {
  const same = from.raw === to.raw;
  if (same) return { safety: 'safe', reason: 'the type does not change' };

  if (from.family === 'int' && to.family === 'int') {
    const fmin = from.min as bigint;
    const fmax = from.max as bigint;
    const tmin = to.min as bigint;
    const tmax = to.max as bigint;
    if (tmin <= fmin && tmax >= fmax)
      return { safety: 'safe', reason: `widens ${from.raw} to ${to.raw}` };
    return {
      safety: 'check',
      reason: `narrows ${from.raw} to ${to.raw}; every value must lie between ${tmin} and ${tmax}`,
      condition: (c) => `${c} < ${tmin} OR ${c} > ${tmax}`,
    };
  }
  if (from.family === 'int' && to.family === 'decimal') {
    const intDigits = (to.precision as number) - (to.scale as number);
    const fmax = from.max as bigint;
    const fmin = from.min as bigint;
    if (digits(fmax) <= intDigits && digits(fmin) <= intDigits)
      return { safety: 'safe', reason: `${to.raw} holds every ${from.raw} value` };
    return {
      safety: 'check',
      reason: `${to.raw} holds numbers below 10^${intDigits} only`,
      condition: (c) => `${c} >= ${pow10(intDigits)} OR ${c} <= -${pow10(intDigits)}`,
    };
  }
  if (from.family === 'decimal' && to.family === 'decimal') {
    const fp = from.precision as number;
    const fs = from.scale as number;
    const tp = to.precision as number;
    const ts = to.scale as number;
    if (ts >= fs && tp - ts >= fp - fs)
      return { safety: 'safe', reason: `widens ${from.raw} to ${to.raw}` };
    return {
      safety: 'check',
      reason: `narrows ${from.raw} to ${to.raw}; every value must fit`,
      condition: (c) => `ABS(${c}) >= ${pow10(tp - ts)} OR ${c} <> ROUND(${c}, ${ts})`,
    };
  }
  if (from.family === 'decimal' && to.family === 'int') {
    const tmin = to.min as bigint;
    const tmax = to.max as bigint;
    return {
      safety: 'check',
      reason: `${to.raw} holds whole numbers between ${tmin} and ${tmax} only`,
      condition: (c) => `${c} <> FLOOR(${c}) OR ${c} < ${tmin} OR ${c} > ${tmax}`,
    };
  }
  if (from.family === 'int' && to.family === 'float') {
    // A float holds integers exactly up to 2^24, a double up to 2^53.
    const exact = (to.floatBytes as number) === 8 ? 2n ** 53n : 2n ** 24n;
    if ((from.max as bigint) <= exact && (from.min as bigint) >= -exact)
      return { safety: 'safe', reason: `${to.raw} holds every ${from.raw} value exactly` };
    return {
      safety: 'destructive',
      reason: `${to.raw} cannot hold every ${from.raw} value exactly`,
    };
  }
  if (from.family === 'float' && to.family === 'float') {
    if ((to.floatBytes as number) >= (from.floatBytes as number))
      return { safety: 'safe', reason: `widens ${from.raw} to ${to.raw}` };
    return { safety: 'destructive', reason: `${to.raw} keeps fewer digits than ${from.raw}` };
  }

  const textual = (f: TypeFamily): boolean => f === 'char' || f === 'text';
  if (textual(from.family) && textual(to.family)) {
    const perChar = bytesPerChar(charset);
    const fromBytes =
      from.lengthIn === 'chars' ? (from.length as number) * perChar : (from.length as number);
    const fromChars = from.lengthIn === 'chars' ? (from.length as number) : (from.length as number);
    const toChars = to.lengthIn === 'chars' ? (to.length as number) : undefined;
    const toBytes = to.lengthIn === 'bytes' ? (to.length as number) : undefined;
    if (toChars !== undefined && toChars >= fromChars)
      return { safety: 'safe', reason: `${to.raw} is at least as long as ${from.raw}` };
    if (toBytes !== undefined && toBytes >= fromBytes)
      return { safety: 'safe', reason: `${to.raw} is at least as long as ${from.raw}` };
    const unit = toChars !== undefined ? 'chars' : 'bytes';
    const limit = (toChars ?? toBytes) as number;
    return {
      safety: 'check',
      reason: `${to.raw} holds ${limit} ${unit === 'chars' ? 'characters' : 'bytes'} at most`,
      condition: (c) => `${lengthSql(flavor, unit, c)} > ${limit}`,
    };
  }
  if (from.family === 'binary' && to.family === 'binary') {
    // BINARY(n) pads; going to or from it changes values even when they fit.
    if ((from.base === 'BINARY') !== (to.base === 'BINARY'))
      return { safety: 'destructive', reason: 'fixed-length BINARY pads values with zero bytes' };
    if ((to.length as number) >= (from.length as number))
      return { safety: 'safe', reason: `${to.raw} is at least as long as ${from.raw}` };
    const limit = to.length as number;
    return {
      safety: 'check',
      reason: `${to.raw} holds ${limit} bytes at most`,
      condition: (c) => `${lengthSql(flavor, 'bytes', c)} > ${limit}`,
    };
  }
  if ((from.family === 'enum' || from.family === 'set') && from.family === to.family) {
    const next = new Set(to.values);
    const removed = (from.values ?? []).filter((v) => !next.has(v));
    if (removed.length === 0) return { safety: 'safe', reason: `${to.raw} keeps every value` };
    if (from.family === 'set')
      return { safety: 'destructive', reason: `removes ${removed.join(', ')} from the SET` };
    const list = (to.values ?? []).map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
    return {
      safety: 'check',
      reason: `removes ${removed.map((v) => `'${v}'`).join(', ')} from the ENUM`,
      condition: (c) => (list ? `${c} NOT IN (${list})` : `${c} IS NOT NULL`),
    };
  }
  if (from.family === 'date' && to.family === 'datetime' && to.base === 'DATETIME')
    return { safety: 'safe', reason: `${to.raw} holds every date` };
  if (
    from.family === to.family &&
    (from.family === 'datetime' || from.family === 'time') &&
    from.base === to.base
  ) {
    if ((to.fsp ?? 0) >= (from.fsp ?? 0))
      return { safety: 'safe', reason: `${to.raw} keeps the precision` };
    return { safety: 'destructive', reason: `${to.raw} rounds fractional seconds` };
  }
  if (from.family === 'int' && textual(to.family)) {
    const need = Math.max(digits(from.max as bigint), digits(from.min as bigint) + 1);
    const room = to.lengthIn === 'chars' ? (to.length as number) : (to.length as number);
    if (room >= need)
      return { safety: 'safe', reason: `${to.raw} holds every ${from.raw} as text` };
  }
  return {
    safety: 'destructive',
    reason: `RaSQL cannot tell whether ${from.raw} to ${to.raw} keeps every value`,
  };
}

/** Whether converting text between character sets can lose characters. */
export function compareCharsets(from: string | undefined, to: string, flavor: Flavor): TypeChange {
  const a = (from ?? '').toLowerCase();
  const b = to.toLowerCase();
  if (a === b || (a === 'utf8' && b === 'utf8mb3') || (a === 'utf8mb3' && b === 'utf8'))
    return { safety: 'safe', reason: 'the character set does not change' };
  if (b === 'utf8mb4') return { safety: 'safe', reason: 'utf8mb4 holds every character' };
  if (flavor !== 'mysql' || !a)
    return { safety: 'destructive', reason: `RaSQL cannot check a conversion to ${to}` };
  return {
    safety: 'check',
    reason: `every value must convert from ${a} to ${b} without loss`,
    condition: (c) => `HEX(CONVERT(CONVERT(${c} USING ${b}) USING ${a})) <> HEX(${c})`,
  };
}
