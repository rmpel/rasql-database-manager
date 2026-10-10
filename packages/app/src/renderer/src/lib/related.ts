import type { Filter, ForeignKeyDefinition, TableDefinition, Value } from '@rasql/driver-protocol';
import { rasql } from '../api';

export interface TableRef {
  schema: string;
  name: string;
}

/** A foreign key on another table that points at the given table. */
export interface IncomingReference {
  table: TableRef;
  foreignKey: ForeignKeyDefinition;
}

const cache = new Map<string, Promise<IncomingReference[]>>();

/**
 * Every foreign key in the schema that references `target`. Built from the drivers' table
 * definitions and cached per session and schema; refresh clears it.
 */
export function referencingTables(
  sessionKey: string,
  target: TableRef,
): Promise<IncomingReference[]> {
  const key = `${sessionKey}:${target.schema}`;
  let all = cache.get(key);
  if (!all) {
    all = (async () => {
      const objects = await rasql.session.listObjects(sessionKey, target.schema);
      const defs = await Promise.all(
        objects
          .filter((o) => o.kind === 'table')
          .map((o) => rasql.session.describeTable(sessionKey, o.schema, o.name).catch(() => null)),
      );
      const refs: IncomingReference[] = [];
      for (const def of defs) {
        if (!def) continue;
        for (const fk of def.foreignKeys)
          refs.push({ table: { schema: def.schema, name: def.name }, foreignKey: fk });
      }
      return refs;
    })();
    cache.set(key, all);
  }
  return all.then((refs) =>
    refs.filter(
      (r) =>
        r.foreignKey.referencedTable === target.name &&
        (r.foreignKey.referencedSchema ?? r.table.schema) === target.schema,
    ),
  );
}

export function forgetReferences(sessionKey: string, schema: string): void {
  cache.delete(`${sessionKey}:${schema}`);
}

/** Filters that select the row(s) a foreign key points at, given the referencing row's values. */
export function filtersForTarget(
  fk: ForeignKeyDefinition,
  valueOf: (column: string) => Value | undefined,
): Filter[] {
  return fk.columns.map((col, i) => toFilter(fk.referencedColumns[i] as string, valueOf(col)));
}

/** Filters that select the rows on the referencing table that point at the given row. */
export function filtersForSource(
  fk: ForeignKeyDefinition,
  valueOf: (column: string) => Value | undefined,
): Filter[] {
  return fk.columns.map((col, i) => toFilter(col, valueOf(fk.referencedColumns[i] as string)));
}

function toFilter(column: string, value: Value | undefined): Filter {
  if (!value || value.t === 'null') return { column, op: 'is null' };
  return { column, op: '=', value };
}

/** Columns of a table definition's foreign keys, by the column name on the referencing side. */
export function foreignKeyByColumn(def: TableDefinition | null): Map<string, ForeignKeyDefinition> {
  const map = new Map<string, ForeignKeyDefinition>();
  for (const fk of def?.foreignKeys ?? []) for (const col of fk.columns) map.set(col, fk);
  return map;
}
