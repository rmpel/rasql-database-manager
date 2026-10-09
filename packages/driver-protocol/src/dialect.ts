import type { Value } from './values.js';
import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  TableDefinition,
} from './schema.js';

export type StatementClass = 'read' | 'write' | 'ddl' | 'admin' | 'transaction' | 'unknown';

export interface TableRef {
  schema?: string;
  name: string;
}

export interface CellChange {
  column: string;
  oldValue?: Value;
  newValue: Value;
}

/** Identifies one row. Normally the primary key columns; all columns when there is none. */
export type KeyMatch = { column: string; value: Value }[];

export type FilterOperator =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'like'
  | 'not like'
  | 'in'
  | 'not in'
  | 'is null'
  | 'is not null'
  | 'between';

export interface Filter {
  column: string;
  op: FilterOperator;
  value?: Value | Value[];
}

export interface SelectOptions {
  columns?: string[];
  where?: Filter[];
  /** Raw WHERE fragment typed by the user. Appended with AND. */
  whereSql?: string;
  orderBy?: { column: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

export type StructureChange =
  | { kind: 'addColumn'; column: ColumnDefinition; after?: string | null }
  | { kind: 'dropColumn'; name: string }
  | { kind: 'modifyColumn'; name: string; column: ColumnDefinition }
  | { kind: 'renameColumn'; from: string; to: string }
  | { kind: 'addIndex'; index: IndexDefinition }
  | { kind: 'dropIndex'; name: string }
  | { kind: 'addForeignKey'; foreignKey: ForeignKeyDefinition }
  | { kind: 'dropForeignKey'; name: string }
  | { kind: 'renameTable'; to: string }
  | { kind: 'setOption'; name: string; value: string }
  | { kind: 'setComment'; comment: string };

export type TypeCategory =
  | 'integer'
  | 'decimal'
  | 'float'
  | 'text'
  | 'binary'
  | 'date'
  | 'time'
  | 'datetime'
  | 'boolean'
  | 'json'
  | 'enum'
  | 'set'
  | 'bit'
  | 'spatial'
  | 'other';

export interface TypeDescriptor {
  name: string;
  category: TypeCategory;
  hasLength?: boolean;
  hasPrecision?: boolean;
  hasScale?: boolean;
  hasValues?: boolean;
  unsignedAllowed?: boolean;
}

export interface DialectInfo {
  id: string;
  identifierQuote: string;
  keywords: string[];
  types: TypeDescriptor[];
  /** The statement that selects the current time, for connection tests. */
  pingSql: string;
}

/**
 * How the core asks a driver to build SQL. Implemented synchronously inside the driver;
 * the SDK exposes it over the protocol, so the core sees every method as async.
 */
export interface Dialect {
  describe(): DialectInfo;
  quoteIdentifier(name: string): string;
  quoteLiteral(v: Value): string;
  buildSelect(table: TableRef, opts: SelectOptions): string;
  buildCount(table: TableRef, opts: Pick<SelectOptions, 'where' | 'whereSql'>): string;
  buildUpdate(table: TableRef, set: CellChange[], where: KeyMatch): string;
  buildInsert(table: TableRef, row: CellChange[]): string;
  /** One multi-row INSERT for export and bulk paste. Rows are positional against `columns`. */
  buildInsertMany(table: TableRef, columns: string[], rows: Value[][]): string;
  buildDelete(table: TableRef, where: KeyMatch): string;
  buildAlter?(table: TableDefinition, changes: StructureChange[]): string[];
  classify(sql: string): StatementClass;
}

export type Asyncified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};

/** The dialect as the core sees it: every method crosses the process boundary. */
export type RemoteDialect = Asyncified<Required<Dialect>>;
