import { useEffect, useMemo, useState } from 'react';
import type { DriverManifest, FormField, Transport } from '@rasql/driver-protocol';
import type {
  ConnectionDefinition,
  Environment,
  PendingConnection,
  SshAuthMethod,
  SshHop,
} from '@shared/api';
import { ENVIRONMENT_COLORS } from '@shared/api';
import { rasql } from '../api';

const WELL_KNOWN = new Set([
  'host',
  'port',
  'socketPath',
  'filePath',
  'user',
  'password',
  'database',
]);
const ENVIRONMENTS: Environment[] = ['local', 'development', 'staging', 'production', 'other'];

export interface ConnectionFormValue {
  definition: ConnectionDefinition;
  password: string;
  savePassword: boolean;
  /** One-shot SSH secrets for the last hop. */
  sshPassword?: string;
  sshPassphrase?: string;
  saveSshSecrets?: boolean;
}

const SSH_AUTH_METHODS: { value: SshAuthMethod; label: string }[] = [
  { value: 'auto', label: 'Automatic (agent, keys, then password)' },
  { value: 'agent', label: 'SSH agent' },
  { value: 'key', label: 'Private key file' },
  { value: 'password', label: 'Password' },
];

interface Props {
  drivers: DriverManifest[];
  initial?: PendingConnection | ConnectionDefinition | null;
  onConnect: (value: ConnectionFormValue) => void;
  onSave: (value: ConnectionFormValue) => void;
  busy?: boolean;
  error?: string | null;
}

function emptyDefinition(driver: DriverManifest): ConnectionDefinition {
  const transport = driver.transports[0] as Transport;
  const def: ConnectionDefinition = {
    id: '',
    name: '',
    environment: 'local',
    readOnly: false,
    driver: driver.id,
    transport,
    options: {},
    credentials: {},
    createdAt: '',
    updatedAt: '',
  };
  if (transport === 'tcp') {
    def.host = '127.0.0.1';
    if (driver.defaultPort !== undefined) def.port = driver.defaultPort;
  }
  return def;
}

/** Renders the connect dialog from a driver manifest. Core fields first, driver fields after. */
export function ConnectionForm({
  drivers,
  initial,
  onConnect,
  onSave,
  busy,
  error,
}: Props): React.JSX.Element {
  const [def, setDef] = useState<ConnectionDefinition>(() => {
    const first = drivers[0] as DriverManifest;
    if (!initial) return emptyDefinition(first);
    const base = 'definition' in initial ? initial.definition : initial;
    const driver = drivers.find((d) => d.id === base.driver) ?? first;
    return { ...emptyDefinition(driver), ...base } as ConnectionDefinition;
  });
  const [password, setPassword] = useState(() =>
    initial && 'password' in initial ? (initial.password ?? '') : '',
  );
  const [savePassword, setSavePassword] = useState(true);
  const [sshPassword, setSshPassword] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [saveSshSecrets, setSaveSshSecrets] = useState(true);
  const [sshAliases, setSshAliases] = useState<string[]>([]);

  useEffect(() => {
    rasql.ssh
      .aliases()
      .then(setSshAliases)
      .catch(() => setSshAliases([]));
  }, []);

  // The SSH section edits the last hop; an optional jump host is the hop before it.
  const sshHops = def.ssh ?? [];
  const sshEnabled = sshHops.length > 0;
  const sshHop: SshHop = sshHops[sshHops.length - 1] ?? { host: '' };
  const jumpHop: SshHop | undefined = sshHops.length > 1 ? sshHops[0] : undefined;
  const setSsh = (hop: SshHop | null, jump: SshHop | null | undefined = jumpHop): void =>
    setDef((d) => {
      if (!hop) {
        const { ssh: _dropped, ...rest } = d;
        return rest as ConnectionDefinition;
      }
      return { ...d, ssh: jump ? [jump, hop] : [hop] };
    });
  const updateHop = <K extends keyof SshHop>(key: K, value: SshHop[K] | undefined): void => {
    const next: SshHop = { ...sshHop };
    if (value === undefined || value === '') delete next[key];
    else next[key] = value;
    setSsh(next);
  };
  const setJump = (spec: string): void => {
    const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(spec.trim());
    if (!spec.trim() || !m) return setSsh(sshHop, null);
    const jump: SshHop = { host: m[2] as string };
    if (m[1]) jump.user = m[1];
    if (m[3]) jump.port = Number(m[3]);
    setSsh(sshHop, jump);
  };
  const pickKey = async (): Promise<void> => {
    const path = await rasql.dialog.openFile({ title: 'Choose a private key' });
    if (path) updateHop('keyPath', path);
  };
  const sshAuth = sshHop.auth ?? 'auto';
  const showsKey = sshAuth === 'auto' || sshAuth === 'key';
  const showsPassword = sshAuth === 'auto' || sshAuth === 'password';

  const driver = useMemo(
    () => drivers.find((d) => d.id === def.driver) ?? (drivers[0] as DriverManifest),
    [drivers, def.driver],
  );

  const changeDriver = (id: string): void => {
    const next = drivers.find((d) => d.id === id);
    if (!next) return;
    setDef((d) => {
      const out: ConnectionDefinition = {
        ...d,
        driver: id,
        transport: next.transports.includes(d.transport)
          ? d.transport
          : (next.transports[0] as Transport),
      };
      if (out.transport === 'tcp' && out.port === undefined && next.defaultPort !== undefined) {
        out.port = next.defaultPort;
      }
      return out;
    });
  };

  const update = <K extends keyof ConnectionDefinition>(
    key: K,
    value: ConnectionDefinition[K],
  ): void => setDef((d) => ({ ...d, [key]: value }));
  const updateOption = (key: string, value: unknown): void =>
    setDef((d) => ({ ...d, options: { ...d.options, [key]: value } }));

  const driverFields = driver.connectionForm.fields.filter(
    (f) => !WELL_KNOWN.has(f.key) && (!f.transports || f.transports.includes(def.transport)),
  );
  const fileField = driver.connectionForm.fields.find((f) => f.key === 'filePath');

  const pickFile = async (): Promise<void> => {
    const path = await rasql.dialog.openFile({
      title: 'Open database file',
      extensions: driver.fileExtensions ?? fileField?.extensions ?? [],
    });
    if (path) {
      update('filePath', path);
      if (!def.name) update('name', path.split('/').pop() ?? path);
    }
  };

  const value = (): ConnectionFormValue => {
    const out: ConnectionFormValue = {
      definition: { ...def, name: def.name || defaultName(def) },
      password,
      savePassword,
      saveSshSecrets,
    };
    if (sshEnabled && sshPassword) out.sshPassword = sshPassword;
    if (sshEnabled && sshPassphrase) out.sshPassphrase = sshPassphrase;
    return out;
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    onConnect(value());
  };

  const needsCredentials = def.transport !== 'file';

  return (
    <form className="connection-form" onSubmit={submit}>
      <div className="form-row">
        <label>
          Name
          <input
            value={def.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder={defaultName(def)}
          />
        </label>
        <label>
          Environment
          <select
            value={def.environment}
            onChange={(e) => update('environment', e.target.value as Environment)}
          >
            {ENVIRONMENTS.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
        </label>
        <span
          className="env-swatch"
          style={{ background: def.color ?? ENVIRONMENT_COLORS[def.environment] }}
        />
      </div>

      <div className="form-row">
        <label>
          Driver
          <select value={def.driver} onChange={(e) => changeDriver(e.target.value)}>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {driver.transports.length > 1 && (
          <label>
            Connect via
            <select
              value={def.transport}
              onChange={(e) => update('transport', e.target.value as Transport)}
            >
              {driver.transports.map((t) => (
                <option key={t} value={t}>
                  {t === 'tcp' ? 'TCP/IP' : t === 'socket' ? 'Unix socket' : 'File'}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {def.transport === 'tcp' && (
        <div className="form-row">
          <label className="grow">
            Host
            <input value={def.host ?? ''} onChange={(e) => update('host', e.target.value)} />
          </label>
          <label className="narrow">
            Port
            <input
              type="number"
              value={def.port ?? ''}
              onChange={(e) =>
                update('port', e.target.value === '' ? undefined : Number(e.target.value))
              }
            />
          </label>
        </div>
      )}
      {def.transport === 'socket' && (
        <div className="form-row">
          <label className="grow">
            Socket path
            <input
              value={def.socketPath ?? ''}
              onChange={(e) => update('socketPath', e.target.value)}
              placeholder="/tmp/mysql.sock"
            />
          </label>
        </div>
      )}
      {def.transport === 'file' && (
        <div className="form-row">
          <label className="grow">
            {fileField?.label ?? 'File'}
            <span className="with-button">
              <input
                value={def.filePath ?? ''}
                onChange={(e) => update('filePath', e.target.value)}
                placeholder=":memory:"
              />
              <button type="button" onClick={() => void pickFile()}>
                Browse…
              </button>
            </span>
          </label>
        </div>
      )}

      {needsCredentials && (
        <>
          <div className="form-row">
            <label>
              User
              <input
                value={def.user ?? ''}
                onChange={(e) => update('user', e.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              Database
              <input
                value={def.database ?? ''}
                onChange={(e) => update('database', e.target.value)}
              />
            </label>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={savePassword}
              onChange={(e) => setSavePassword(e.target.checked)}
            />
            Remember password in the system keychain
          </label>
        </>
      )}

      {needsCredentials && (
        <fieldset className="ssh-section">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={sshEnabled}
              onChange={(e) => setSsh(e.target.checked ? { host: '' } : null, null)}
            />
            Connect through SSH
          </label>
          {sshEnabled && (
            <>
              <div className="form-row">
                <label className="grow">
                  SSH host
                  <input
                    list="ssh-aliases"
                    value={sshHop.host}
                    onChange={(e) => updateHop('host', e.target.value)}
                    placeholder="bastion.example.com or a ~/.ssh/config alias"
                  />
                  <datalist id="ssh-aliases">
                    {sshAliases.map((a) => (
                      <option key={a} value={a} />
                    ))}
                  </datalist>
                </label>
                <label className="narrow">
                  SSH port
                  <input
                    type="number"
                    value={sshHop.port ?? ''}
                    placeholder="22"
                    onChange={(e) =>
                      updateHop('port', e.target.value === '' ? undefined : Number(e.target.value))
                    }
                  />
                </label>
                <label>
                  SSH user
                  <input
                    value={sshHop.user ?? ''}
                    placeholder="from config or your login"
                    onChange={(e) => updateHop('user', e.target.value)}
                    autoComplete="off"
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  SSH authentication
                  <select
                    value={sshAuth}
                    onChange={(e) => updateHop('auth', e.target.value as SshAuthMethod)}
                  >
                    {SSH_AUTH_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                {showsKey && (
                  <label className="grow">
                    Private key
                    <span className="with-button">
                      <input
                        value={sshHop.keyPath ?? ''}
                        placeholder="~/.ssh/id_ed25519 and config IdentityFile entries"
                        onChange={(e) => updateHop('keyPath', e.target.value)}
                      />
                      <button type="button" onClick={() => void pickKey()}>
                        Browse…
                      </button>
                    </span>
                  </label>
                )}
              </div>
              <div className="form-row">
                {showsKey && (
                  <label>
                    Key passphrase
                    <input
                      type="password"
                      value={sshPassphrase}
                      onChange={(e) => setSshPassphrase(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                )}
                {showsPassword && (
                  <label>
                    SSH password
                    <input
                      type="password"
                      value={sshPassword}
                      onChange={(e) => setSshPassword(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                )}
                <label className="grow">
                  Jump host (optional)
                  <input
                    defaultValue={
                      jumpHop
                        ? `${jumpHop.user ? `${jumpHop.user}@` : ''}${jumpHop.host}${jumpHop.port ? `:${jumpHop.port}` : ''}`
                        : ''
                    }
                    placeholder="user@bastion:22, or leave empty to use ProxyJump from config"
                    onBlur={(e) => setJump(e.target.value)}
                  />
                </label>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={saveSshSecrets}
                  onChange={(e) => setSaveSshSecrets(e.target.checked)}
                />
                Remember SSH password and passphrase in the system keychain
              </label>
            </>
          )}
        </fieldset>
      )}

      {driverFields.map((f) => (
        <DriverField
          key={f.key}
          field={f}
          value={def.options[f.key]}
          onChange={(v) => updateOption(f.key, v)}
        />
      ))}

      <label className="checkbox">
        <input
          type="checkbox"
          checked={def.readOnly}
          onChange={(e) => update('readOnly', e.target.checked)}
        />
        Open read-only
      </label>

      {error && <div className="form-error">{error}</div>}

      <div className="form-actions">
        <button type="button" onClick={() => onSave(value())} disabled={busy}>
          Save
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}

function DriverField({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
}): React.JSX.Element {
  switch (field.kind) {
    case 'checkbox':
      return (
        <label className="checkbox" title={field.help}>
          <input
            type="checkbox"
            checked={Boolean(value ?? field.default ?? false)}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.label}
        </label>
      );
    case 'select':
      return (
        <label title={field.help}>
          {field.label}
          <select
            value={String(value ?? field.default ?? '')}
            onChange={(e) => onChange(e.target.value)}
          >
            {(field.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    case 'number':
      return (
        <label title={field.help}>
          {field.label}
          <input
            type="number"
            value={value === undefined ? String(field.default ?? '') : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </label>
      );
    default:
      return (
        <label title={field.help}>
          {field.label}
          <input
            type={field.kind === 'password' ? 'password' : 'text'}
            value={String(value ?? field.default ?? '')}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
  }
}

function defaultName(def: ConnectionDefinition): string {
  if (def.transport === 'file') return def.filePath?.split('/').pop() ?? 'SQLite';
  const target =
    def.transport === 'socket'
      ? (def.socketPath ?? 'socket')
      : `${def.host ?? ''}${def.port ? `:${def.port}` : ''}`;
  return `${def.user ? `${def.user}@` : ''}${target}${def.database ? `/${def.database}` : ''}`;
}
