import { MessageChannel } from 'node:worker_threads';
import type { Transport } from './transport.js';
import { nodeMessagePortTransport } from './transport.js';

/**
 * Two connected transports in one process. Messages still go through structured clone,
 * so this exercises serialization exactly like a real process boundary.
 */
export function createInProcessTransports(): { host: Transport; driver: Transport } {
  const channel = new MessageChannel();
  const host = nodeMessagePortTransport(channel.port1);
  const driver = nodeMessagePortTransport(channel.port2);
  // Do not keep the event loop alive just because the ports exist.
  channel.port1.unref();
  channel.port2.unref();
  return { host, driver };
}
