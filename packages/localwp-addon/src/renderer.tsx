import React, { useEffect, useState } from 'react';
import { ipcAsync } from '@getflywheel/local/renderer';
import { IPC_OPEN, IPC_OPEN_RELEASES, IPC_STATUS } from './shared/url';

interface SiteLike {
  id: string;
  name: string;
}

interface Status {
  handler: string;
  installed: boolean;
}

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/**
 * Looks like Local's own TextButton. Local injects only react, react-dom and @getflywheel/local
 * into add-ons, so there is no UI library to import; the add-on ships without node_modules.
 */
const LinkButton = ({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.ReactElement => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    style={{
      background: 'none',
      border: 'none',
      padding: 0,
      margin: 0,
      font: 'inherit',
      fontWeight: 600,
      color: disabled ? '#9aa0ab' : '#51bb7b',
      cursor: disabled ? 'default' : 'pointer',
    }}
  >
    {children}
  </button>
);

/**
 * Sits in the Database tab's Connect row, just before Local's own "Open AdminNeo" button.
 * The button shows at once; the status call only decides whether it says "Open in RaSQL"
 * or "Get RaSQL", so a failure in the add-on's main side still leaves something clickable.
 */
const OpenInRasql = ({ site }: { site: SiteLike }): React.ReactElement => {
  const [status, setStatus] = useState<Status>({ handler: 'unknown', installed: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    withTimeout(ipcAsync(IPC_STATUS) as Promise<Status>, 3000)
      .then((s) => alive && s && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [site.id]);

  const open = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await withTimeout(ipcAsync(IPC_OPEN, site.id), 10_000);
    } catch (err) {
      setError(
        err instanceof Error && err.message !== 'timeout'
          ? err.message
          : 'The RaSQL add-on did not answer; check Local’s log.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 14 }}>
      {status.installed ? (
        <LinkButton onClick={() => void open()} disabled={busy}>
          Open in RaSQL
        </LinkButton>
      ) : (
        <LinkButton onClick={() => void ipcAsync(IPC_OPEN_RELEASES)}>Get RaSQL</LinkButton>
      )}
      {error && <span style={{ color: '#d43f3f', fontSize: 12 }}>{error}</span>}
    </span>
  );
};

interface RendererContext {
  hooks: {
    addContent(name: string, callback: (site: SiteLike) => React.ReactNode): void;
  };
}

export default function (context: RendererContext): void {
  context.hooks.addContent('SiteInfoDatabase_TableList_TableListRow[Connect]:Before', (site) => (
    <OpenInRasql key={`rasql-${site.id}`} site={site} />
  ));
}
