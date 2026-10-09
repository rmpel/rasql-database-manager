import { useEffect, useState } from 'react';
import type { DriverManifest } from '@rasql/driver-protocol';
import type { ConnectionDefinition, OpenSessionResult, PendingConnection } from '@shared/api';
import { rasql } from './api';
import { Launcher } from './components/Launcher';
import { Workspace } from './components/Workspace';

type Mode =
  | { kind: 'launcher' }
  | { kind: 'workspace'; definition: ConnectionDefinition; session: OpenSessionResult };

export function App(): React.JSX.Element {
  const [drivers, setDrivers] = useState<DriverManifest[] | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'launcher' });
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
        setMode({ kind: 'launcher' });
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

  if (mode.kind === 'workspace') {
    return (
      <Workspace
        definition={mode.definition}
        session={mode.session}
        onDisconnect={() => setMode({ kind: 'launcher' })}
      />
    );
  }

  return (
    <Launcher
      drivers={drivers}
      pending={pending}
      onPending={setPending}
      onOpened={(definition, session) => {
        setPending(null);
        setMode({ kind: 'workspace', definition, session });
      }}
    />
  );
}
