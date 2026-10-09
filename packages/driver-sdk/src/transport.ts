/** A bidirectional message channel. Messages must survive structured clone. */
export interface Transport {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  close(): void;
}

interface NodeMessagePortLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): unknown;
  off(event: 'message', listener: (value: unknown) => void): unknown;
  close(): void;
}

/** Node `MessagePort` from `node:worker_threads`, or anything shaped like it. */
export function nodeMessagePortTransport(port: NodeMessagePortLike): Transport {
  return {
    send: (m) => port.postMessage(m),
    onMessage: (listener) => {
      port.on('message', listener);
      return () => port.off('message', listener);
    },
    close: () => port.close(),
  };
}

interface ElectronParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  off(event: 'message', listener: (event: { data: unknown }) => void): unknown;
}

/** Inside an Electron utility process: `electronParentPortTransport(process.parentPort)`. */
export function electronParentPortTransport(parentPort: ElectronParentPortLike): Transport {
  return {
    send: (m) => parentPort.postMessage(m),
    onMessage: (listener) => {
      const wrapped = (e: { data: unknown }): void => listener(e.data);
      parentPort.on('message', wrapped);
      return () => parentPort.off('message', wrapped);
    },
    close: () => {
      /* the utility process ends when the host kills it */
    },
  };
}

interface ElectronUtilityProcessLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  kill(): boolean;
}

/** In the Electron main process, wrapping the child returned by `utilityProcess.fork`. */
export function electronUtilityProcessTransport(child: ElectronUtilityProcessLike): Transport {
  return {
    send: (m) => child.postMessage(m),
    onMessage: (listener) => {
      child.on('message', listener);
      return () => child.off('message', listener);
    },
    close: () => {
      child.kill();
    },
  };
}
