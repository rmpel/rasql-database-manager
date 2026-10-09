import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ColumnMeta, Value } from '@rasql/driver-protocol';
import type { RemoteSession } from '@rasql/driver-sdk';
import type { ExportFormat, ExportProgress, ExportRequest } from '../shared/api';
import { IPC } from '../shared/api';
import {
  csvHeaderLine,
  csvRowLine,
  DEFAULT_CSV,
  jsonRow,
  sqlHeader,
  type CsvOptions,
} from './export-formats';
import type { SessionManager } from './sessions';

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelled';
  }
}

export interface ExportCoreOptions {
  session: RemoteSession;
  req: Omit<ExportRequest, 'sessionKey'>;
  filePath: string;
  signal: AbortSignal;
  onProgress?: (rows: number, bytes: number) => void;
  /** Rows between two progress reports. Default 2000. */
  progressEvery?: number;
  now?: () => Date;
}

export interface ExportSummary {
  rows: number;
  bytes: number;
}

const EXTENSIONS: Record<ExportFormat, string> = { csv: 'csv', json: 'json', sql: 'sql' };

/** Write with backpressure: wait for 'drain' when the stream's buffer is full. */
async function write(stream: WriteStream, chunk: string): Promise<number> {
  const bytes = Buffer.byteLength(chunk);
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        stream.off('drain', onDrain);
        reject(err);
      };
      const onDrain = (): void => {
        stream.off('error', onError);
        resolve();
      };
      stream.once('drain', onDrain);
      stream.once('error', onError);
    });
  }
  return bytes;
}

function finish(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
}

/**
 * Stream one statement's first result set into a file. The core is independent of Electron so
 * it runs in tests against an in-process driver. On cancel or failure the partial file is removed.
 */
export async function runExport(opts: ExportCoreOptions): Promise<ExportSummary> {
  const { session, req, filePath, signal } = opts;
  const every = opts.progressEvery ?? 2000;
  const now = opts.now ?? (() => new Date());
  if (req.format === 'sql' && !req.table) {
    throw new Error('SQL export needs the target table');
  }
  const csv: CsvOptions = {
    delimiter: req.options?.delimiter ?? DEFAULT_CSV.delimiter,
    header: req.options?.header ?? DEFAULT_CSV.header,
    nullAs: req.options?.nullAs ?? DEFAULT_CSV.nullAs,
  };
  const ndjson = req.options?.ndjson === true;
  const batchSize = Math.max(1, req.options?.batchSize ?? 500);

  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  let rows = 0;
  let bytes = 0;
  let columns: ColumnMeta[] | null = null;
  let resultIndex = -1;
  let jsonFirst = true;
  let sqlBatch: Value[][] = [];
  let sqlColumns: string[] = [];
  const table = req.table;

  const put = async (chunk: string): Promise<void> => {
    bytes += await write(stream, chunk);
  };

  const flushSql = async (): Promise<void> => {
    if (!table || sqlBatch.length === 0) return;
    const statement = await session.dialect.buildInsertMany(table, sqlColumns, sqlBatch);
    sqlBatch = [];
    await put(`${statement};\n`);
  };

  const emitRows = async (batch: Value[][]): Promise<void> => {
    if (!columns) return;
    switch (req.format) {
      case 'csv': {
        let chunk = '';
        for (const row of batch) chunk += csvRowLine(row, csv);
        await put(chunk);
        break;
      }
      case 'json': {
        let chunk = '';
        for (const row of batch) {
          const text = JSON.stringify(jsonRow(columns, row));
          if (ndjson) chunk += `${text}\n`;
          else {
            chunk += `${jsonFirst ? '' : ',\n'}  ${text}`;
            jsonFirst = false;
          }
        }
        await put(chunk);
        break;
      }
      case 'sql': {
        for (const row of batch) {
          sqlBatch.push(row);
          if (sqlBatch.length >= batchSize) await flushSql();
        }
        break;
      }
    }
    rows += batch.length;
    if (Math.floor(rows / every) !== Math.floor((rows - batch.length) / every))
      opts.onProgress?.(rows, bytes);
  };

  try {
    if (signal.aborted) throw new ExportCancelled();
    const iterator = session.query(req.sql, { rowBatchSize: 1000, signal })[Symbol.asyncIterator]();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (signal.aborted) throw new ExportCancelled();
      if (event.kind === 'error') {
        if (event.code === 'CANCELLED') throw new ExportCancelled();
        throw new Error(event.message);
      }
      if (event.kind === 'columns') {
        if (columns) {
          // A second result set: stop here, the first one is what gets exported.
          await iterator.return?.();
          break;
        }
        columns = event.columns;
        resultIndex = event.resultIndex;
        if (req.format === 'csv' && csv.header) await put(csvHeaderLine(columns, csv));
        if (req.format === 'json' && !ndjson) await put('[\n');
        if (req.format === 'sql') {
          sqlColumns = columns.map((c) => c.originalName ?? c.name);
          await put(sqlHeader(req.sql, now()));
        }
        continue;
      }
      if (event.kind === 'rows' && event.resultIndex === resultIndex) {
        await emitRows(event.rows);
        continue;
      }
      if (event.kind === 'done' && !event.more) break;
    }
    if (!columns) throw new Error('The statement returned no result set to export');
    if (req.format === 'sql') await flushSql();
    if (req.format === 'json' && !ndjson) await put(jsonFirst ? ']\n' : '\n]\n');
    await finish(stream);
    opts.onProgress?.(rows, bytes);
    return { rows, bytes };
  } catch (err) {
    // Buffered writes fail once the stream is destroyed; swallow those, the file is deleted anyway.
    stream.on('error', () => undefined);
    stream.destroy();
    await unlink(filePath).catch(() => undefined);
    if (signal.aborted && !(err instanceof ExportCancelled)) throw new ExportCancelled();
    throw err;
  }
}

const sanitizeName = (name: string): string =>
  name.replace(/[/\\:*?"<>|]+/g, '_').trim() || 'export';

const FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  csv: { name: 'CSV', extensions: ['csv'] },
  json: { name: 'JSON', extensions: ['json', 'ndjson'] },
  sql: { name: 'SQL', extensions: ['sql'] },
};

/** `export:start` asks for a destination and streams in the background; `export:cancel` aborts. */
export function registerExportIpc(deps: { sessions: SessionManager }): void {
  const { sessions } = deps;
  const running = new Map<string, AbortController>();

  const windowOf = (e: IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) throw new Error('No window for this request');
    return win;
  };

  const send = (win: BrowserWindow, p: ExportProgress): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.exportProgress, p);
  };

  ipcMain.handle(IPC.exportStart, async (e, req: ExportRequest): Promise<string | null> => {
    const win = windowOf(e);
    const session = sessions.get(req.sessionKey);
    const ext = req.options?.ndjson ? 'ndjson' : EXTENSIONS[req.format];
    const result = await dialog.showSaveDialog(win, {
      title: 'Export',
      defaultPath: `${sanitizeName(req.suggestedName)}.${ext}`,
      filters: [FILTERS[req.format], { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const filePath = result.filePath;
    const exportId = randomUUID();
    const ac = new AbortController();
    running.set(exportId, ac);
    const { sessionKey: _ignored, ...coreReq } = req;
    void runExport({
      session,
      req: coreReq,
      filePath,
      signal: ac.signal,
      onProgress: (rows, bytes) => send(win, { exportId, rows, bytes, done: false }),
    })
      .then(({ rows, bytes }) => send(win, { exportId, rows, bytes, done: true, filePath }))
      .catch((err: unknown) => {
        if (err instanceof ExportCancelled) send(win, { exportId, rows: 0, bytes: 0, done: true });
        else
          send(win, {
            exportId,
            rows: 0,
            bytes: 0,
            done: true,
            error: err instanceof Error ? err.message : String(err),
          });
      })
      .finally(() => running.delete(exportId));
    return exportId;
  });

  ipcMain.handle(IPC.exportCancel, (_e, exportId: string) => {
    running.get(exportId)?.abort();
  });
}
