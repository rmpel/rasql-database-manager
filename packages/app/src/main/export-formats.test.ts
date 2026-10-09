import { describe, expect, it } from 'vitest';
import { V, type ColumnMeta } from '@rasql/driver-protocol';
import {
  bitsToBinary,
  csvCell,
  csvHeaderLine,
  csvQuote,
  csvRowLine,
  DEFAULT_CSV,
  jsonRow,
  jsonValue,
  sqlHeader,
} from './export-formats';

const col = (name: string): ColumnMeta => ({
  name,
  nativeType: 'X',
  valueType: 'text',
  nullable: true,
  isPrimaryKey: false,
});

describe('csv', () => {
  it('renders every value type', () => {
    expect(csvCell(V.null(), '')).toBe('');
    expect(csvCell(V.null(), 'NULL')).toBe('NULL');
    expect(csvCell(V.bool(true), '')).toBe('true');
    expect(csvCell(V.int('18446744073709551615'), '')).toBe('18446744073709551615');
    expect(csvCell(V.decimal('1.50'), '')).toBe('1.50');
    expect(csvCell(V.float(2.5), '')).toBe('2.5');
    expect(csvCell(V.text('héllo'), '')).toBe('héllo');
    expect(csvCell(V.date('2024-02-29'), '')).toBe('2024-02-29');
    expect(csvCell(V.time('-838:59:59'), '')).toBe('-838:59:59');
    expect(csvCell(V.datetime('2024-02-29 13:14:15.123456'), '')).toBe(
      '2024-02-29 13:14:15.123456',
    );
    expect(csvCell(V.json('{"a":1}'), '')).toBe('{"a":1}');
    expect(csvCell(V.enum('red'), '')).toBe('red');
    expect(csvCell(V.set(['a', 'b']), '')).toBe('a,b');
    expect(csvCell(V.bit(new Uint8Array([5]), 7), '')).toBe('0000101');
    expect(csvCell(V.bytes(new Uint8Array([0, 255])), '')).toBe('0x00ff');
    expect(csvCell(V.geometry(new Uint8Array([1])), '')).toBe('0x01');
    expect(csvCell(V.unknown(new Uint8Array([2]), 'WEIRD'), '')).toBe('0x02');
  });

  it('quotes per RFC 4180', () => {
    expect(csvQuote('plain', ',')).toBe('plain');
    expect(csvQuote('a,b', ',')).toBe('"a,b"');
    expect(csvQuote('a;b', ',')).toBe('a;b');
    expect(csvQuote('a;b', ';')).toBe('"a;b"');
    expect(csvQuote('say "hi"', ',')).toBe('"say ""hi"""');
    expect(csvQuote('line\nbreak', ',')).toBe('"line\nbreak"');
    expect(csvQuote('cr\rhere', ',')).toBe('"cr\rhere"');
  });

  it('writes header and rows with the chosen delimiter', () => {
    const cols = [col('id'), col('name,with comma')];
    expect(csvHeaderLine(cols, DEFAULT_CSV)).toBe('id,"name,with comma"\n');
    expect(csvRowLine([V.int(1), V.text('x')], { ...DEFAULT_CSV, delimiter: '\t' })).toBe('1\tx\n');
    expect(csvRowLine([V.null(), V.set(['a', 'b'])], DEFAULT_CSV)).toBe(',"a,b"\n');
  });
});

describe('json', () => {
  it('maps every value type', () => {
    expect(jsonValue(V.null())).toBeNull();
    expect(jsonValue(V.bool(false))).toBe(false);
    expect(jsonValue(V.int('42'))).toBe(42);
    expect(jsonValue(V.int('-9007199254740991'))).toBe(-9007199254740991);
    expect(jsonValue(V.int('9007199254740993'))).toBe('9007199254740993');
    expect(jsonValue(V.int('18446744073709551615'))).toBe('18446744073709551615');
    expect(jsonValue(V.decimal('1.50'))).toBe('1.50');
    expect(jsonValue(V.float(2.5))).toBe(2.5);
    expect(jsonValue(V.text('t'))).toBe('t');
    expect(jsonValue(V.json('{"a":[1,2]}'))).toEqual({ a: [1, 2] });
    expect(jsonValue(V.json('not json'))).toBe('not json');
    expect(jsonValue(V.date('2024-02-29'))).toBe('2024-02-29');
    expect(jsonValue(V.enum('x'))).toBe('x');
    expect(jsonValue(V.set(['a', 'b']))).toBe('a,b');
    expect(jsonValue(V.bit(new Uint8Array([3]), 2))).toBe('11');
    expect(jsonValue(V.bytes(new Uint8Array([0, 255, 1])))).toEqual({ $bytes: 'AP8B' });
    expect(jsonValue(V.geometry(new Uint8Array([1])))).toEqual({ $bytes: 'AQ==' });
    expect(jsonValue(V.unknown(new Uint8Array([1]), 'X'))).toEqual({ $bytes: 'AQ==' });
  });

  it('keys rows by column name and keeps duplicates apart', () => {
    expect(jsonRow([col('a'), col('a'), col('b')], [V.int(1), V.int(2), V.null()])).toEqual({
      a: 1,
      a_2: 2,
      b: null,
    });
  });
});

describe('sql header and bits', () => {
  it('comments the statement line by line', () => {
    const h = sqlHeader('SELECT *\nFROM t', new Date('2026-10-09T10:00:00Z'));
    expect(h).toBe('-- RaSQL export, 2026-10-09T10:00:00.000Z\n-- SELECT *\n-- FROM t\n\n');
  });

  it('renders bit fields with the declared width', () => {
    expect(bitsToBinary(new Uint8Array([1, 0]), 12)).toBe('000100000000');
    expect(bitsToBinary(new Uint8Array([255]), 0)).toBe('11111111');
  });
});
