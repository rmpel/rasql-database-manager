import type { Value, ValueType } from './values.js';

export interface ServerInfo {
  /** Engine id from the driver manifest, e.g. "mysql", "mariadb". */
  engine: string;
  engineName: string;
  version: string;
  versionComment?: string;
  charset?: string;
  collation?: string;
  timezone?: string;
  readOnly: boolean;
  currentSchema?: string;
  user?: string;
  extra?: Record<string, string>;
}

export interface SchemaInfo {
  name: string;
  charset?: string;
  collation?: string;
  isSystem?: boolean;
  isCurrent?: boolean;
}

export type DbObjectKind = 'table' | 'view' | 'routine' | 'trigger' | 'event' | 'sequence';

export interface DbObject {
  kind: DbObjectKind;
  schema: string;
  name: string;
  comment?: string;
  rowEstimate?: number;
  engine?: string;
  dataLength?: number;
  indexLength?: number;
  /** For routines: 'function' | 'procedure'. For triggers: timing and event. Free-form per driver. */
  extra?: Record<string, string>;
}

export type ColumnDefault = Value | { t: 'expression'; sql: string };

export interface ColumnDefinition {
  name: string;
  ordinal: number;
  nativeType: string;
  valueType: ValueType;
  nullable: boolean;
  default?: ColumnDefault;
  autoIncrement: boolean;
  charset?: string;
  collation?: string;
  comment?: string;
  /** Engine specific flags such as "on update CURRENT_TIMESTAMP". */
  extra?: string;
  generated?: { expression: string; stored: boolean };
}

export interface IndexColumn {
  name?: string;
  expression?: string;
  order?: 'asc' | 'desc';
  length?: number;
}

export interface IndexDefinition {
  name: string;
  unique: boolean;
  primary: boolean;
  type?: string;
  columns: IndexColumn[];
  comment?: string;
}

export interface ForeignKeyDefinition {
  name: string;
  columns: string[];
  referencedSchema?: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate?: string;
  onDelete?: string;
}

export interface TableDefinition {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: ColumnDefinition[];
  indexes: IndexDefinition[];
  foreignKeys: ForeignKeyDefinition[];
  primaryKey?: string[];
  options: Record<string, string>;
  comment?: string;
  /** The CREATE statement as the engine prints it. */
  ddl?: string;
  rowEstimate?: number;
}

/** Metadata for one column of a result set. */
export interface ColumnMeta {
  name: string;
  nativeType: string;
  valueType: ValueType;
  nullable: boolean;
  charset?: string;
  schema?: string;
  table?: string;
  /** Column name in the table when the result column is aliased. */
  originalName?: string;
  isPrimaryKey: boolean;
  foreignKey?: { schema?: string; table: string; column: string };
}
