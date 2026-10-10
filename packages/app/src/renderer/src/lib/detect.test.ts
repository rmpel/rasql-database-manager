import { describe, expect, it } from 'vitest';
import { toBase64 } from './bytes';
import { detectBase64, detectBytes, looksPhpSerialized } from './detect';

const t = (s: string): Uint8Array => new TextEncoder().encode(s);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
]);

describe('detectBytes', () => {
  it('recognises binary formats by magic number', () => {
    expect(detectBytes(PNG)).toMatchObject({ kind: 'png', isImage: true, extension: 'png' });
    expect(detectBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])).kind).toBe('jpeg');
    expect(detectBytes(t('GIF89a\u0001\u0000')).kind).toBe('gif');
    expect(detectBytes(t('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')).kind).toBe('webp');
    expect(detectBytes(t('RIFF\u0000\u0000\u0000\u0000WAVEfmt ')).kind).not.toBe('webp');
    expect(detectBytes(new Uint8Array([0x42, 0x4d, ...new Array(20).fill(0)])).kind).toBe('bmp');
    expect(detectBytes(t('%PDF-1.7\n')).kind).toBe('pdf');
    expect(detectBytes(new Uint8Array([0x1f, 0x8b, 8, 0])).kind).toBe('gzip');
    expect(detectBytes(new Uint8Array([0x50, 0x4b, 3, 4, 0])).kind).toBe('zip');
  });

  it('classifies text', () => {
    expect(detectBytes(t('')).kind).toBe('empty');
    expect(detectBytes(t('héllo ☃')).kind).toBe('utf8-text');
    expect(detectBytes(t('{"a": [1, 2]}'))).toMatchObject({ kind: 'json', isText: true });
    expect(detectBytes(t('  [1,2,3]\n')).kind).toBe('json');
    expect(detectBytes(t('{not json')).kind).toBe('utf8-text');
    expect(detectBytes(t('a:1:{s:3:"key";s:5:"value";}')).kind).toBe('php-serialized');
    expect(detectBytes(t('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).kind).toBe('svg');
    expect(detectBytes(t('<?xml version="1.0"?>\n<svg></svg>')).kind).toBe('svg');
    expect(detectBytes(t('<?xml version="1.0"?><root/>')).kind).toBe('utf8-text');
  });

  it('spots UTF-16 LE by BOM and by pattern', () => {
    expect(detectBytes(new Uint8Array([0xff, 0xfe, 0x68, 0, 0x69, 0])).kind).toBe('utf16le-text');
    const pattern = new Uint8Array(20);
    for (let i = 0; i < 20; i += 2) pattern[i] = 0x41 + i / 2;
    expect(detectBytes(pattern).kind).toBe('utf16le-text');
  });

  it('falls back to binary for invalid UTF-8', () => {
    expect(detectBytes(new Uint8Array([0xff, 0x41, 0x42, 0x43]))).toMatchObject({
      kind: 'binary',
    });
    expect(detectBytes(new Uint8Array([0xc3, 0x28, 0x01, 0x02]))).toMatchObject({ kind: 'binary' });
  });
});

describe('looksPhpSerialized', () => {
  it('accepts the common shapes and rejects prose', () => {
    expect(looksPhpSerialized('N;')).toBe(true);
    expect(looksPhpSerialized('b:1;')).toBe(true);
    expect(looksPhpSerialized('i:42;')).toBe(true);
    expect(looksPhpSerialized('s:5:"hello";')).toBe(true);
    expect(looksPhpSerialized('O:8:"stdClass":1:{s:1:"a";i:1;}')).toBe(true);
    expect(looksPhpSerialized('a: list of things')).toBe(false);
    expect(looksPhpSerialized('serialized')).toBe(false);
  });
});

describe('detectBase64', () => {
  it('decodes real base64 payloads and reports what they contain', () => {
    const png = detectBase64(toBase64(PNG));
    expect(png?.detection.kind).toBe('png');
    expect(png?.bytes).toEqual(PNG);
    const json = detectBase64(toBase64(t('{"hello": "world", "n": 1}')));
    expect(json?.detection.kind).toBe('json');
  });

  it('accepts data URLs, even with binary content', () => {
    const r = detectBase64(`data:image/png;base64,${toBase64(PNG)}`);
    expect(r?.detection.kind).toBe('png');
    const bin = detectBase64(
      `data:application/octet-stream;base64,${toBase64(new Uint8Array([0xc3, 0x28, 1, 2]))}`,
    );
    expect(bin?.detection.kind).toBe('binary');
  });

  it('refuses ordinary words, short strings and random bytes that merely look like base64', () => {
    expect(detectBase64('test')).toBeNull();
    expect(detectBase64('testtesttesttest')).toBeNull();
    expect(detectBase64('hello world this is prose')).toBeNull();
    expect(detectBase64('abcd efgh ijkl mnop qrst uvwx')).toBeNull();
    expect(
      detectBase64(toBase64(new Uint8Array([0xc3, 0x28, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))),
    ).toBeNull();
  });
});
