/**
 * OpenSSH known_hosts: plain host names, `[host]:port`, hashed `|1|salt|hmac` entries,
 * comma-separated patterns with `*`, `?` and `!`, and the `@revoked` / `@cert-authority` markers.
 * RaSQL reads the user's file and its own, and only ever appends to its own.
 */
import { createHash, createHmac } from 'node:crypto';
import { patternMatches } from './config';

export interface KnownHostEntry {
  file: string;
  line: number;
  marker?: 'revoked' | 'cert-authority';
  hosts: string[];
  keyType: string;
  key: Buffer;
}

export type KnownHostVerdict =
  | { status: 'match'; entry: KnownHostEntry }
  | { status: 'unknown' }
  | { status: 'revoked'; entry: KnownHostEntry }
  | { status: 'mismatch'; entry: KnownHostEntry };

export function parseKnownHosts(text: string, file: string): KnownHostEntry[] {
  const out: KnownHostEntry[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(/\s+/);
    let marker: KnownHostEntry['marker'];
    if (parts[0] === '@revoked' || parts[0] === '@cert-authority') {
      marker = parts.shift()?.slice(1) as KnownHostEntry['marker'];
    }
    const [hosts, keyType, b64] = parts;
    if (!hosts || !keyType || !b64) return;
    let key: Buffer;
    try {
      key = Buffer.from(b64, 'base64');
    } catch {
      return;
    }
    if (!key.length) return;
    const entry: KnownHostEntry = { file, line: i + 1, hosts: hosts.split(','), keyType, key };
    if (marker) entry.marker = marker;
    out.push(entry);
  });
  return out;
}

/** The name OpenSSH writes for host/port: bare for port 22, `[host]:port` otherwise. */
export function knownHostName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function hostMatches(pattern: string, name: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|');
    if (!salt || !hash) return false;
    const mac = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
    return mac === hash;
  }
  return patternMatches(pattern, name);
}

function entryMatchesHost(entry: KnownHostEntry, name: string): boolean {
  const negated = entry.hosts.some((h) => h.startsWith('!') && hostMatches(h.slice(1), name));
  if (negated) return false;
  return entry.hosts.some((h) => !h.startsWith('!') && hostMatches(h, name));
}

/** The key type as encoded in the blob itself: "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256". */
export function keyTypeOf(key: Buffer): string {
  if (key.length < 4) return 'unknown';
  const len = key.readUInt32BE(0);
  if (len <= 0 || len > key.length - 4) return 'unknown';
  return key.subarray(4, 4 + len).toString('ascii');
}

/** OpenSSH style fingerprint: SHA256 of the blob, base64 without padding. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

export function verifyKnownHost(
  entries: KnownHostEntry[],
  host: string,
  port: number,
  key: Buffer,
): KnownHostVerdict {
  const name = knownHostName(host, port);
  const type = keyTypeOf(key);
  const matching = entries.filter((e) => entryMatchesHost(e, name));
  const revoked = matching.find((e) => e.marker === 'revoked' && e.key.equals(key));
  if (revoked) return { status: 'revoked', entry: revoked };
  const same = matching.find((e) => !e.marker && e.key.equals(key));
  if (same) return { status: 'match', entry: same };
  const conflicting = matching.find((e) => !e.marker && e.keyType === type);
  if (conflicting) return { status: 'mismatch', entry: conflicting };
  return { status: 'unknown' };
}

export function formatKnownHostLine(host: string, port: number, key: Buffer): string {
  return `${knownHostName(host, port)} ${keyTypeOf(key)} ${key.toString('base64')}`;
}
