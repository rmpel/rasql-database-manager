import type { Driver, ResolvedEndpoint, Session } from '@rasql/driver-protocol';
import { manifest } from './manifest.js';
import { PostgresSession } from './session.js';

export { manifest };

export const postgresDriver: Driver = {
  manifest: () => manifest,
  connect(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<Session> {
    return PostgresSession.open(endpoint, signal);
  },
};

export { PostgresDialect, shortTypeName } from './dialect.js';
export { PostgresSession, clientConfig, triggerType, wrapError } from './session.js';
export { splitPostgres, type ScriptStatement } from './split.js';
export { parseDefault } from './defaults.js';
export { toParam, toValue, valueTypeOf, type PgType } from './values.js';
export default postgresDriver;
