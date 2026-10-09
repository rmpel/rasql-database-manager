import { describe, expect, it } from 'vitest';
import type { FieldPacket } from 'mysql2';
import { V } from '@rasql/driver-protocol';
import {
  FLAG,
  T,
  charsetFamily,
  dataTypeToValueType,
  fieldValueType,
  toParam,
  toValue,
} from './values.js';

function field(partial: Omit<Partial<FieldPacket>, 'constructor'>): FieldPacket {
  return {
    catalog: 'def',
    name: 'c',
    orgName: 'c',
    table: 't',
    orgTable: 't',
    decimals: 0,
    flags: 0,
    characterSet: 45,
    encoding: 'utf8',
    columnLength: 255,
    columnType: T.VAR_STRING,
    ...partial,
  } as unknown as FieldPacket;
}

const bytes = (s: string): Buffer => Buffer.from(s, 'latin1');

describe('toValue', () => {
  it('keeps integers of every width as strings', () => {
    expect(
      toValue(
        bytes('18446744073709551615'),
        field({ columnType: T.LONGLONG, flags: FLAG.UNSIGNED }),
      ),
    ).toEqual(V.int('18446744073709551615'));
    expect(toValue(bytes('-128'), field({ columnType: T.TINY, columnLength: 4 }))).toEqual(
      V.int('-128'),
    );
    expect(toValue(bytes('1'), field({ columnType: T.TINY, columnLength: 1 }))).toEqual(V.int('1'));
    expect(toValue(bytes('2024'), field({ columnType: T.YEAR }))).toEqual(V.int('2024'));
  });

  it('keeps decimals exact and parses floats', () => {
    expect(toValue(bytes('12345678901234.567891'), field({ columnType: T.NEWDECIMAL }))).toEqual(
      V.decimal('12345678901234.567891'),
    );
    expect(toValue(bytes('1.5'), field({ columnType: T.FLOAT }))).toEqual(V.float(1.5));
  });

  it('passes temporal values through untouched', () => {
    expect(toValue(bytes('0000-00-00'), field({ columnType: T.DATE }))).toEqual(
      V.date('0000-00-00'),
    );
    expect(toValue(bytes('-838:59:59'), field({ columnType: T.TIME }))).toEqual(
      V.time('-838:59:59'),
    );
    expect(toValue(bytes('2024-02-29 13:14:15.123456'), field({ columnType: T.DATETIME }))).toEqual(
      V.datetime('2024-02-29 13:14:15.123456'),
    );
  });

  it('decodes text in the column charset and tags it', () => {
    const utf8 = Buffer.from('héllo ☃ 🦈', 'utf8');
    expect(toValue(utf8, field({ characterSet: 224, encoding: 'utf8' }))).toEqual(
      V.text('héllo ☃ 🦈', 'utf8mb4'),
    );
    // utf8 bytes stored in a latin1 column: honest mojibake, tagged latin1
    const mess = Buffer.from('é', 'utf8');
    expect(toValue(mess, field({ characterSet: 8, encoding: 'latin1' }))).toEqual(
      V.text('Ã©', 'latin1'),
    );
  });

  it('turns undecodable bytes into bytes with a hint, never replacement characters', () => {
    const bad = Buffer.from([0xff, 0xfe, 0x41]);
    expect(toValue(bad, field({ characterSet: 45, encoding: 'utf8' }))).toEqual(
      V.bytes(new Uint8Array([0xff, 0xfe, 0x41]), 'utf8mb4'),
    );
    expect(toValue(bad, field({ characterSet: 63, encoding: 'binary' }))).toEqual(
      V.bytes(new Uint8Array([0xff, 0xfe, 0x41])),
    );
  });

  it('handles bit, enum, set, json, geometry and null', () => {
    expect(toValue(Buffer.from([0x55]), field({ columnType: T.BIT, columnLength: 7 }))).toEqual(
      V.bit(new Uint8Array([0x55]), 7),
    );
    expect(toValue(bytes('two'), field({ columnType: T.STRING, flags: FLAG.ENUM }))).toEqual(
      V.enum('two'),
    );
    expect(toValue(bytes('a,c'), field({ columnType: T.STRING, flags: FLAG.SET }))).toEqual(
      V.set(['a', 'c']),
    );
    expect(toValue(bytes(''), field({ columnType: T.STRING, flags: FLAG.SET }))).toEqual(V.set([]));
    expect(
      toValue(Buffer.from('{"a":1}'), field({ columnType: T.JSON, characterSet: 63 })),
    ).toEqual(V.json('{"a":1}'));
    expect(
      toValue(Buffer.from('{"a":1}'), field({ columnType: T.LONG_BLOB, extendedFormat: 'json' })),
    ).toEqual(V.json('{"a":1}'));
    const geo = Buffer.concat([Buffer.from([0xe6, 0x10, 0, 0]), Buffer.from([1, 1, 0, 0, 0])]);
    expect(toValue(geo, field({ columnType: T.GEOMETRY, characterSet: 63 }))).toEqual(
      V.geometry(new Uint8Array([1, 1, 0, 0, 0]), 4326),
    );
    expect(toValue(null, field({}))).toEqual(V.null());
  });

  it('returns copies, not views on mysql2 buffers', () => {
    const slab = Buffer.alloc(16, 7);
    const v = toValue(slab.subarray(2, 4), field({ characterSet: 63, columnType: T.BLOB }));
    expect(v.t === 'bytes' && v.v.buffer.byteLength).toBe(2);
  });
});

describe('fieldValueType and dataTypeToValueType', () => {
  it('agree with each other', () => {
    expect(fieldValueType(field({ columnType: T.LONGLONG }))).toBe('int');
    expect(fieldValueType(field({ columnType: T.BLOB, characterSet: 63 }))).toBe('bytes');
    expect(fieldValueType(field({ columnType: T.BLOB, characterSet: 45 }))).toBe('text');
    expect(fieldValueType(field({ columnType: T.STRING, flags: FLAG.SET }))).toBe('set');
    expect(dataTypeToValueType('bigint', 'bigint(20) unsigned')).toBe('int');
    expect(dataTypeToValueType('varchar', 'varchar(255)')).toBe('text');
    expect(dataTypeToValueType('varbinary', 'varbinary(16)')).toBe('bytes');
    expect(dataTypeToValueType('point')).toBe('geometry');
    expect(dataTypeToValueType('timestamp', 'timestamp(6)')).toBe('datetime');
  });
});

describe('charsetFamily', () => {
  it('names the charsets that matter', () => {
    expect(charsetFamily(63, 'binary')).toBe('binary');
    expect(charsetFamily(255, 'utf8')).toBe('utf8mb4');
    expect(charsetFamily(33, 'utf8')).toBe('utf8mb3');
    expect(charsetFamily(8, 'latin1')).toBe('latin1');
    expect(charsetFamily(51, 'cp1251')).toBe('cp1251');
  });
});

describe('toParam', () => {
  it('maps values to what mysql2 can format', () => {
    expect(toParam(V.int('9007199254740993'))).toBe(9007199254740993n);
    expect(toParam(V.null())).toBeNull();
    expect(toParam(V.bool(true))).toBe(1);
    expect(toParam(V.bytes(new Uint8Array([1])))).toEqual(Buffer.from([1]));
    expect((toParam(V.decimal('1.50')) as { toSqlString(): string }).toSqlString()).toBe('1.50');
    expect(
      (toParam(V.bit(new Uint8Array([5]), 3)) as { toSqlString(): string }).toSqlString(),
    ).toBe("b'101'");
    expect(toParam(V.set(['a', 'b']))).toBe('a,b');
  });
});
