import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { utils } from 'ssh2';
import {
  fingerprint,
  formatKnownHostLine,
  keyTypeOf,
  knownHostName,
  parseKnownHosts,
  verifyKnownHost,
} from './known-hosts';
import { HOST_KEYS, RSA_PUBLIC_KEY, type TestKeyPair } from './test-keys';

let nextKey = 0;
function blob(): Buffer {
  const pair = HOST_KEYS[nextKey++ % HOST_KEYS.length] as TestKeyPair;
  const parsed = utils.parseKey(pair.private);
  if (parsed instanceof Error) throw parsed;
  return parsed.getPublicSSH();
}

function hashed(name: string): string {
  const salt = randomBytes(20);
  const mac = createHmac('sha1', salt).update(name).digest('base64');
  return `|1|${salt.toString('base64')}|${mac}`;
}

describe('known_hosts', () => {
  const key = blob();
  const other = blob();
  const b64 = key.toString('base64');

  it('reads the key type and fingerprint from the blob', () => {
    expect(keyTypeOf(key)).toBe('ssh-ed25519');
    expect(fingerprint(key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(knownHostName('h', 22)).toBe('h');
    expect(knownHostName('h', 2222)).toBe('[h]:2222');
  });

  it('matches plain, port-qualified and hashed entries', () => {
    const text = [
      `# comment`,
      `db.example.com,10.0.0.5 ssh-ed25519 ${b64}`,
      `[bastion.example.com]:2222 ssh-ed25519 ${b64}`,
      `${hashed('[hidden.example.com]:2200')} ssh-ed25519 ${b64}`,
    ].join('\n');
    const entries = parseKnownHosts(text, '/k');
    expect(entries).toHaveLength(3);
    expect(verifyKnownHost(entries, 'db.example.com', 22, key).status).toBe('match');
    expect(verifyKnownHost(entries, '10.0.0.5', 22, key).status).toBe('match');
    expect(verifyKnownHost(entries, 'bastion.example.com', 2222, key).status).toBe('match');
    expect(verifyKnownHost(entries, 'bastion.example.com', 22, key).status).toBe('unknown');
    expect(verifyKnownHost(entries, 'hidden.example.com', 2200, key).status).toBe('match');
    expect(verifyKnownHost(entries, 'nowhere', 22, key).status).toBe('unknown');
  });

  it('reports a changed key with the offending line', () => {
    const entries = parseKnownHosts(
      `\n\ndb ssh-ed25519 ${other.toString('base64')}\n`,
      '/home/me/.ssh/known_hosts',
    );
    const v = verifyKnownHost(entries, 'db', 22, key);
    expect(v).toMatchObject({
      status: 'mismatch',
      entry: { file: '/home/me/.ssh/known_hosts', line: 3 },
    });
  });

  it('treats a different key type as unknown, not a mismatch', () => {
    const rsa = utils.parseKey(RSA_PUBLIC_KEY);
    if (rsa instanceof Error) throw rsa;
    const entries = parseKnownHosts(`db ssh-rsa ${rsa.getPublicSSH().toString('base64')}`, '/k');
    expect(verifyKnownHost(entries, 'db', 22, key).status).toBe('unknown');
  });

  it('refuses revoked keys and ignores cert authorities', () => {
    const entries = parseKnownHosts(
      [
        `@revoked db ssh-ed25519 ${b64}`,
        `@cert-authority * ssh-ed25519 ${other.toString('base64')}`,
      ].join('\n'),
      '/k',
    );
    expect(verifyKnownHost(entries, 'db', 22, key).status).toBe('revoked');
    expect(verifyKnownHost(entries, 'elsewhere', 22, other).status).toBe('unknown');
  });

  it('honors negated host patterns', () => {
    const entries = parseKnownHosts(`!db-secret,db-* ssh-ed25519 ${b64}`, '/k');
    expect(verifyKnownHost(entries, 'db-1', 22, key).status).toBe('match');
    expect(verifyKnownHost(entries, 'db-secret', 22, key).status).toBe('unknown');
  });

  it('formats lines OpenSSH can read back', () => {
    const line = formatKnownHostLine('h', 2222, key);
    expect(line).toBe(`[h]:2222 ssh-ed25519 ${b64}`);
    expect(verifyKnownHost(parseKnownHosts(line, '/k'), 'h', 2222, key).status).toBe('match');
  });
});
