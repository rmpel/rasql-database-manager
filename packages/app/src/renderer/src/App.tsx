import { useEffect, useState } from 'react';
import type { DriverManifest, ServerInfo } from '@rasql/driver-protocol';
import type { ConnectionDefinition, PendingConnection } from '@shared/api';
import { rasql } from './api';
import { Launcher } from './components/Launcher';
import { Workspace } from './components/Workspace';

/** The main process tells a window its role through the URL hash. */
type Route = { kind: 'launcher' } | { kind: 'connection'; sessionKey: string };

function routeFromHash(): Route {
  const m = /^#connection\/(.+)$/.exec(window.location.hash);
  return m ? { kind: 'connection', sessionKey: m[1] as string } : { kind: 'launcher' };
}

export function App(): React.JSX.Element {
  const [route] = useState<Route>(routeFromHash);
  return route.kind === 'connection' ? (
    <ConnectionWindow sessionKey={route.sessionKey} />
  ) : (
    <LauncherWindow />
  );
}

/** The connection manager: saved connections, Local sites, the form. Lives as long as the user keeps it. */
function LauncherWindow(): React.JSX.Element {
  const [drivers, setDrivers] = useState<DriverManifest[] | null>(null);
  const [pending, setPending] = useState<PendingConnection | null>(null);

  useEffect(() => {
    void rasql.drivers.list().then(setDrivers);
    void rasql.app.takePendingConnection().then((p) => {
      if (p) setPending(p);
    });
    return rasql.app.onPendingConnection(setPending);
  }, []);

  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault();
    const drop = (e: DragEvent): void => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      // Electron exposes the path on File objects dropped into the window.
      const path = file ? (file as File & { path?: string }).path : undefined;
      if (path) {
        setPending({
          definition: {
            driver: 'sqlite',
            transport: 'file',
            filePath: path,
            name: file?.name ?? path,
          },
          autoConnect: true,
        });
      }
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (!drivers) return <div className="hint centered">Loading drivers…</div>;

  return (
    <Launcher
      drivers={drivers}
      pending={pending}
      onPending={setPending}
      // The session now lives in its own window; the manager just clears what it was doing.
      onOpened={() => setPending(null)}
    />
  );
}

/** One open session. The main process created this window for it and knows everything about it. */
function ConnectionWindow({ sessionKey }: { sessionKey: string }): React.JSX.Element {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | {
        kind: 'ready';
        definition: ConnectionDefinition;
        info: ServerInfo;
        manifest: DriverManifest;
      }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  useEffect(() => {
    rasql.session
      .describe(sessionKey)
      .then((d) => setState({ kind: 'ready', ...d }))
      .catch((err: unknown) =>
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  }, [sessionKey]);

  if (state.kind === 'loading') return <div className="hint centered">Connecting…</div>;
  if (state.kind === 'error') return <div className="hint centered error">{state.message}</div>;
  return (
    <Workspace
      definition={state.definition}
      session={{ sessionKey, info: state.info, manifest: state.manifest }}
      onDisconnect={() => void rasql.app.closeWindow()}
    />
  );
}
