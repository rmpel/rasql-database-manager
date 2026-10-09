import { useCallback, useEffect, useRef, useState } from 'react';
import type { ColumnMeta, QueryEvent, Value, Warning } from '@rasql/driver-protocol';
import type { SerializableQueryOptions } from '@shared/api';
import { rasql } from '../api';

export interface QueryState {
  status: 'idle' | 'running' | 'done' | 'error';
  columns: ColumnMeta[];
  rows: Value[][];
  rowCount?: number;
  affectedRows?: number;
  insertId?: string;
  truncated?: boolean;
  elapsedMs?: number;
  warnings: Warning[];
  error?: { code: string; message: string };
}

const initial: QueryState = { status: 'idle', columns: [], rows: [], warnings: [] };

/** Runs one query at a time against a session and accumulates its streamed events. */
export function useQuery(sessionKey: string): {
  state: QueryState;
  run: (sql: string, opts?: SerializableQueryOptions & { append?: boolean }) => Promise<void>;
  cancel: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<QueryState>(initial);
  const queryIdRef = useRef<string | null>(null);

  useEffect(() => {
    return rasql.session.onQueryEvent(({ queryId, event }) => {
      if (queryId !== queryIdRef.current) return;
      setState((s) => applyEvent(s, event));
      if (event.kind === 'error' || (event.kind === 'done' && !event.more))
        queryIdRef.current = null;
    });
  }, []);

  const run = useCallback(
    async (sql: string, opts: SerializableQueryOptions & { append?: boolean } = {}) => {
      const { append, ...queryOpts } = opts;
      if (queryIdRef.current) await rasql.session.cancelQuery(queryIdRef.current);
      setState((s) => {
        // A fresh run keeps the previous columns until the new ones arrive, so toolbars that depend
        // on them (filters, export) do not flicker to disabled during a refresh.
        if (!append) return { ...initial, columns: s.columns, status: 'running' };
        const { error: _dropped, ...rest } = s;
        return { ...rest, status: 'running' };
      });
      const id = await rasql.session.startQuery(sessionKey, sql, queryOpts);
      queryIdRef.current = id;
    },
    [sessionKey],
  );

  const cancel = useCallback(() => {
    if (queryIdRef.current) void rasql.session.cancelQuery(queryIdRef.current);
  }, []);

  const reset = useCallback(() => setState(initial), []);

  return { state, run, cancel, reset };
}

function applyEvent(s: QueryState, e: QueryEvent): QueryState {
  switch (e.kind) {
    case 'columns':
      // Appending pages keeps the existing columns; a fresh query replaces them.
      return s.rows.length ? s : { ...s, columns: e.columns };
    case 'rows':
      return { ...s, rows: s.rows.concat(e.rows) };
    case 'done': {
      const next: QueryState = {
        ...s,
        status: e.more ? 'running' : 'done',
        elapsedMs: e.elapsedMs,
        warnings: e.warnings,
      };
      if (e.rowCount !== undefined) next.rowCount = e.rowCount;
      if (e.affectedRows !== undefined) next.affectedRows = e.affectedRows;
      if (e.insertId !== undefined) next.insertId = e.insertId;
      if (e.truncated !== undefined) next.truncated = e.truncated;
      return next;
    }
    case 'error':
      return { ...s, status: 'error', error: { code: e.code, message: e.message } };
  }
}
