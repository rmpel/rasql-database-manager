import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Entry } from '@napi-rs/keyring';

/**
 * Where secrets live. Connection definitions only ever hold a reference (see shared/api.ts).
 * The default provider stores real OS keychain items (Keychain Access on macOS, Credential
 * Manager on Windows, Secret Service on Linux). Electron's safeStorage is the fallback for
 * systems without a keychain; see docs/DECISIONS.md D-25 for why it is not the default.
 */
export interface CredentialProvider {
  readonly id: string;
  available(): boolean;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export type SecretKind = 'password' | 'ssh-password' | 'ssh-passphrase';

/** Tests point this at a separate service so they never touch real items. */
export const KEYCHAIN_SERVICE = process.env['RASQL_KEYCHAIN_SERVICE'] || 'RaSQL';

export const secretAccount = (connectionId: string, kind: SecretKind): string =>
  `rasql:${connectionId}:${kind}`;
export const passwordAccount = (connectionId: string): string =>
  secretAccount(connectionId, 'password');

/** Real keychain items, one per secret, named `RaSQL` / `rasql:<connection>:<kind>`. */
export class KeyringProvider implements CredentialProvider {
  readonly id = 'keychain';

  constructor(
    private readonly service: string,
    private readonly log: (line: string) => void,
  ) {}

  available(): boolean {
    try {
      const probe = new Entry(this.service, 'rasql:probe');
      probe.setPassword('probe');
      const ok = probe.getPassword() === 'probe';
      probe.deletePassword();
      return ok;
    } catch (err) {
      this.log(
        `[credentials] keychain unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  async get(account: string): Promise<string | null> {
    try {
      return new Entry(this.service, account).getPassword() ?? null;
    } catch (err) {
      this.log(
        `[credentials] read failed for ${account}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    new Entry(this.service, account).setPassword(secret);
  }

  async delete(account: string): Promise<void> {
    try {
      new Entry(this.service, account).deletePassword();
    } catch {
      /* not stored */
    }
  }
}

/** Encrypts with a key held by the OS and stores the ciphertext in the user data directory. */
export class SafeStorageProvider implements CredentialProvider {
  readonly id = 'safe-storage';
  private readonly file = join(app.getPath('userData'), 'secrets.json');
  private cache: Record<string, string> | null = null;

  available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.load(), null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  async get(account: string): Promise<string | null> {
    const blob = this.load()[account];
    if (!blob) return null;
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return null;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    if (!this.available()) {
      throw new Error('OS encryption is not available; refusing to store a secret in plain text');
    }
    this.load()[account] = safeStorage.encryptString(secret).toString('base64');
    this.persist();
  }

  async delete(account: string): Promise<void> {
    const all = this.load();
    if (account in all) {
      delete all[account];
      this.persist();
    }
  }
}

/** The keychain when it works, safeStorage otherwise. Call after `app` is ready. */
export function createCredentialProvider(log: (line: string) => void): CredentialProvider {
  const keyring = new KeyringProvider(KEYCHAIN_SERVICE, log);
  if (keyring.available()) {
    log('[credentials] using OS keychain items');
    return keyring;
  }
  log('[credentials] falling back to Electron safeStorage');
  return new SafeStorageProvider();
}
