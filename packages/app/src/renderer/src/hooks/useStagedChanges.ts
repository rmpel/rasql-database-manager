import { useCallback, useMemo, useState } from 'react';
import {
  valueEquals,
  type CellChange,
  type ColumnMeta,
  type KeyMatch,
  type TableDefinition,
  type Value,
} from '@rasql/driver-protocol';
import { V } from '@rasql/driver-protocol';
import { rasql } from '../api';

/** Points at a loaded row (by index) or a row staged for insertion (by id). */
export type RowRef = { kind: 'row'; index: number } | { kind: 'insert'; id: number };

export interface InsertRow {
  id: number;
  /** Per column; null means "leave to the database default". */
  values: (Value | null)[];
}

export interface StagedChanges {
  edits: Map<number, Map<number, Value>>;
  deletes: Set<number>;
  inserts: InsertRow[];
}

export interface StagedApi {
  staged: StagedChanges;
  count: number;
  editAt(ref: RowRef, col: number): Value | null | undefined;
  isDeleted(index: number): boolean;
  stageEdit(ref: RowRef, col: number, value: Value, original: Value | undefined): void;
  toggleDelete(index: number): void;
  addRow(columnCount: number): number;
  removeInsert(id: number): void;
  discard(): void;
  /** Build the statements in a deterministic order: deletes, updates, inserts. */
  buildStatements(ctx: BuildContext): Promise<string[]>;
}

export interface BuildContext {
  sessionKey: string;
  schema: string;
  table: string;
  columns: ColumnMeta[];
  rows: Value[][];
  definition: TableDefinition | null;
}

const empty = (): StagedChanges => ({ edits: new Map(), deletes: new Set(), inserts: [] });

/** Which columns identify a row, and whether that identification is trustworthy. */
export function keyColumnsFor(
  columns: ColumnMeta[],
  definition: TableDefinition | null,
): { names: string[]; reliable: boolean } {
  const present = new Set(columns.map((c) => c.originalName ?? c.name));
  const pk = definition?.primaryKey?.filter((c) => present.has(c)) ?? [];
  if (pk.length && pk.length === (definition?.primaryKey?.length ?? 0))
    return { names: pk, reliable: true };
  const unique = definition?.indexes.find(
    (i) => i.unique && i.columns.every((c) => c.name && present.has(c.name)),
  );
  if (unique) return { names: unique.columns.map((c) => c.name as string), reliable: true };
  return { names: columns.map((c) => c.originalName ?? c.name), reliable: false };
}

export function useStagedChanges(): StagedApi {
  const [staged, setStaged] = useState<StagedChanges>(empty);
  const [nextInsertId, setNextInsertId] = useState(1);

  const count = useMemo(
    () =>
      [...staged.edits.values()].reduce((n, m) => n + m.size, 0) +
      staged.deletes.size +
      staged.inserts.length,
    [staged],
  );

  const editAt = useCallback(
    (ref: RowRef, col: number): Value | null | undefined => {
      if (ref.kind === 'row') return staged.edits.get(ref.index)?.get(col);
      return staged.inserts.find((i) => i.id === ref.id)?.values[col];
    },
    [staged],
  );

  const isDeleted = useCallback((index: number) => staged.deletes.has(index), [staged]);

  const stageEdit = useCallback(
    (ref: RowRef, col: number, value: Value, original: Value | undefined) => {
      setStaged((s) => {
        if (ref.kind === 'insert') {
          return {
            ...s,
            inserts: s.inserts.map((i) =>
              i.id === ref.id
                ? { ...i, values: i.values.map((v, c) => (c === col ? value : v)) }
                : i,
            ),
          };
        }
        const edits = new Map(s.edits);
        const row = new Map(edits.get(ref.index) ?? []);
        if (original && valueEquals(original, value)) row.delete(col);
        else row.set(col, value);
        if (row.size) edits.set(ref.index, row);
        else edits.delete(ref.index);
        return { ...s, edits };
      });
    },
    [],
  );

  const toggleDelete = useCallback((index: number) => {
    setStaged((s) => {
      const deletes = new Set(s.deletes);
      if (deletes.has(index)) deletes.delete(index);
      else deletes.add(index);
      return { ...s, deletes };
    });
  }, []);

  const addRow = useCallback(
    (columnCount: number): number => {
      const id = nextInsertId;
      setNextInsertId(id + 1);
      setStaged((s) => ({
        ...s,
        inserts: [...s.inserts, { id, values: Array.from({ length: columnCount }, () => null) }],
      }));
      return id;
    },
    [nextInsertId],
  );

  const removeInsert = useCallback((id: number) => {
    setStaged((s) => ({ ...s, inserts: s.inserts.filter((i) => i.id !== id) }));
  }, []);

  const discard = useCallback(() => setStaged(empty()), []);

  const buildStatements = useCallback(
    async (ctx: BuildContext): Promise<string[]> => {
      const table = { schema: ctx.schema, name: ctx.table };
      const colName = (c: number): string =>
        ctx.columns[c]?.originalName ?? ctx.columns[c]?.name ?? `col${c}`;
      const { names: keyNames } = keyColumnsFor(ctx.columns, ctx.definition);
      const keyFor = (rowIndex: number): KeyMatch => {
        const row = ctx.rows[rowIndex];
        if (!row) throw new Error(`Row ${rowIndex} is not loaded`);
        return keyNames.map((name) => {
          const c = ctx.columns.findIndex((m) => (m.originalName ?? m.name) === name);
          return { column: name, value: row[c] ?? V.null() };
        });
      };
      const dialect = (
        method: 'buildUpdate' | 'buildInsert' | 'buildDelete',
        args: unknown[],
      ): Promise<string> => rasql.session.dialect(ctx.sessionKey, method, args) as Promise<string>;

      const out: string[] = [];
      for (const index of [...staged.deletes].sort((a, b) => a - b))
        out.push(await dialect('buildDelete', [table, keyFor(index)]));
      for (const [index, cols] of [...staged.edits.entries()].sort((a, b) => a[0] - b[0])) {
        if (staged.deletes.has(index)) continue;
        const set: CellChange[] = [...cols.entries()].map(([c, newValue]) => {
          const change: CellChange = { column: colName(c), newValue };
          const old = ctx.rows[index]?.[c];
          if (old) change.oldValue = old;
          return change;
        });
        out.push(await dialect('buildUpdate', [table, set, keyFor(index)]));
      }
      for (const ins of staged.inserts) {
        const row: CellChange[] = [];
        ins.values.forEach((v, c) => {
          if (v !== null) row.push({ column: colName(c), newValue: v });
        });
        out.push(await dialect('buildInsert', [table, row]));
      }
      return out;
    },
    [staged],
  );

  return {
    staged,
    count,
    editAt,
    isDeleted,
    stageEdit,
    toggleDelete,
    addRow,
    removeInsert,
    discard,
    buildStatements,
  };
}
