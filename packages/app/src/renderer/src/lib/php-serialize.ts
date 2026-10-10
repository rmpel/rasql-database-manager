/**
 * Lossless parser and serializer for PHP's serialize() format.
 *
 * Everything PHP encodes survives a round trip: int versus string keys, bool versus int, floats
 * as written, object class names, property visibility (encoded by PHP as \0*\0name and
 * \0Class\0name), enums, custom-serialized classes with opaque payloads, references, and string
 * bytes that are not valid UTF-8. Lengths are bytes, so parsing works on a Uint8Array and
 * serializing recomputes every length from UTF-8 bytes.
 */

export type PhpKey = { t: 'int'; v: string } | { t: 'string'; v: string };
export type PhpVisibility = 'public' | 'protected' | 'private';
export interface PhpProperty {
  name: string;
  visibility: PhpVisibility;
  /** Only for private properties: the class that declared them. */
  declaringClass?: string;
  value: PhpValue;
}
export type PhpValue =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  /** Digits as written, so 64-bit values survive. */
  | { t: 'int'; v: string }
  /** Text as written: "0.1", "1.0E+25", "INF", "-INF", "NAN". */
  | { t: 'float'; v: string }
  /** v is the UTF-8 decoding; when the bytes are not valid UTF-8, v is a latin1 view and `binary` holds the exact bytes. */
  | { t: 'string'; v: string; binary?: Uint8Array }
  | { t: 'array'; entries: { key: PhpKey; value: PhpValue }[] }
  | { t: 'object'; class: string; props: PhpProperty[] }
  /** E:len:"Class:Case"; */
  | { t: 'enum'; class: string; case: string }
  /** C:len:"Class":dlen:{...} with an opaque payload. */
  | { t: 'custom'; class: string; data: Uint8Array }
  /** Reference to the n-th value, kept verbatim. */
  | { t: 'ref'; kind: 'R' | 'r'; index: string };

export interface ParseResult {
  value: PhpValue;
  /** bytes consumed */
  length: number;
}

export class PhpSerializeError extends Error {
  offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = 'PhpSerializeError';
    this.offset = offset;
  }
}

const encoder = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

const toBytes = (input: string | Uint8Array): Uint8Array =>
  typeof input === 'string' ? encoder.encode(input) : input;

/** latin1 view: one char per byte, so the text can be re-encoded byte-exact if needed. */
function latin1View(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return s;
}

function decodeString(bytes: Uint8Array): { t: 'string'; v: string; binary?: Uint8Array } {
  try {
    return { t: 'string', v: utf8Strict.decode(bytes) };
  } catch {
    return { t: 'string', v: latin1View(bytes), binary: bytes.slice() };
  }
}

const CH = {
  colon: 0x3a,
  semi: 0x3b,
  quote: 0x22,
  lbrace: 0x7b,
  rbrace: 0x7d,
  nul: 0x00,
};

class Parser {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  private fail(what: string, at = this.pos): never {
    throw new PhpSerializeError(`Expected ${what}`, at);
  }

  private peek(): number {
    if (this.pos >= this.buf.length) this.fail('more input (truncated)');
    return this.buf[this.pos] as number;
  }

  private expectByte(byte: number, what: string): void {
    if (this.pos >= this.buf.length || this.buf[this.pos] !== byte) this.fail(what);
    this.pos++;
  }

  /** ASCII run up to (not including) the terminator; the terminator is consumed. */
  private readUntil(terminator: number, what: string): string {
    const start = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos] !== terminator) this.pos++;
    if (this.pos >= this.buf.length)
      this.fail(`${what} terminated by '${String.fromCharCode(terminator)}'`, start);
    const text = latin1View(this.buf.subarray(start, this.pos));
    this.pos++;
    return text;
  }

  private readLength(what: string): number {
    const start = this.pos;
    const text = this.readUntil(CH.colon, `${what} length`);
    if (!/^\d+$/.test(text)) this.fail(`a non-negative ${what} length`, start);
    return Number(text);
  }

  /** `"<len bytes>"`, returns the raw bytes. */
  private readQuotedBytes(len: number): Uint8Array {
    this.expectByte(CH.quote, 'opening quote');
    const start = this.pos;
    if (start + len > this.buf.length) this.fail(`${len} string bytes (truncated)`, start);
    const bytes = this.buf.subarray(start, start + len);
    this.pos = start + len;
    this.expectByte(CH.quote, `closing quote after ${len} bytes (string length is wrong)`);
    return bytes;
  }

  parseValue(): PhpValue {
    const start = this.pos;
    const type = String.fromCharCode(this.peek());
    this.pos++;
    if (type === 'N') {
      this.expectByte(CH.semi, "';' after N");
      return { t: 'null' };
    }
    this.expectByte(CH.colon, `':' after type '${type}'`);
    switch (type) {
      case 'b': {
        const text = this.readUntil(CH.semi, 'bool');
        if (text !== '0' && text !== '1') this.fail("bool value '0' or '1'", start + 2);
        return { t: 'bool', v: text === '1' };
      }
      case 'i': {
        const text = this.readUntil(CH.semi, 'int');
        if (!/^[+-]?\d+$/.test(text)) this.fail('integer digits', start + 2);
        return { t: 'int', v: text };
      }
      case 'd': {
        const text = this.readUntil(CH.semi, 'float');
        if (!/^(-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|-?INF|NAN)$/.test(text)) {
          this.fail('a float literal', start + 2);
        }
        return { t: 'float', v: text };
      }
      case 's': {
        const len = this.readLength('string');
        const bytes = this.readQuotedBytes(len);
        this.expectByte(CH.semi, "';' after string");
        return decodeString(bytes);
      }
      case 'a': {
        const count = this.readLength('array');
        this.expectByte(CH.lbrace, "'{' opening array");
        const entries: { key: PhpKey; value: PhpValue }[] = [];
        for (let i = 0; i < count; i++) {
          const key = this.parseKey();
          const value = this.parseValue();
          entries.push({ key, value });
        }
        this.expectByte(CH.rbrace, "'}' closing array");
        return { t: 'array', entries };
      }
      case 'O': {
        const len = this.readLength('class name');
        const cls = decodeString(this.readQuotedBytes(len)).v;
        this.expectByte(CH.colon, "':' after class name");
        const count = this.readLength('property');
        this.expectByte(CH.lbrace, "'{' opening object");
        const props: PhpProperty[] = [];
        for (let i = 0; i < count; i++) {
          const key = this.parseKey();
          const value = this.parseValue();
          props.push(propertyFromKey(key, value));
        }
        this.expectByte(CH.rbrace, "'}' closing object");
        return { t: 'object', class: cls, props };
      }
      case 'E': {
        const len = this.readLength('enum');
        const text = decodeString(this.readQuotedBytes(len)).v;
        this.expectByte(CH.semi, "';' after enum");
        const sep = text.indexOf(':');
        if (sep <= 0) this.fail('enum as Class:Case', start);
        return { t: 'enum', class: text.slice(0, sep), case: text.slice(sep + 1) };
      }
      case 'C': {
        const len = this.readLength('class name');
        const cls = decodeString(this.readQuotedBytes(len)).v;
        this.expectByte(CH.colon, "':' after class name");
        const dlen = this.readLength('custom data');
        this.expectByte(CH.lbrace, "'{' opening custom data");
        if (this.pos + dlen > this.buf.length)
          this.fail(`${dlen} bytes of custom data (truncated)`);
        const data = this.buf.slice(this.pos, this.pos + dlen);
        this.pos += dlen;
        this.expectByte(CH.rbrace, "'}' closing custom data (data length is wrong)");
        return { t: 'custom', class: cls, data };
      }
      case 'R':
      case 'r': {
        const text = this.readUntil(CH.semi, 'reference');
        if (!/^\d+$/.test(text)) this.fail('reference index', start + 2);
        return { t: 'ref', kind: type, index: text };
      }
      default:
        return this.fail(`a value type, got '${type}'`, start);
    }
  }

  private parseKey(): PhpKey {
    const at = this.pos;
    const key = this.parseValue();
    if (key.t === 'int') return { t: 'int', v: key.v };
    if (key.t === 'string') return { t: 'string', v: key.binary ? latin1View(key.binary) : key.v };
    return this.fail(`an int or string key, got ${key.t}`, at);
  }
}

function propertyFromKey(key: PhpKey, value: PhpValue): PhpProperty {
  const name = key.v;
  if (key.t === 'string' && name.charCodeAt(0) === CH.nul) {
    const end = name.indexOf('\0', 1);
    if (end > 0) {
      const marker = name.slice(1, end);
      const prop = name.slice(end + 1);
      if (marker === '*') return { name: prop, visibility: 'protected', value };
      return { name: prop, visibility: 'private', declaringClass: marker, value };
    }
  }
  return { name, visibility: 'public', value };
}

export function parsePhpSerializedWithLength(input: string | Uint8Array): ParseResult {
  const buf = toBytes(input);
  const parser = new Parser(buf);
  const value = parser.parseValue();
  return { value, length: parser.pos };
}

/** Parse one value; the whole input must be consumed. Throws PhpSerializeError with a byte offset. */
export function parsePhpSerialized(input: string | Uint8Array): PhpValue {
  const buf = toBytes(input);
  const { value, length } = parsePhpSerializedWithLength(buf);
  if (length !== buf.length)
    throw new PhpSerializeError('Expected end of input (trailing data)', length);
  return value;
}

export function tryParsePhpSerialized(input: string | Uint8Array): PhpValue | null {
  try {
    return parsePhpSerialized(input);
  } catch {
    return null;
  }
}

/** Strict: the text parses and is consumed entirely. */
export function isPhpSerialized(text: string): boolean {
  return tryParsePhpSerialized(text) !== null;
}

// ---------------------------------------------------------------------------------------------
// Serialization

class Writer {
  private chunks: Uint8Array[] = [];
  private size = 0;

  ascii(text: string): void {
    this.bytes(encoder.encode(text));
  }

  bytes(b: Uint8Array): void {
    this.chunks.push(b);
    this.size += b.length;
  }

  quoted(b: Uint8Array): void {
    this.ascii(`${b.length}:"`);
    this.bytes(b);
    this.ascii('"');
  }

  result(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

const stringBytes = (v: { v: string; binary?: Uint8Array }): Uint8Array =>
  v.binary ?? encoder.encode(v.v);

function writeKey(w: Writer, key: PhpKey): void {
  if (key.t === 'int') w.ascii(`i:${key.v};`);
  else {
    w.ascii('s:');
    w.quoted(encoder.encode(key.v));
    w.ascii(';');
  }
}

function propertyKey(p: PhpProperty, ownerClass: string): PhpKey {
  if (p.visibility === 'protected') return { t: 'string', v: `\0*\0${p.name}` };
  if (p.visibility === 'private')
    return { t: 'string', v: `\0${p.declaringClass ?? ownerClass}\0${p.name}` };
  return { t: 'string', v: p.name };
}

function writeValue(w: Writer, value: PhpValue): void {
  switch (value.t) {
    case 'null':
      w.ascii('N;');
      return;
    case 'bool':
      w.ascii(value.v ? 'b:1;' : 'b:0;');
      return;
    case 'int':
      w.ascii(`i:${value.v};`);
      return;
    case 'float':
      w.ascii(`d:${value.v};`);
      return;
    case 'string':
      w.ascii('s:');
      w.quoted(stringBytes(value));
      w.ascii(';');
      return;
    case 'array':
      w.ascii(`a:${value.entries.length}:{`);
      for (const e of value.entries) {
        writeKey(w, e.key);
        writeValue(w, e.value);
      }
      w.ascii('}');
      return;
    case 'object':
      w.ascii('O:');
      w.quoted(encoder.encode(value.class));
      w.ascii(`:${value.props.length}:{`);
      for (const p of value.props) {
        writeKey(w, propertyKey(p, value.class));
        writeValue(w, p.value);
      }
      w.ascii('}');
      return;
    case 'enum':
      w.ascii('E:');
      w.quoted(encoder.encode(`${value.class}:${value.case}`));
      w.ascii(';');
      return;
    case 'custom':
      w.ascii('C:');
      w.quoted(encoder.encode(value.class));
      w.ascii(`:${value.data.length}:{`);
      w.bytes(value.data);
      w.ascii('}');
      return;
    case 'ref':
      w.ascii(`${value.kind}:${value.index};`);
      return;
  }
}

export function serializePhpBytes(value: PhpValue): Uint8Array {
  const w = new Writer();
  writeValue(w, value);
  return w.result();
}

/**
 * The serialized text. Byte-exact for anything parsed; a string with `binary` (bytes that were not
 * valid UTF-8) is rendered through a latin1 view so the text is still one char per byte.
 */
export function serializePhp(value: PhpValue): string {
  const bytes = serializePhpBytes(value);
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return latin1View(bytes);
  }
}

// ---------------------------------------------------------------------------------------------
// Presentation helpers

export function phpTypeLabel(value: PhpValue): string {
  switch (value.t) {
    case 'null':
      return 'null';
    case 'bool':
      return 'bool';
    case 'int':
      return 'int';
    case 'float':
      return 'float';
    case 'string':
      return value.binary ? `string(${value.binary.length} bytes, binary)` : 'string';
    case 'array':
      return `array(${value.entries.length})`;
    case 'object':
      return value.class;
    case 'enum':
      return `${value.class}::${value.case}`;
    case 'custom':
      return `custom ${value.class}`;
    case 'ref':
      return `ref ${value.kind}:${value.index}`;
  }
}

const isList = (entries: { key: PhpKey }[]): boolean =>
  entries.every((e, i) => e.key.t === 'int' && e.key.v === String(i));

function numberOrText(text: string, allowFloat: boolean): number | string {
  if (allowFloat) {
    if (/^-?INF$|^NAN$/.test(text)) return text;
    const n = Number(text);
    return Number.isFinite(n) && String(n).length <= 17 ? n : text;
  }
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : text;
}

/** A read-only JSON-ish rendering that keeps PHP's extra information visible instead of dropping it. */
export function toAnnotatedJson(value: PhpValue): unknown {
  switch (value.t) {
    case 'null':
      return null;
    case 'bool':
      return value.v;
    case 'int':
      return numberOrText(value.v, false);
    case 'float':
      return numberOrText(value.v, true);
    case 'string':
      return value.v;
    case 'array':
      if (isList(value.entries)) return value.entries.map((e) => toAnnotatedJson(e.value));
      return Object.fromEntries(value.entries.map((e) => [e.key.v, toAnnotatedJson(e.value)]));
    case 'object': {
      const out: Record<string, unknown> = { __class: value.class };
      for (const p of value.props) {
        const key =
          p.visibility === 'protected'
            ? `#${p.name}`
            : p.visibility === 'private'
              ? `-${p.declaringClass ?? value.class}::${p.name}`
              : p.name;
        out[key] = toAnnotatedJson(p.value);
      }
      return out;
    }
    case 'enum':
      return `${value.class}::${value.case}`;
    case 'custom':
      return { __custom: value.class, bytes: value.data.length };
    case 'ref':
      return { __ref: `${value.kind}:${value.index}` };
  }
}
