/**
 * A reader for ~/.ssh/config: enough of it for hops to inherit HostName, User, Port,
 * IdentityFile, ProxyJump and IdentitiesOnly from an alias. First match wins per keyword,
 * as in OpenSSH; `Include` pulls in files relative to ~/.ssh.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

/**
 * ssh_config paths are POSIX-style on every OS, including OpenSSH for Windows, so the parser
 * never uses the host's path separator. Forward slashes work for Node's fs on Windows too.
 */
const toPosix = (p: string): string => p.replace(/\\/g, '/');
const isAbsolutePath = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p);
const { basename, dirname, join, resolve } = posix;

export interface SshConfigEntry {
  patterns: string[];
  options: Map<string, string[]>;
}

export interface ResolvedSshHost {
  hostName: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  identitiesOnly: boolean;
  proxyJump: JumpSpec[];
}

export interface JumpSpec {
  host: string;
  user?: string;
  port?: number;
}

export interface ReadFileLike {
  (path: string): string | null;
}

export interface ListDirLike {
  (dir: string): string[];
}

const defaultLister: ListDirLike = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const defaultReader: ReadFileLike = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

export function expandHome(path: string, home = homedir()): string {
  const h = toPosix(home);
  if (path === '~') return h;
  if (path.startsWith('~/')) return join(h, path.slice(2));
  return toPosix(path);
}

/** Glob with `*` and `?`, as OpenSSH matches Host patterns. */
export function patternMatches(pattern: string, host: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.split('?').map(escapeRegExp).join('.'))
      .join('.*')}$`,
    'i',
  );
  return re.test(host);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Parse config text. Includes are resolved through `read`, relative to `sshDir`. */
export function parseSshConfig(
  text: string,
  opts: { sshDir?: string; read?: ReadFileLike; listDir?: ListDirLike; depth?: number } = {},
): SshConfigEntry[] {
  const sshDir = opts.sshDir ?? join(toPosix(homedir()), '.ssh');
  const read = opts.read ?? defaultReader;
  const listDir = opts.listDir ?? defaultLister;
  const depth = opts.depth ?? 0;
  const entries: SshConfigEntry[] = [];
  // Options before the first Host line apply to everything.
  let current: SshConfigEntry = { patterns: ['*'], options: new Map() };
  entries.push(current);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s*(?:=\s*)?(.*)$/.exec(line);
    if (!m) continue;
    const keyword = (m[1] as string).toLowerCase();
    const value = (m[2] as string).trim();

    if (keyword === 'host') {
      current = { patterns: splitArgs(value), options: new Map() };
      entries.push(current);
      continue;
    }
    if (keyword === 'match') {
      // Match blocks are not supported; everything until the next Host is ignored.
      current = { patterns: [], options: new Map() };
      continue;
    }
    if (keyword === 'include') {
      if (depth > 8) continue;
      for (const arg of splitArgs(value)) {
        const dir = toPosix(sshDir);
        const pattern = isAbsolutePath(arg)
          ? toPosix(arg)
          : resolve(dir, expandHome(arg, dirname(dir)));
        const paths = /[*?]/.test(basename(pattern))
          ? listDir(dirname(pattern))
              .filter((f) => patternMatches(basename(pattern), f))
              .sort()
              .map((f) => join(dirname(pattern), f))
          : [pattern];
        for (const path of paths) {
          const included = read(path);
          if (included === null) continue;
          const sub = parseSshConfig(included, { sshDir, read, listDir, depth: depth + 1 });
          // An Include inside a Host block scopes the included global options to that block.
          for (const entry of sub) {
            if (
              entry.patterns.length === 1 &&
              entry.patterns[0] === '*' &&
              current.patterns.length
            ) {
              for (const [k, v] of entry.options) {
                if (!current.options.has(k)) current.options.set(k, v);
              }
            } else {
              entries.push(entry);
            }
          }
        }
      }
      continue;
    }
    const list = current.options.get(keyword) ?? [];
    list.push(value);
    current.options.set(keyword, list);
  }
  return entries;
}

function splitArgs(value: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) out.push((m[1] ?? m[2]) as string);
  return out;
}

/** Resolve what OpenSSH would use for `host`. Negated patterns (`!foo`) exclude a block. */
export function resolveSshHost(
  entries: SshConfigEntry[],
  host: string,
  home = homedir(),
): ResolvedSshHost {
  const first = new Map<string, string>();
  const identityFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.patterns.length) continue;
    const negated = entry.patterns.some(
      (p) => p.startsWith('!') && patternMatches(p.slice(1), host),
    );
    if (negated) continue;
    const positive = entry.patterns.some((p) => !p.startsWith('!') && patternMatches(p, host));
    if (!positive) continue;
    for (const [k, values] of entry.options) {
      if (k === 'identityfile') {
        for (const v of values) identityFiles.push(expandHome(v, home));
        continue;
      }
      if (!first.has(k)) first.set(k, values[0] as string);
    }
  }
  const out: ResolvedSshHost = {
    hostName: first.get('hostname') ?? host,
    identityFiles: [...new Set(identityFiles)],
    identitiesOnly: /^yes$/i.test(first.get('identitiesonly') ?? ''),
    proxyJump: parseProxyJump(first.get('proxyjump')),
  };
  const user = first.get('user');
  if (user) out.user = user;
  const port = Number(first.get('port'));
  if (Number.isInteger(port) && port > 0) out.port = port;
  return out;
}

/** `ProxyJump user@host:port,host2` */
export function parseProxyJump(value: string | undefined): JumpSpec[] {
  if (!value || /^none$/i.test(value)) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(spec);
      if (!m) return { host: spec };
      const out: JumpSpec = { host: (m[2] as string).replace(/^\[|\]$/g, '') };
      if (m[1]) out.user = m[1];
      if (m[3]) out.port = Number(m[3]);
      return out;
    });
}

/** Host aliases a user would type: concrete names, no wildcards or negations. */
export function listAliases(entries: SshConfigEntry[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    for (const p of entry.patterns) if (!/[*?!]/.test(p)) out.add(p);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export function loadUserSshConfig(
  home = homedir(),
  read: ReadFileLike = defaultReader,
): SshConfigEntry[] {
  const sshDir = join(toPosix(home), '.ssh');
  const text = read(join(sshDir, 'config'));
  if (text === null) return [];
  return parseSshConfig(text, { sshDir, read });
}

/** Keys OpenSSH tries by default, those that exist. */
export function defaultIdentityFiles(home = homedir()): string[] {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_ed25519_sk', 'id_ecdsa_sk']
    .map((f) => join(toPosix(home), '.ssh', f))
    .filter((f) => existsSync(f));
}
