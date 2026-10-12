import { V, type Value, type ValueType } from '@rasql/driver-protocol';

/** The parts of tedious' column metadata the driver reads. */
export interface ColumnInfo {
  colName: string;
  type: { name: string };
  dataLength?: number | undefined;
  precision?: number | undefined;
  scale?: number | undefined;
  flags?: number;
  udtInfo?: { typeName: string } | undefined;
}

/** SQL Server's own name for a result column's type, with its size where it has one. */
export function nativeTypeOf(c: ColumnInfo): string {
  const len = c.dataLength ?? 0;
  const size = (chars: number): string =>
    len === 65535 || len === 0xffff || len < 0 ? 'max' : String(chars);
  switch (c.type.name) {
    case 'IntN':
      return { 1: 'tinyint', 2: 'smallint', 4: 'int', 8: 'bigint' }[len] ?? 'int';
    case 'TinyInt':
      return 'tinyint';
    case 'SmallInt':
      return 'smallint';
    case 'Int':
      return 'int';
    case 'BigInt':
      return 'bigint';
    case 'Bit':
    case 'BitN':
      return 'bit';
    case 'FloatN':
      return len === 4 ? 'real' : 'float';
    case 'Float':
      return 'float';
    case 'Real':
      return 'real';
    case 'MoneyN':
      return len === 4 ? 'smallmoney' : 'money';
    case 'Money':
      return 'money';
    case 'SmallMoney':
      return 'smallmoney';
    case 'Decimal':
    case 'DecimalN':
    case 'Numeric':
    case 'NumericN':
      return `${c.type.name.startsWith('Numeric') ? 'numeric' : 'decimal'}(${c.precision ?? 18},${c.scale ?? 0})`;
    case 'DateTimeN':
      return len === 4 ? 'smalldatetime' : 'datetime';
    case 'DateTime':
      return 'datetime';
    case 'SmallDateTime':
      return 'smalldatetime';
    case 'DateTime2':
      return `datetime2(${c.scale ?? 7})`;
    case 'DateTimeOffset':
      return `datetimeoffset(${c.scale ?? 7})`;
    case 'Time':
      return `time(${c.scale ?? 7})`;
    case 'Date':
      return 'date';
    case 'NVarChar':
      return `nvarchar(${size(len / 2)})`;
    case 'NChar':
      return `nchar(${len / 2})`;
    case 'VarChar':
      return `varchar(${size(len)})`;
    case 'Char':
      return `char(${len})`;
    case 'VarBinary':
      return `varbinary(${size(len)})`;
    case 'Binary':
      return `binary(${len})`;
    case 'UDT':
      return c.udtInfo?.typeName ?? 'udt';
    case 'Variant':
      return 'sql_variant';
    case 'UniqueIdentifier':
      return 'uniqueidentifier';
    default:
      return c.type.name.toLowerCase();
  }
}

/** The protocol type for a SQL Server type name, as nativeTypeOf or sys.types spell it. */
export function valueTypeOf(nativeType: string): ValueType {
  const base = nativeType.toLowerCase().replace(/\(.*$/, '').trim();
  switch (base) {
    case 'tinyint':
    case 'smallint':
    case 'int':
    case 'bigint':
      return 'int';
    case 'bit':
      return 'bool';
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
      return 'decimal';
    case 'float':
    case 'real':
      return 'float';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'datetime':
    case 'datetime2':
    case 'smalldatetime':
    case 'datetimeoffset':
      return 'datetime';
    case 'binary':
    case 'varbinary':
    case 'image':
    case 'timestamp':
    case 'rowversion':
      return 'bytes';
    case 'geography':
    case 'geometry':
      return 'geometry';
    case 'json':
      return 'json';
    default:
      return 'text';
  }
}

type TediousDate = Date & { nanosecondsDelta?: number };

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Fractional seconds of a tedious date at a given scale, from its milliseconds plus nanosecondsDelta. */
function fraction(d: TediousDate, scale: number): string {
  if (scale <= 0) return '';
  const ticks = d.getUTCMilliseconds() * 10_000 + Math.round((d.nanosecondsDelta ?? 0) * 1e7);
  return `.${pad(ticks, 7).slice(0, scale)}`;
}

const dateOf = (d: Date): string =>
  `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const timeOf = (d: TediousDate, scale: number): string =>
  `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${fraction(d, scale)}`;

/**
 * One cell, from what tedious made of it. The connection reads dates in UTC, so the wall-clock
 * fields come back unchanged; DATETIME2 and TIME keep their 100 ns digits through tedious'
 * nanosecondsDelta. DECIMAL and MONEY arrive as JavaScript numbers (tedious has no other
 * form), which is exact up to 15 significant digits; they are printed at the column's scale.
 */
export function toValue(raw: unknown, c: ColumnInfo): Value {
  if (raw === null || raw === undefined) return V.null();
  const native = nativeTypeOf(c);
  const base = native.replace(/\(.*$/, '');
  switch (valueTypeOf(native)) {
    case 'int':
      return V.int(typeof raw === 'number' ? Math.trunc(raw) : String(raw));
    case 'bool':
      return V.bool(raw === true || raw === 1);
    case 'decimal': {
      const scale = base === 'money' || base === 'smallmoney' ? 4 : (c.scale ?? 0);
      return V.decimal(typeof raw === 'number' ? raw.toFixed(scale) : String(raw));
    }
    case 'float':
      return V.float(Number(raw));
    case 'date':
      return raw instanceof Date ? V.date(dateOf(raw)) : V.date(String(raw));
    case 'time':
      return raw instanceof Date ? V.time(timeOf(raw, c.scale ?? 7)) : V.time(String(raw));
    case 'datetime': {
      if (!(raw instanceof Date)) return V.datetime(String(raw));
      const scale = base === 'datetime' ? 3 : base === 'smalldatetime' ? 0 : (c.scale ?? 7);
      const text = `${dateOf(raw)} ${timeOf(raw, scale)}`;
      // tedious drops the offset of DATETIMEOFFSET and gives the moment in UTC.
      return V.datetime(base === 'datetimeoffset' ? `${text} +00:00` : text);
    }
    case 'bytes':
      return V.bytes(Uint8Array.from(raw as Buffer));
    case 'geometry':
      return V.geometry(Uint8Array.from(raw as Buffer));
    case 'json':
      return V.json(String(raw));
    default:
      if (Buffer.isBuffer(raw)) return V.unknown(Uint8Array.from(raw), native);
      if (raw instanceof Date) return V.datetime(`${dateOf(raw)} ${timeOf(raw, 7)}`);
      return V.text(typeof raw === 'string' ? raw : String(raw));
  }
}
