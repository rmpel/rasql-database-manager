import { describe, expect, it } from 'vitest';
import {
  listAliases,
  parseProxyJump,
  parseSshConfig,
  patternMatches,
  resolveSshHost,
} from './config';

const CONFIG = `
# global
ServerAliveInterval 30
IdentityFile ~/.ssh/global_key

Host bastion
  HostName bastion.example.com
  User jump
  Port 2222

Host prod-*
  User deploy
  ProxyJump bastion
  IdentityFile ~/.ssh/prod_ed25519
  IdentityFile ~/.ssh/prod_rsa
  IdentitiesOnly yes

Host prod-db
  HostName 10.0.0.5
  Port 22022

Host !prod-secret prod-*
  User someone-else

Include conf.d/*.conf

Host *
  User fallback

Match host foo
  User ignored
`;

const INCLUDED = `Host included-host\n  HostName inc.example.com\n  User inc\n`;

describe('ssh config', () => {
  const entries = parseSshConfig(CONFIG, {
    sshDir: '/home/me/.ssh',
    read: (path) => (path === '/home/me/.ssh/conf.d/10-work.conf' ? INCLUDED : null),
    listDir: (dir) => (dir === '/home/me/.ssh/conf.d' ? ['10-work.conf', 'notes.txt'] : []),
  });

  it('matches Host patterns with wildcards and negation', () => {
    expect(patternMatches('prod-*', 'prod-db')).toBe(true);
    expect(patternMatches('prod-?', 'prod-1')).toBe(true);
    expect(patternMatches('prod-?', 'prod-12')).toBe(false);
    expect(patternMatches('*.example.com', 'a.b.example.com')).toBe(true);
    expect(patternMatches('bastion', 'Bastion')).toBe(true);
  });

  it('inherits first-match-wins options and all identity files', () => {
    const r = resolveSshHost(entries, 'prod-db', '/home/me');
    expect(r.hostName).toBe('10.0.0.5');
    expect(r.user).toBe('deploy');
    expect(r.port).toBe(22022);
    expect(r.identitiesOnly).toBe(true);
    expect(r.identityFiles).toEqual([
      '/home/me/.ssh/global_key',
      '/home/me/.ssh/prod_ed25519',
      '/home/me/.ssh/prod_rsa',
    ]);
    expect(r.proxyJump).toEqual([{ host: 'bastion' }]);
  });

  it('honors negated patterns', () => {
    expect(resolveSshHost(entries, 'prod-secret').user).toBe('deploy');
    expect(resolveSshHost(entries, 'prod-other').user).toBe('deploy');
  });

  it('falls back to Host * and the bare host name', () => {
    const r = resolveSshHost(entries, 'unknown.example.net');
    expect(r.hostName).toBe('unknown.example.net');
    expect(r.user).toBe('fallback');
    expect(r.port).toBeUndefined();
    expect(r.proxyJump).toEqual([]);
  });

  it('resolves Include files relative to ~/.ssh', () => {
    const r = resolveSshHost(entries, 'included-host');
    expect(r.hostName).toBe('inc.example.com');
    expect(r.user).toBe('inc');
  });

  it('ignores Match blocks', () => {
    expect(resolveSshHost(entries, 'foo').user).toBe('fallback');
  });

  it('parses ProxyJump chains', () => {
    expect(parseProxyJump('a@one:2200,two,[::1]:22')).toEqual([
      { host: 'one', user: 'a', port: 2200 },
      { host: 'two' },
      { host: '::1', port: 22 },
    ]);
    expect(parseProxyJump('none')).toEqual([]);
    expect(parseProxyJump(undefined)).toEqual([]);
  });

  it('lists concrete aliases only', () => {
    expect(listAliases(entries)).toEqual(['bastion', 'included-host', 'prod-db']);
  });
});
