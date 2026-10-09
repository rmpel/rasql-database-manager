import type { FieldPacket } from 'mysql2';
import { V, tryDecodeText, type Value, type ValueType } from '@rasql/driver-protocol';

/** MySQL protocol column types. Stable since forever; copied so we do not depend on mysql2 internals. */
export const T = {
  DECIMAL: 0x00,
  TINY: 0x01,
  SHORT: 0x02,
  LONG: 0x03,
  FLOAT: 0x04,
  DOUBLE: 0x05,
  NULL: 0x06,
  TIMESTAMP: 0x07,
  LONGLONG: 0x08,
  INT24: 0x09,
  DATE: 0x0a,
  TIME: 0x0b,
  DATETIME: 0x0c,
  YEAR: 0x0d,
  NEWDATE: 0x0e,
  VARCHAR: 0x0f,
  BIT: 0x10,
  VECTOR: 0xf2,
  JSON: 0xf5,
  NEWDECIMAL: 0xf6,
  ENUM: 0xf7,
  SET: 0xf8,
  TINY_BLOB: 0xf9,
  MEDIUM_BLOB: 0xfa,
  LONG_BLOB: 0xfb,
  BLOB: 0xfc,
  VAR_STRING: 0xfd,
  STRING: 0xfe,
  GEOMETRY: 0xff,
} as const;

export const FLAG = {
  NOT_NULL: 1,
  PRI_KEY: 2,
  UNIQUE_KEY: 4,
  MULTIPLE_KEY: 8,
  BLOB: 16,
  UNSIGNED: 32,
  ZEROFILL: 64,
  BINARY: 128,
  ENUM: 256,
  AUTO_INCREMENT: 512,
  TIMESTAMP: 1024,
  SET: 2048,
} as const;

export const BINARY_CHARSET = 63;

/** mysql2's iconv-style encoding names mapped to WHATWG TextDecoder labels. Missing means undecodable here. */
const ENCODING_TO_LABEL: Record<string, string> = {
  utf8: 'utf-8',
  cesu8: 'utf-8',
  ascii: 'utf-8',
  latin1: 'windows-1252', // MySQL latin1 is cp1252 West European
  latin2: 'iso-8859-2',
  latin5: 'iso-8859-9',
  latin7: 'iso-8859-13',
  greek: 'iso-8859-7',
  hebrew: 'iso-8859-8',
  cp1250: 'windows-1250',
  cp1251: 'windows-1251',
  cp1256: 'windows-1256',
  cp1257: 'windows-1257',
  cp866: 'ibm866',
  koi8r: 'koi8-r',
  koi8u: 'koi8-u',
  big5: 'big5',
  gbk: 'gbk',
  gb2312: 'gbk',
  gb18030: 'gb18030',
  sjis: 'shift_jis',
  cp932: 'shift_jis',
  eucjp: 'euc-jp',
  eucjpms: 'euc-jp',
  ujis: 'euc-jp',
  euckr: 'euc-kr',
  tis620: 'windows-874',
  ucs2: 'utf-16be',
  utf16: 'utf-16be',
  'utf16-le': 'utf-16le',
  utf16le: 'utf-16le',
  macintosh: 'macintosh',
  macroman: 'macintosh',
};

/** The MySQL charset family for a collation id, for the few that matter most; else mysql2's encoding name. */
export function charsetFamily(charsetNr: number | undefined, encoding: string | undefined): string {
  if (charsetNr === undefined) return encoding ?? 'unknown';
  if (charsetNr === BINARY_CHARSET) return 'binary';
  if (
    charsetNr === 45 ||
    charsetNr === 46 ||
    (charsetNr >= 224 && charsetNr <= 247) ||
    charsetNr >= 255
  )
    return 'utf8mb4';
  if (
    charsetNr === 33 ||
    charsetNr === 83 ||
    (charsetNr >= 192 && charsetNr <= 215) ||
    charsetNr === 223
  )
    return 'utf8mb3';
  if ([5, 8, 15, 31, 47, 48, 49, 94].includes(charsetNr)) return 'latin1';
  return encoding ?? `charset-${charsetNr}`;
}

function copy(buf: Uint8Array): Uint8Array {
  // Node Buffers are views on a shared slab; structured clone would copy the whole slab.
  return new Uint8Array(buf);
}

function ascii(buf: Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1');
}

function decodeText(buf: Uint8Array, field: FieldPacket): Value {
  const family = charsetFamily(field.characterSet, field.encoding);
  const label = field.encoding ? ENCODING_TO_LABEL[field.encoding] : undefined;
  if (!label) return V.bytes(copy(buf), family);
  const text = tryDecodeText(buf, label);
  if (text === undefined) return V.bytes(copy(buf), family);
  return V.text(text, family);
}

const INTEGER_TYPES = new Set<number>([T.TINY, T.SHORT, T.LONG, T.LONGLONG, T.INT24, T.YEAR]);

/** The protocol value type a result column will produce, from its metadata. */
export function fieldValueType(field: FieldPacket): ValueType {
  const type = field.columnType ?? field.type ?? T.VAR_STRING;
  const flags = typeof field.flags === 'number' ? field.flags : 0;
  if (field.extendedFormat === 'json') return 'json';
  if (INTEGER_TYPES.has(type)) return 'int';
  switch (type) {
    case T.DECIMAL:
    case T.NEWDECIMAL:
      return 'decimal';
    case T.FLOAT:
    case T.DOUBLE:
      return 'float';
    case T.NULL:
      return 'null';
    case T.DATE:
    case T.NEWDATE:
      return 'date';
    case T.TIME:
      return 'time';
    case T.DATETIME:
    case T.TIMESTAMP:
      return 'datetime';
    case T.BIT:
      return 'bit';
    case T.JSON:
      return 'json';
    case T.ENUM:
      return 'enum';
    case T.SET:
      return 'set';
    case T.GEOMETRY:
      return 'geometry';
    case T.VECTOR:
      return 'unknown';
    default:
      if (flags & FLAG.ENUM) return 'enum';
      if (flags & FLAG.SET) return 'set';
      return field.characterSet === BINARY_CHARSET ? 'bytes' : 'text';
  }
}

/**
 * Convert one raw text-protocol cell into a typed Value. `raw` is exactly what the server
 * sent, because the connection runs with typeCast disabled and character_set_results = NULL.
 */
export function toValue(raw: Uint8Array | null | undefined, field: FieldPacket): Value {
  if (raw === null || raw === undefined) return V.null();
  const type = field.columnType ?? field.type ?? T.VAR_STRING;
  const flags = typeof field.flags === 'number' ? field.flags : 0;

  if (field.extendedFormat === 'json') return V.json(Buffer.from(raw).toString('utf8'));
  if (INTEGER_TYPES.has(type)) return V.int(ascii(raw));

  switch (type) {
    case T.DECIMAL:
    case T.NEWDECIMAL:
      return V.decimal(ascii(raw));
    case T.FLOAT:
    case T.DOUBLE: {
      const n = Number(ascii(raw));
      return Number.isNaN(n) ? V.text(ascii(raw)) : V.float(n);
    }
    case T.NULL:
      return V.null();
    case T.DATE:
    case T.NEWDATE:
      return V.date(ascii(raw));
    case T.TIME:
      return V.time(ascii(raw));
    case T.DATETIME:
    case T.TIMESTAMP:
      return V.datetime(ascii(raw));
    case T.BIT:
      return V.bit(copy(raw), field.columnLength ?? raw.byteLength * 8);
    case T.JSON:
      return V.json(Buffer.from(raw).toString('utf8'));
    case T.GEOMETRY: {
      // MySQL internal format: 4-byte little-endian SRID followed by WKB.
      if (raw.byteLength >= 4) {
        const srid = Buffer.from(raw.buffer, raw.byteOffset, 4).readUInt32LE(0);
        return V.geometry(copy(raw.subarray(4)), srid);
      }
      return V.geometry(copy(raw));
    }
    case T.VECTOR:
      return V.unknown(copy(raw), 'VECTOR');
    default: {
      if (flags & FLAG.ENUM) {
        const v = decodeText(raw, field);
        return v.t === 'text' ? V.enum(v.v) : v;
      }
      if (flags & FLAG.SET) {
        const v = decodeText(raw, field);
        return v.t === 'text' ? V.set(v.v === '' ? [] : v.v.split(',')) : v;
      }
      if (field.characterSet === BINARY_CHARSET) return V.bytes(copy(raw));
      return decodeText(raw, field);
    }
  }
}

/** Map an information_schema DATA_TYPE / COLUMN_TYPE pair to a protocol value type. */
export function dataTypeToValueType(dataType: string, columnType = ''): ValueType {
  const t = dataType.toLowerCase();
  const ct = columnType.toLowerCase();
  switch (t) {
    case 'tinyint':
    case 'smallint':
    case 'mediumint':
    case 'int':
    case 'integer':
    case 'bigint':
    case 'year':
      return 'int';
    case 'decimal':
    case 'numeric':
    case 'dec':
    case 'fixed':
      return 'decimal';
    case 'float':
    case 'double':
    case 'real':
      return 'float';
    case 'bit':
      return 'bit';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'datetime':
    case 'timestamp':
      return 'datetime';
    case 'json':
      return 'json';
    case 'enum':
      return 'enum';
    case 'set':
      return 'set';
    case 'binary':
    case 'varbinary':
    case 'tinyblob':
    case 'blob':
    case 'mediumblob':
    case 'longblob':
      return 'bytes';
    case 'char':
    case 'varchar':
    case 'tinytext':
    case 'text':
    case 'mediumtext':
    case 'longtext':
      return ct.includes('binary') ? 'bytes' : 'text';
    case 'geometry':
    case 'point':
    case 'linestring':
    case 'polygon':
    case 'multipoint':
    case 'multilinestring':
    case 'multipolygon':
    case 'geometrycollection':
    case 'geomcollection':
      return 'geometry';
    case 'vector':
      return 'unknown';
    default:
      return 'text';
  }
}

/** Something mysql2 can escape into a statement. */
export type MysqlParam = null | number | bigint | string | Buffer | { toSqlString(): string };

const raw = (sql: string): { toSqlString(): string } => ({ toSqlString: () => sql });
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Convert a Value into a bound parameter for mysql2's client-side formatter. */
export function toParam(v: Value): MysqlParam {
  switch (v.t) {
    case 'null':
      return null;
    case 'bool':
      return v.v ? 1 : 0;
    case 'int':
      return /^-?\d+$/.test(v.v) ? BigInt(v.v) : v.v;
    case 'decimal':
      return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.v) ? raw(v.v) : v.v;
    case 'float':
      return Number.isFinite(v.v) ? v.v : null;
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
    case 'json':
    case 'enum':
      return v.v;
    case 'set':
      return v.v.join(',');
    case 'bytes':
    case 'unknown':
      return Buffer.from(v.v);
    case 'bit':
      return raw(
        `b'${Array.from(v.v, (x) => x.toString(2).padStart(8, '0'))
          .join('')
          .slice(-v.bits)}'`,
      );
    case 'geometry':
      return raw(`ST_GeomFromWKB(X'${hex(v.v)}'${v.srid === undefined ? '' : `, ${v.srid}`})`);
  }
}
