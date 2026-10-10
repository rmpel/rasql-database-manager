import { describe, expect, it } from 'vitest';
import { formatSize, fromBase64, fromHex, hexDumpLines, toBase64, toHex } from './bytes';

describe('hex', () => {
  it('round-trips and groups', () => {
    const b = new Uint8Array([0, 1, 254, 255, 16]);
    expect(toHex(b)).toBe('0001feff10');
    expect(toHex(b, { groupEvery: 2 })).toBe('0001 feff 10');
    expect(fromHex('0001feff10')).toEqual(b);
    expect(fromHex('0x00 01\nFE ff 10')).toEqual(b);
  });

  it('rejects odd length and bad characters', () => {
    expect(() => fromHex('abc')).toThrow(/odd/);
    expect(() => fromHex('zz')).toThrow(/characters/);
    expect(fromHex('')).toEqual(new Uint8Array());
  });
});

describe('base64', () => {
  it('round-trips, tolerates whitespace and missing padding', () => {
    const b = new Uint8Array([104, 105, 0, 255]);
    expect(toBase64(b)).toBe('aGkA/w==');
    expect(fromBase64('aGkA/w==')).toEqual(b);
    expect(fromBase64('aGkA\n/w')).toEqual(b);
    expect(() => fromBase64('a*b')).toThrow();
  });

  it('survives a large blob', () => {
    const big = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4099) big[i] = i & 0xff;
    const out = fromBase64(toBase64(big));
    expect(out.length).toBe(big.length);
    expect(out[4099]).toBe(4099 & 0xff);
  });
});

describe('hexDumpLines', () => {
  it('formats offsets, hex columns and ascii, and truncates', () => {
    const b = new Uint8Array(20);
    for (let i = 0; i < 20; i++) b[i] = 0x41 + i;
    const dump = hexDumpLines(b, { bytesPerLine: 16 });
    expect(dump.lines).toHaveLength(2);
    expect(dump.lines[0]?.offset).toBe('00000000');
    expect(dump.lines[0]?.hex).toBe('41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50');
    expect(dump.lines[0]?.ascii).toBe('ABCDEFGHIJKLMNOP');
    expect(dump.lines[1]?.ascii).toBe('QRST');
    expect(dump.truncated).toBe(false);
    const limited = hexDumpLines(b, { bytesPerLine: 16, maxBytes: 16 });
    expect(limited.lines).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect(limited.total).toBe(20);
  });

  it('shows unprintable bytes as dots', () => {
    expect(hexDumpLines(new Uint8Array([0, 0x7f, 0x20, 0x7e])).lines[0]?.ascii).toBe('.. ~');
  });
});

describe('formatSize', () => {
  it('picks units', () => {
    expect(formatSize(12)).toBe('12 B');
    expect(formatSize(12_600)).toBe('12.3 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatSize(250 * 1024 * 1024)).toBe('250 MB');
  });
});
