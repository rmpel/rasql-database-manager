import { describe, expect, it } from 'vitest';
import {
  PhpSerializeError,
  isPhpSerialized,
  parsePhpSerialized,
  phpTypeLabel,
  serializePhp,
  serializePhpBytes,
  toAnnotatedJson,
  tryParsePhpSerialized,
  type PhpValue,
} from './php-serialize';

// Literal serialized strings as PHP writes them. Lengths are byte counts.
const CORPUS: Record<string, string> = {
  wordpressOptions:
    'a:5:{s:4:"name";s:5:"Hello";s:5:"count";i:42;s:5:"ratio";d:0.5;s:3:"big";d:1.0E+25;s:5:"items";a:3:{i:0;b:1;i:1;N;s:2:"x1";a:0:{}}}',
  objectVisibility:
    'O:3:"Foo":3:{s:3:"pub";i:1;s:6:"\u0000*\u0000pro";b:1;s:8:"\u0000Foo\u0000pri";N;}',
  nestedObjectsInArray:
    'a:2:{i:0;O:8:"stdClass":1:{s:1:"a";i:1;}s:3:"key";O:8:"stdClass":1:{s:1:"b";a:1:{i:0;O:8:"stdClass":0:{}}}}',
  enumeration: 'E:11:"Suit:Hearts";',
  custom: 'C:3:"Bar":5:{hello}',
  references: 'a:3:{i:0;O:8:"stdClass":0:{}i:1;r:2;i:2;R:2;}',
  awkwardString: 's:7:"a";b}\u0000c";',
  multibyte: 's:10:"héllo ☃";',
  bigInt: 'i:9223372036854775807;',
  negativeInt: 'i:-17;',
  emptyArray: 'a:0:{}',
  emptyString: 's:0:"";',
  infinity: 'd:INF;',
  negativeInfinity: 'd:-INF;',
  notANumber: 'd:NAN;',
  nullValue: 'N;',
  falseValue: 'b:0;',
};

describe('php-serialize round trips', () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    it(`round-trips ${name} byte-exact`, () => {
      const parsed = parsePhpSerialized(text);
      expect(serializePhp(parsed)).toBe(text);
      expect(serializePhpBytes(parsed)).toEqual(new TextEncoder().encode(text));
    });
  }

  it('parses the WordPress-style options array into the typed model', () => {
    const v = parsePhpSerialized(CORPUS['wordpressOptions'] as string);
    expect(v.t).toBe('array');
    if (v.t !== 'array') return;
    expect(v.entries.map((e) => e.key)).toEqual([
      { t: 'string', v: 'name' },
      { t: 'string', v: 'count' },
      { t: 'string', v: 'ratio' },
      { t: 'string', v: 'big' },
      { t: 'string', v: 'items' },
    ]);
    expect(v.entries[1]?.value).toEqual({ t: 'int', v: '42' });
    expect(v.entries[2]?.value).toEqual({ t: 'float', v: '0.5' });
    expect(v.entries[3]?.value).toEqual({ t: 'float', v: '1.0E+25' });
    const items = v.entries[4]?.value;
    expect(items?.t).toBe('array');
    if (items?.t !== 'array') return;
    expect(items.entries[0]).toEqual({ key: { t: 'int', v: '0' }, value: { t: 'bool', v: true } });
    expect(items.entries[1]).toEqual({ key: { t: 'int', v: '1' }, value: { t: 'null' } });
    expect(items.entries[2]).toEqual({
      key: { t: 'string', v: 'x1' },
      value: { t: 'array', entries: [] },
    });
  });

  it('decodes property visibility and the declaring class', () => {
    const v = parsePhpSerialized(CORPUS['objectVisibility'] as string);
    expect(v).toEqual({
      t: 'object',
      class: 'Foo',
      props: [
        { name: 'pub', visibility: 'public', value: { t: 'int', v: '1' } },
        { name: 'pro', visibility: 'protected', value: { t: 'bool', v: true } },
        { name: 'pri', visibility: 'private', declaringClass: 'Foo', value: { t: 'null' } },
      ],
    });
  });

  it('keeps enum, custom payload and references verbatim', () => {
    expect(parsePhpSerialized(CORPUS['enumeration'] as string)).toEqual({
      t: 'enum',
      class: 'Suit',
      case: 'Hearts',
    });
    const custom = parsePhpSerialized(CORPUS['custom'] as string);
    expect(custom.t).toBe('custom');
    if (custom.t === 'custom') {
      expect(custom.class).toBe('Bar');
      expect(new TextDecoder().decode(custom.data)).toBe('hello');
    }
    const refs = parsePhpSerialized(CORPUS['references'] as string);
    if (refs.t !== 'array') throw new Error('expected array');
    expect(refs.entries[1]?.value).toEqual({ t: 'ref', kind: 'r', index: '2' });
    expect(refs.entries[2]?.value).toEqual({ t: 'ref', kind: 'R', index: '2' });
  });

  it('keeps the multibyte string decoded and the big int as text', () => {
    expect(parsePhpSerialized(CORPUS['multibyte'] as string)).toEqual({
      t: 'string',
      v: 'héllo ☃',
    });
    expect(parsePhpSerialized(CORPUS['bigInt'] as string)).toEqual({
      t: 'int',
      v: '9223372036854775807',
    });
    expect(parsePhpSerialized(CORPUS['awkwardString'] as string)).toEqual({
      t: 'string',
      v: 'a";b}\u0000c',
    });
  });
});

describe('php-serialize editing', () => {
  it('recomputes the byte length when a string is edited to a longer multibyte value', () => {
    const v = parsePhpSerialized('s:5:"hello";');
    if (v.t !== 'string') throw new Error('expected string');
    v.v = 'héllo ☃';
    expect(serializePhp(v)).toBe('s:10:"héllo ☃";');
  });

  it('recomputes counts and class-name lengths when the tree changes', () => {
    const v = parsePhpSerialized('a:1:{i:0;i:1;}');
    if (v.t !== 'array') throw new Error('expected array');
    v.entries.push({
      key: { t: 'string', v: 'ü' },
      value: { t: 'object', class: 'Ünïcode', props: [] },
    });
    expect(serializePhp(v)).toBe('a:2:{i:0;i:1;s:2:"ü";O:9:"Ünïcode":0:{}}');
  });

  it('writes protected and private prefixes back, defaulting a private declaring class to the owner', () => {
    const v: PhpValue = {
      t: 'object',
      class: 'Foo',
      props: [
        { name: 'p', visibility: 'protected', value: { t: 'null' } },
        { name: 'q', visibility: 'private', value: { t: 'null' } },
      ],
    };
    expect(serializePhp(v)).toBe('O:3:"Foo":2:{s:4:"\u0000*\u0000p";N;s:6:"\u0000Foo\u0000q";N;}');
  });

  it('keeps bytes that are not valid UTF-8 through `binary`', () => {
    const input = new Uint8Array([
      ...new TextEncoder().encode('s:2:"'),
      0xff,
      0xfe,
      ...new TextEncoder().encode('";'),
    ]);
    const v = parsePhpSerialized(input);
    if (v.t !== 'string') throw new Error('expected string');
    expect(v.binary).toEqual(new Uint8Array([0xff, 0xfe]));
    expect(v.v).toBe('ÿþ');
    expect(serializePhpBytes(v)).toEqual(input);
  });
});

describe('php-serialize errors', () => {
  const fails = (text: string): PhpSerializeError => {
    try {
      parsePhpSerialized(text);
    } catch (err) {
      expect(err).toBeInstanceOf(PhpSerializeError);
      return err as PhpSerializeError;
    }
    throw new Error(`expected ${JSON.stringify(text)} to fail`);
  };

  it('reports truncated input', () => {
    const err = fails('a:1:{i:0;');
    expect(err.offset).toBe(9);
    expect(err.message).toMatch(/truncated/);
  });

  it('reports a wrong string length', () => {
    const err = fails('s:3:"ab";');
    expect(err.offset).toBe(8);
    expect(err.message).toMatch(/string length is wrong/);
  });

  it('reports trailing garbage', () => {
    const err = fails('N;x');
    expect(err.offset).toBe(2);
    expect(err.message).toMatch(/trailing/);
  });

  it('reports a bad key type', () => {
    const err = fails('a:1:{b:1;i:0;}');
    expect(err.offset).toBe(5);
    expect(err.message).toMatch(/int or string key/);
  });

  it('tryParse returns null instead of throwing', () => {
    expect(tryParsePhpSerialized('a:1')).toBeNull();
    expect(tryParsePhpSerialized('N;')).toEqual({ t: 'null' });
  });
});

describe('php-serialize helpers', () => {
  it('isPhpSerialized is strict', () => {
    expect(isPhpSerialized('a:1')).toBe(false);
    expect(isPhpSerialized('{"a":1}')).toBe(false);
    expect(isPhpSerialized('N;')).toBe(true);
    expect(isPhpSerialized(CORPUS['wordpressOptions'] as string)).toBe(true);
  });

  it('labels types', () => {
    expect(phpTypeLabel(parsePhpSerialized('a:2:{i:0;i:1;i:1;i:2;}'))).toBe('array(2)');
    expect(phpTypeLabel(parsePhpSerialized('O:8:"stdClass":0:{}'))).toBe('stdClass');
    expect(phpTypeLabel(parsePhpSerialized('E:11:"Suit:Hearts";'))).toBe('Suit::Hearts');
    expect(phpTypeLabel(parsePhpSerialized('i:1;'))).toBe('int');
  });

  it('renders annotated JSON with class and visibility markers', () => {
    expect(toAnnotatedJson(parsePhpSerialized(CORPUS['objectVisibility'] as string))).toEqual({
      __class: 'Foo',
      pub: 1,
      '#pro': true,
      '-Foo::pri': null,
    });
    expect(toAnnotatedJson(parsePhpSerialized(CORPUS['wordpressOptions'] as string))).toEqual({
      name: 'Hello',
      count: 42,
      ratio: 0.5,
      big: 1e25,
      items: { 0: true, 1: null, x1: [] },
    });
    expect(toAnnotatedJson(parsePhpSerialized(CORPUS['bigInt'] as string))).toBe(
      '9223372036854775807',
    );
    expect(toAnnotatedJson(parsePhpSerialized('d:INF;'))).toBe('INF');
    expect(toAnnotatedJson(parsePhpSerialized(CORPUS['references'] as string))).toEqual([
      { __class: 'stdClass' },
      { __ref: 'r:2' },
      { __ref: 'R:2' },
    ]);
    expect(toAnnotatedJson(parsePhpSerialized(CORPUS['custom'] as string))).toEqual({
      __custom: 'Bar',
      bytes: 5,
    });
  });
});
