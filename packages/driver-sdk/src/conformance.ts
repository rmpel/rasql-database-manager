import {
  DriverError,
  PROTOCOL_VERSION,
  isValueType,
  type Driver,
  type QueryEvent,
  type ResolvedEndpoint,
} from '@rasql/driver-protocol';
import { DriverClient, type RemoteSession } from './client.js';
import { createInProcessTransports } from './inprocess.js';
import { serveDriver } from './serve.js';

export interface ConformanceCheck {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  message?: string;
  durationMs: number;
}

export interface ConformanceReport {
  driver: string;
  engine?: string;
  version?: string;
  checks: ConformanceCheck[];
  passed: number;
  failed: number;
  skipped: number;
}

export interface ConformanceOptions {
  /** A statement every engine can run that returns one row with one integer column. */
  trivialSelect?: string;
  /** A statement that must fail with a syntax error. */
  badSql?: string;
  /** A statement that produces a text column with non-ASCII content. */
  unicodeSelect?: string;
}

class Skip extends Error {}

async function collect(events: AsyncIterable<QueryEvent>): Promise<QueryEvent[]> {
  const out: QueryEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** User schemas first, system schemas last: the first table found should be one anyone can read. */
async function schemasForProbing(s: RemoteSession): Promise<{ name: string }[]> {
  const all = await s.listSchemas();
  return [...all.filter((x) => !x.isSystem), ...all.filter((x) => x.isSystem)];
}

function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/**
 * Run every check a RaSQL driver must pass, through the real protocol (serialized
 * messages, in-process). Framework agnostic: a test asserts `report.failed === 0`,
 * a CLI prints the report for a third-party driver author.
 */
export async function runConformanceChecks(
  driver: Driver,
  endpoint: ResolvedEndpoint,
  opts: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const trivialSelect = opts.trivialSelect ?? 'SELECT 1';
  const badSql = opts.badSql ?? 'SELEC 1 FROM';
  const unicodeSelect = opts.unicodeSelect ?? "SELECT 'héllo ☃ 🦈'";

  const { host, driver: driverSide } = createInProcessTransports();
  const stop = serveDriver(driver, driverSide);
  const client = new DriverClient(host);
  const checks: ConformanceCheck[] = [];
  let session: RemoteSession | null = null;
  const manifest = driver.manifest();
  const report: ConformanceReport = {
    driver: manifest.id,
    checks,
    passed: 0,
    failed: 0,
    skipped: 0,
  };

  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    const started = Date.now();
    try {
      await fn();
      checks.push({ name, status: 'pass', durationMs: Date.now() - started });
      report.passed++;
    } catch (err) {
      if (err instanceof Skip) {
        checks.push({
          name,
          status: 'skip',
          message: err.message,
          durationMs: Date.now() - started,
        });
        report.skipped++;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      checks.push({ name, status: 'fail', message, durationMs: Date.now() - started });
      report.failed++;
    }
  };

  try {
    await check('manifest has the required shape', async () => {
      expect(
        typeof manifest.id === 'string' && /^[a-z][a-z0-9-]*$/.test(manifest.id),
        'id must be a lowercase slug',
      );
      expect(
        manifest.protocolVersion === PROTOCOL_VERSION,
        `protocolVersion must be ${PROTOCOL_VERSION}`,
      );
      expect(manifest.engines.length > 0, 'at least one engine');
      expect(manifest.transports.length > 0, 'at least one transport');
      expect(
        Array.isArray(manifest.connectionForm.fields),
        'connectionForm.fields must be an array',
      );
      expect(Array.isArray(manifest.capabilities.objects), 'capabilities.objects must be an array');
    });

    await check('manifest survives the protocol', async () => {
      const remote = await client.manifest();
      expect(
        JSON.stringify(remote) === JSON.stringify(manifest),
        'manifest differs after serialization',
      );
    });

    await check('connect', async () => {
      session = await client.connect(endpoint);
      expect(session.serverInfo.engine, 'serverInfo.engine missing');
      expect(session.serverInfo.version, 'serverInfo.version missing');
      expect(
        manifest.engines.some((e) => e.id === session!.serverInfo.engine),
        'engine not in manifest',
      );
      report.engine = session.serverInfo.engine;
      report.version = session.serverInfo.version;
    });

    const needSession = (): RemoteSession => {
      if (!session) throw new Skip('no session');
      return session;
    };

    await check('listSchemas returns at least one schema', async () => {
      const schemas = await needSession().listSchemas();
      expect(schemas.length > 0, 'no schemas');
      expect(
        schemas.every((s) => typeof s.name === 'string'),
        'schema without name',
      );
    });

    await check('listObjects works for every schema', async () => {
      const s = needSession();
      for (const schema of await s.listSchemas()) {
        const objects = await s.listObjects(schema.name);
        expect(Array.isArray(objects), 'objects not an array');
        for (const o of objects) {
          expect(
            manifest.capabilities.objects.includes(o.kind),
            `object kind ${o.kind} not in capabilities`,
          );
        }
      }
    });

    await check('trivial select streams columns, rows, done', async () => {
      const events = await collect(needSession().query(trivialSelect));
      const kinds = events.map((e) => e.kind);
      expect(kinds[0] === 'columns', `first event must be columns, got ${kinds[0]}`);
      expect(kinds.includes('rows'), 'no rows event');
      expect(kinds[kinds.length - 1] === 'done', 'last event must be done');
      const done = events[events.length - 1] as Extract<QueryEvent, { kind: 'done' }>;
      expect(typeof done.elapsedMs === 'number', 'done.elapsedMs missing');
      expect(Array.isArray(done.warnings), 'done.warnings missing');
      const columns = (events[0] as Extract<QueryEvent, { kind: 'columns' }>).columns;
      expect(columns.length === 1, 'expected one column');
      expect(isValueType(columns[0]!.valueType), 'column.valueType is not a known type');
    });

    await check('cells are typed values and integers are strings', async () => {
      const events = await collect(needSession().query(trivialSelect));
      const rows = events.filter((e) => e.kind === 'rows').flatMap((e) => e.rows);
      expect(rows.length === 1, `expected one row, got ${rows.length}`);
      const cell = rows[0]![0]!;
      expect(isValueType(cell.t), `cell has unknown type tag ${String(cell.t)}`);
      expect(cell.t === 'int', `expected int, got ${cell.t}`);
      expect(cell.t === 'int' && typeof cell.v === 'string', 'int must travel as a string');
    });

    await check('non-ascii text arrives intact', async () => {
      const events = await collect(needSession().query(unicodeSelect));
      const rows = events.filter((e) => e.kind === 'rows').flatMap((e) => e.rows);
      const cell = rows[0]![0]!;
      expect(cell.t === 'text', `expected text, got ${cell.t}`);
      expect(cell.t === 'text' && cell.v === 'héllo ☃ 🦈', `got ${JSON.stringify(cell)}`);
    });

    await check('invalid sql yields an error event, not a hang', async () => {
      const events = await Promise.race([
        collect(needSession().query(badSql)).catch((e: unknown) => e),
        new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 10_000)),
      ]);
      expect(events !== 'timeout', 'query did not finish within 10 s');
      if (Array.isArray(events)) {
        const last = events[events.length - 1];
        expect(last?.kind === 'error', `expected error event, got ${last?.kind}`);
      } else {
        expect(events instanceof DriverError, 'rejected with something other than a DriverError');
      }
    });

    await check('session survives a failed statement', async () => {
      const events = await collect(needSession().query(trivialSelect));
      expect(events[events.length - 1]?.kind === 'done', 'select after error did not complete');
    });

    await check('early termination of a stream is tolerated', async () => {
      const s = needSession();
      for await (const e of s.query(trivialSelect)) {
        if (e.kind === 'columns') break;
      }
      const events = await collect(s.query(trivialSelect));
      expect(
        events[events.length - 1]?.kind === 'done',
        'select after early break did not complete',
      );
    });

    await check('dialect: identifiers are quoted and classify works', async () => {
      const d = needSession().dialect;
      const info = await d.describe();
      expect(
        typeof info.identifierQuote === 'string' && info.identifierQuote.length > 0,
        'identifierQuote missing',
      );
      const quoted = await d.quoteIdentifier(`we${info.identifierQuote}ird`);
      expect(
        quoted.startsWith(info.identifierQuote) && quoted.endsWith(info.identifierQuote),
        'not quoted',
      );
      expect((await d.classify(trivialSelect)) === 'read', 'trivial select not classified as read');
      expect((await d.classify('DELETE FROM t')) === 'write', 'delete not classified as write');
    });

    await check('dialect: generated select runs', async () => {
      const s = needSession();
      let found: { schema: string; name: string } | null = null;
      for (const schema of await schemasForProbing(s)) {
        const t = (await s.listObjects(schema.name)).find((o) => o.kind === 'table');
        if (t) {
          found = { schema: t.schema, name: t.name };
          break;
        }
      }
      if (!found) throw new Skip('no table to select from');
      const sql = await s.dialect.buildSelect(found, { limit: 1 });
      const events = await collect(s.query(sql));
      expect(events[events.length - 1]?.kind === 'done', `generated select failed: ${sql}`);
    });

    await check('describeTable returns columns for a real table', async () => {
      const s = needSession();
      for (const schema of await schemasForProbing(s)) {
        const t = (await s.listObjects(schema.name)).find((o) => o.kind === 'table');
        if (!t) continue;
        const def = await s.describeTable(t.schema, t.name);
        expect(def.columns.length > 0, 'table without columns');
        expect(
          def.columns.every((c) => isValueType(c.valueType)),
          'column with unknown valueType',
        );
        return;
      }
      throw new Skip('no table to describe');
    });

    await check('explain', async () => {
      if (!manifest.capabilities.explain) throw new Skip('driver does not claim explain');
      const r = await needSession().explain(trivialSelect);
      expect(['table', 'text', 'json'].includes(r.format), 'explain.format invalid');
    });

    await check('close', async () => {
      await needSession().close();
      session = null;
    });
  } finally {
    client.shutdown();
    stop();
  }

  return report;
}

/** A compact, human readable rendering of a report for CLI use. */
export function formatConformanceReport(r: ConformanceReport): string {
  const lines = [`${r.driver}${r.engine ? ` (${r.engine} ${r.version ?? ''})` : ''}`];
  for (const c of r.checks) {
    const mark = c.status === 'pass' ? 'PASS' : c.status === 'skip' ? 'SKIP' : 'FAIL';
    lines.push(`  ${mark}  ${c.name}${c.message ? `  -- ${c.message}` : ''}`);
  }
  lines.push(`  ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped`);
  return lines.join('\n');
}
