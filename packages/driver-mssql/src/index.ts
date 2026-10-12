import type { Driver, ResolvedEndpoint, Session } from '@rasql/driver-protocol';
import { manifest } from './manifest.js';
import { MssqlSession } from './session.js';

export { manifest };

export const mssqlDriver: Driver = {
  manifest: () => manifest,
  connect(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<Session> {
    return MssqlSession.open(endpoint, signal);
  },
};

export { MssqlDialect, defaultName } from './dialect.js';
export { MssqlSession, connectionConfig, wrapError } from './session.js';
export { isReadOnlyBatch, splitBatches, type Batch } from './split.js';
export { parseDefault } from './defaults.js';
export { nativeTypeOf, toValue, valueTypeOf, type ColumnInfo } from './values.js';
export default mssqlDriver;
