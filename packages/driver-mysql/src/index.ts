import type { Driver, ResolvedEndpoint, Session } from '@rasql/driver-protocol';
import { manifest } from './manifest.js';
import { MysqlSession } from './session.js';

export { manifest };

export const mysqlDriver: Driver = {
  manifest: () => manifest,
  connect(endpoint: ResolvedEndpoint, signal?: AbortSignal): Promise<Session> {
    return MysqlSession.open(endpoint, signal);
  },
};

export { MysqlDialect } from './dialect.js';
export { MysqlSession, connectionOptions, errorPosition, wrapError } from './session.js';
export { detectFlavor, type Flavor, type MysqlEngine } from './flavor.js';
export {
  charsetFamily,
  dataTypeToValueType,
  fieldValueType,
  toParam,
  toValue,
  FLAG,
  T,
} from './values.js';
export default mysqlDriver;
