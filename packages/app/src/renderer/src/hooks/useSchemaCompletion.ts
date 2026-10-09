import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { rasql } from '../api';

interface SchemaCache {
  /** Schema name -> table/view names, loaded once per schema. */
  objects: Map<string, string[]>;
  /** "schema.table" -> column names, loaded lazily. */
  columns: Map<string, string[]>;
  /** In-flight loads so a burst of keystrokes shares one request. */
  pending: Map<string, Promise<unknown>>;
  schemas: string[];
  current: string | null;
}

const WORD = /[\w$]+$/;

/**
 * Schema-aware completion for the SQL editor. Tables of the current schema load once; columns
 * load the first time a table is mentioned. Everything is cached per session, nothing is
 * fetched per keystroke beyond the first time a name appears.
 */
export function useSchemaCompletion(sessionKey: string): {
  source: (ctx: CompletionContext) => Promise<CompletionResult | null>;
  refresh: () => void;
} {
  const cache = useRef<SchemaCache>({
    objects: new Map(),
    columns: new Map(),
    pending: new Map(),
    schemas: [],
    current: null,
  });

  const loadSchemas = useCallback(async (): Promise<void> => {
    const c = cache.current;
    if (c.current) return;
    const key = '$schemas';
    if (!c.pending.has(key)) {
      c.pending.set(
        key,
        rasql.session
          .listSchemas(sessionKey)
          .then((list) => {
            c.schemas = list.map((s) => s.name);
            const cur = list.find((s) => s.isCurrent) ?? list.find((s) => !s.isSystem) ?? list[0];
            c.current = cur?.name ?? null;
          })
          .catch(() => undefined)
          .finally(() => c.pending.delete(key)),
      );
    }
    await c.pending.get(key);
  }, [sessionKey]);

  const loadObjects = useCallback(
    async (schema: string): Promise<string[]> => {
      const c = cache.current;
      const have = c.objects.get(schema);
      if (have) return have;
      const key = `objects:${schema}`;
      if (!c.pending.has(key)) {
        c.pending.set(
          key,
          rasql.session
            .listObjects(sessionKey, schema)
            .then((objs) => {
              c.objects.set(
                schema,
                objs.filter((o) => o.kind === 'table' || o.kind === 'view').map((o) => o.name),
              );
            })
            .catch(() => c.objects.set(schema, []))
            .finally(() => c.pending.delete(key)),
        );
      }
      await c.pending.get(key);
      return c.objects.get(schema) ?? [];
    },
    [sessionKey],
  );

  const loadColumns = useCallback(
    async (schema: string, table: string): Promise<string[]> => {
      const c = cache.current;
      const key = `${schema}.${table}`;
      const have = c.columns.get(key);
      if (have) return have;
      if (!c.pending.has(key)) {
        c.pending.set(
          key,
          rasql.session
            .describeTable(sessionKey, schema, table)
            .then((def) =>
              c.columns.set(
                key,
                def.columns.map((col) => col.name),
              ),
            )
            .catch(() => c.columns.set(key, []))
            .finally(() => c.pending.delete(key)),
        );
      }
      await c.pending.get(key);
      return c.columns.get(key) ?? [];
    },
    [sessionKey],
  );

  useEffect(() => {
    void loadSchemas().then(() => {
      const cur = cache.current.current;
      if (cur) void loadObjects(cur);
    });
  }, [loadSchemas, loadObjects]);

  const refresh = useCallback(() => {
    cache.current = {
      objects: new Map(),
      columns: new Map(),
      pending: new Map(),
      schemas: [],
      current: null,
    };
    void loadSchemas().then(() => {
      const cur = cache.current.current;
      if (cur) void loadObjects(cur);
    });
  }, [loadSchemas, loadObjects]);

  const source = useMemo(
    () =>
      async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        const word = ctx.matchBefore(WORD);
        const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 200), ctx.pos);
        // `name.` or `name.part`: columns of a table, or tables of a schema.
        const dotted = /([\w$]+)\.([\w$]*)$/.exec(before);
        if (!dotted && !word && !ctx.explicit) return null;

        await loadSchemas();
        const c = cache.current;
        const schema = c.current;
        const options: Completion[] = [];

        if (dotted) {
          const owner = dotted[1] as string;
          const from = ctx.pos - (dotted[2] as string).length;
          if (c.schemas.includes(owner)) {
            for (const t of await loadObjects(owner))
              options.push({ label: t, type: 'type', boost: 2 });
          }
          if (schema && (c.objects.get(schema) ?? []).includes(owner)) {
            for (const col of await loadColumns(schema, owner))
              options.push({ label: col, type: 'property', boost: 3 });
          }
          return options.length ? { from, options, validFor: WORD } : null;
        }

        if (!schema) return null;
        const tables = await loadObjects(schema);
        const doc = ctx.state.doc.toString();
        const mentioned = tables.filter((t) =>
          new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(doc),
        );
        for (const t of tables)
          options.push({ label: t, type: 'type', boost: mentioned.includes(t) ? 1 : 0 });
        for (const t of mentioned.slice(0, 8)) {
          for (const col of await loadColumns(schema, t))
            options.push({ label: col, type: 'property', detail: t, boost: 2 });
        }
        for (const s of c.schemas)
          if (s !== schema) options.push({ label: s, type: 'namespace', boost: -1 });
        return { from: word ? word.from : ctx.pos, options, validFor: WORD };
      },
    [loadSchemas, loadObjects, loadColumns],
  );

  return { source, refresh };
}
