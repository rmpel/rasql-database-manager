import { describe, expect, it } from 'vitest';
import { V, isValueType, tryDecodeText, valueEquals } from './values.js';

describe('Value constructors', () => {
  it('keeps 64-bit integers exact', () => {
    const big = 9223372036854775807n;
    expect(V.int(big)).toEqual({ t: 'int', v: '9223372036854775807' });
    expect(V.int('18446744073709551615')).toEqual({ t: 'int', v: '18446744073709551615' });
  });

  it('refuses a fractional number as int', () => {
    expect(() => V.int(1.5)).toThrow(TypeError);
  });

  it('omits optional fields when not given', () => {
    expect(V.text('a')).toEqual({ t: 'text', v: 'a' });
    expect(V.text('a', 'latin1')).toEqual({ t: 'text', v: 'a', charset: 'latin1' });
  });

  it('shares a single null value', () => {
    expect(V.null()).toBe(V.null());
  });
});

describe('valueEquals', () => {
  it('compares bytes by content', () => {
    expect(valueEquals(V.bytes(new Uint8Array([1, 2])), V.bytes(new Uint8Array([1, 2])))).toBe(
      true,
    );
    expect(valueEquals(V.bytes(new Uint8Array([1, 2])), V.bytes(new Uint8Array([1, 3])))).toBe(
      false,
    );
  });

  it('distinguishes types with the same payload', () => {
    expect(valueEquals(V.text('1'), V.int('1'))).toBe(false);
  });

  it('compares sets in order', () => {
    expect(valueEquals(V.set(['a', 'b']), V.set(['a', 'b']))).toBe(true);
    expect(valueEquals(V.set(['a', 'b']), V.set(['b', 'a']))).toBe(false);
  });
});

describe('tryDecodeText', () => {
  it('decodes valid utf-8', () => {
    expect(tryDecodeText(new TextEncoder().encode('héllo ☃'), 'utf-8')).toBe('héllo ☃');
  });

  it('returns undefined for invalid utf-8 instead of replacement characters', () => {
    expect(tryDecodeText(new Uint8Array([0xff, 0xfe, 0x41]), 'utf-8')).toBeUndefined();
  });

  it('returns undefined for an unknown charset', () => {
    expect(tryDecodeText(new Uint8Array([0x41]), 'no-such-charset')).toBeUndefined();
  });
});

describe('isValueType', () => {
  it('accepts known tags and rejects others', () => {
    expect(isValueType('int')).toBe(true);
    expect(isValueType('string')).toBe(false);
  });
});
