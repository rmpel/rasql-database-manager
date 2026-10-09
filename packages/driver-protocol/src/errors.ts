export type DriverErrorCode =
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'NOT_CONNECTED'
  | 'QUERY_FAILED'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'READ_ONLY_VIOLATION'
  | 'PROTOCOL_ERROR'
  | 'INTERNAL';

export interface SerializedError {
  code: DriverErrorCode | string;
  message: string;
  sqlState?: string;
  details?: Record<string, unknown>;
}

export class DriverError extends Error {
  readonly code: DriverErrorCode | string;
  readonly sqlState: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: DriverErrorCode | string,
    message: string,
    extra?: { sqlState?: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, extra?.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'DriverError';
    this.code = code;
    this.sqlState = extra?.sqlState;
    this.details = extra?.details;
  }

  toJSON(): SerializedError {
    const out: SerializedError = { code: this.code, message: this.message };
    if (this.sqlState !== undefined) out.sqlState = this.sqlState;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }

  static from(err: unknown): DriverError {
    if (err instanceof DriverError) return err;
    if (err instanceof Error) {
      if (err.name === 'AbortError')
        return new DriverError('CANCELLED', err.message, { cause: err });
      return new DriverError('INTERNAL', err.message, { cause: err });
    }
    return new DriverError('INTERNAL', String(err));
  }

  static deserialize(s: SerializedError): DriverError {
    const extra: { sqlState?: string; details?: Record<string, unknown> } = {};
    if (s.sqlState !== undefined) extra.sqlState = s.sqlState;
    if (s.details !== undefined) extra.details = s.details;
    return new DriverError(s.code, s.message, extra);
  }
}
