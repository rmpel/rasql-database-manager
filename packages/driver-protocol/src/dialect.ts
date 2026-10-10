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
  | 'between'
  | 'not between'
  /** Substring match through LIKE with the user's text escaped; case follows the collation. */
  | 'contains'
  | 'not contains'
  | 'starts with'
  | 'ends with'
  /** Equal to the empty string. NULL is not empty; use 'is null' for that. */
  | 'is empty'
  | 'is not empty'
  /** Optional: drivers list them in DialectInfo.filterOperators when the engine supports them. */
  | 'regexp'
  | 'not regexp'
  /** A SET column has this member. */
  | 'has member';

/** The operators every driver built on the SDK supports. */
export const BASIC_FILTER_OPERATORS: readonly FilterOperator[] = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'like',
  'not like',
  'in',
  'not in',
  'is null',
  'is not null',
  'between',
  'not between',
  'contains',
  'not contains',
  'starts with',
  'ends with',
  'is empty',
  'is not empty',
];

export interface Filter {
  column: string;
  op: FilterOperator;
  /** One value; a list for 'in' and 'not in'; two values for 'between' and 'not between'. */
  value?: Value | Value[];
}

/** Filters joined with AND ('all') or OR ('any'), wrapped in parentheses. */
export interface FilterGroup {
  match: 'all' | 'any';
  filters: Filter[];
}

export type FilterNode = Filter | FilterGroup;

export const isFilterGroup = (f: FilterNode): f is FilterGroup =>
  Array.isArray((f as FilterGroup).filters);

export interface SelectOptions {
  columns?: string[];
  /** Joined with AND. A group joins its own filters with AND or OR. */
  where?: FilterNode[];
  /** Raw WHERE fragment typed by the user. Appended with AND. */
  whereSql?: string;
  orderBy?: { column: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

/**
 * One change to a table. Column positions: `after` absent keeps the place (or appends a new
 * column), null puts the column first, a name puts it after that column.
 * modifyColumn with a different `column.name` renames the column as well.
 */
export type StructureChange =
  | { kind: 'addColumn'; column: ColumnDefinition; after?: string | null }
  | { kind: 'dropColumn'; name: string }
  | { kind: 'modifyColumn'; name: string; column: ColumnDefinition; after?: string | null }
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
  /** A short plain-language note for the type picker, e.g. "whole numbers up to about 2 billion". */
  description?: string;
}

/** What a driver's buildAlter can do; the structure editor only offers these. */
export interface AlterCapabilities {
  addColumn: boolean;
  dropColumn: boolean;
  renameColumn: boolean;
  /** Change type, nullability, default, comment and so on, in place. */
  modifyColumn: boolean;
  moveColumn: boolean;
  indexes: boolean;
  primaryKey: boolean;
  foreignKeys: boolean;
  tableComment: boolean;
  columnComments: boolean;
  renameTable: boolean;
  /** Charset and collation per column. */
  collations: boolean;
}

export interface DialectInfo {
  id: string;
  identifierQuote: string;
  keywords: string[];
  types: TypeDescriptor[];
  /** The statement that selects the current time, for connection tests. */
  pingSql: string;
  /** Filter operators the driver can build. Absent means the classic set before 'contains'. */
  filterOperators?: FilterOperator[];
  /** Absent means the driver cannot alter tables. */
  alter?: AlterCapabilities;
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
