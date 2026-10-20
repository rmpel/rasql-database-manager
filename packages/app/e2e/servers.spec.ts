import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  SHOTS,
  launch,
  openConnectionWindow,
  openNewConnectionForm,
  portOpen,
  runQuery,
} from './helpers';

// Each driver package brings its client library; borrow them to seed and check the tables.
const pgRequire = createRequire(resolve('../driver-postgres/package.json'));
const msRequire = createRequire(resolve('../driver-mssql/package.json'));

const PG_PORT = 35416;
const MSSQL_PORT = 16022;

async function pgExec(sql: string): Promise<Record<string, unknown>[]> {
  const { Client } = pgRequire('pg') as {
    Client: new (c: Record<string, unknown>) => {
      connect(): Promise<void>;
      query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
      end(): Promise<void>;
    };
  };
  const c = new Client({
    host: '127.0.0.1',
    port: PG_PORT,
    user: 'rasql',
    password: 'rasql',
    database: 'rasql',
  });
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end();
  }
}

interface TediousConnection {
  connect(cb: (err?: Error) => void): void;
  execSqlBatch(req: unknown): void;
  close(): void;
}
interface Tedious {
  Connection: new (config: Record<string, unknown>) => TediousConnection;
  Request: new (
    sql: string,
    cb: (err?: Error | null) => void,
  ) => {
    on(event: 'row', cb: (cols: { value: unknown; metadata: { colName: string } }[]) => void): void;
  };
}

function mssqlExec(sql: string): Promise<Record<string, unknown>[]> {
  const { Connection, Request } = msRequire('tedious') as Tedious;
  return new Promise((resolvePromise, reject) => {
    const conn = new Connection({
      server: '127.0.0.1',
      authentication: { type: 'default', options: { userName: 'rasql', password: 'rasql' } },
      options: {
        port: MSSQL_PORT,
        database: 'rasql',
        encrypt: false,
        trustServerCertificate: true,
      },
    });
    const rows: Record<string, unknown>[] = [];
    conn.connect((err) => {
      if (err) return reject(err);
      const req = new Request(sql, (e) => {
        conn.close();
        if (e) reject(e);
        else resolvePromise(rows);
      });
      req.on('row', (cols: { value: unknown; metadata: { colName: string } }[]) =>
        rows.push(Object.fromEntries(cols.map((c) => [c.metadata.colName, c.value]))),
      );
      conn.execSqlBatch(req);
    });
  });
}

async function answerConfirm(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({
      response: 0,
      checkboxChecked: false,
    })) as typeof dialog.showMessageBox;
  });
}

const structureRow = (page: Page, name: string) =>
  page.locator('.structure-columns tbody tr').filter({
    has: page.locator(`input.col-name[value="${name}"]`),
  });

/** Fill the connection form for a server driver; the port must already be the driver's default. */
async function connect(
  app: ElectronApplication,
  page: Page,
  driver: string,
  name: string,
  defaultPort: number,
  port: number,
): Promise<Page> {
  // Start from MySQL so switching drivers shows the default port following along.
  await openNewConnectionForm(page, 'mysql');
  const form = page.locator('.connection-form');
  await expect(form.getByLabel('Port')).toHaveValue('3306');
  await form.locator('select').nth(1).selectOption(driver);
  await expect(form.getByLabel('Port')).toHaveValue(String(defaultPort));
  await form.locator('input').first().fill(name);
  await form.getByLabel('Host').fill('127.0.0.1');
  await form.getByLabel('Port').fill(String(port));
  await form.getByLabel('User').fill('rasql');
  await form.getByLabel('Password', { exact: true }).fill('rasql');
  await form.getByLabel('Database').fill('rasql');
  return openConnectionWindow(
    app,
    () => page.getByRole('button', { name: 'Connect', exact: true }).click(),
    name,
  );
}

/** Browse a table, edit a cell, commit; then change a column type in the structure editor. */
async function editAndRestructure(
  app: ElectronApplication,
  ws: Page,
  expectSql: RegExp,
): Promise<void> {
  await ws.locator('.object-name', { hasText: /^e2e_people$/ }).click({ timeout: 20_000 });
  const pane = ws.locator('.tab-pane:not([hidden])');
  const grid = pane.locator('.grid-table');
  await expect(pane.locator('.toolbar-status')).toContainText('3 rows loaded');
  const annAge = grid.locator('tbody tr').filter({ hasText: 'Ann' }).locator('td').nth(3);
  await annAge.dblclick();
  await pane.locator('.cell-editor input').fill('31');
  await pane.locator('.cell-editor input').press('Enter');
  const bobName = grid.locator('tbody tr').filter({ hasText: 'Bob' }).locator('td').nth(2);
  await bobName.dblclick();
  await pane.locator('.cell-editor input').fill('Bøb ☃');
  await pane.locator('.cell-editor input').press('Enter');
  await answerConfirm(app);
  await pane.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(pane.locator('.toolbar-status')).toContainText('Committed 2 statements', {
    timeout: 15_000,
  });

  await pane.getByRole('button', { name: 'Structure' }).click();
  const editor = pane.locator('.structure-editor');
  const age = structureRow(ws, 'age');
  await expect(age.locator('.type-picker select').first()).toHaveValue('integer');
  await age.locator('.type-picker select').nth(1).selectOption('BIGINT');
  await expect(editor.locator('.structure-sql')).toContainText(expectSql);
  await answerConfirm(app);
  await editor.getByRole('button', { name: 'Review and apply' }).click();
  await expect(editor.locator('.pending-badge')).toHaveText('0 changes', { timeout: 15_000 });
}

test('PostgreSQL: connect, browse, edit, restructure and query', async () => {
  test.skip(!(await portOpen(PG_PORT)), 'postgres16 from test/matrix is not running');
  await pgExec('DROP TABLE IF EXISTS e2e_people');
  await pgExec(
    "CREATE TABLE e2e_people (id serial PRIMARY KEY, name text NOT NULL, age integer, meta jsonb); INSERT INTO e2e_people (name, age, meta) VALUES ('Ann', 30, '{\"a\":1}'), ('Bob', 40, NULL), ('Cid', 50, '[]')",
  );
  const { app, page } = await launch();
  try {
    const ws = await connect(app, page, 'postgres', 'Matrix PostgreSQL 16', 5432, PG_PORT);
    await expect(ws.locator('.titlebar-meta')).toContainText(/PostgreSQL 16/);
    await editAndRestructure(app, ws, /ALTER COLUMN "age" TYPE BIGINT USING "age"::BIGINT/);
    await ws.screenshot({ path: join(SHOTS, '20-postgres.png') });
    const rows = await pgExec(
      'SELECT name, age, pg_typeof(age)::text AS t FROM e2e_people ORDER BY id',
    );
    expect(rows).toEqual([
      { name: 'Ann', age: '31', t: 'bigint' },
      { name: 'Bøb ☃', age: '40', t: 'bigint' },
      { name: 'Cid', age: '50', t: 'bigint' },
    ]);

    // A script with a dollar-quoted body runs as written: the semicolons inside belong to it.
    await ws.getByTitle(/^New query tab/).click();
    const status = await runQuery(
      ws,
      "DO $$ BEGIN PERFORM 1; END $$; SELECT name FROM e2e_people WHERE name ILIKE 'b%'",
    );
    expect(status).not.toMatch(/error|failed/i);
  } finally {
    await app.close();
    await pgExec('DROP TABLE IF EXISTS e2e_people');
  }
});

test('SQL Server: connect, browse, edit, restructure and query', async () => {
  test.skip(!(await portOpen(MSSQL_PORT)), 'mssql2022 from test/matrix is not running');
  await mssqlExec('DROP TABLE IF EXISTS e2e_people');
  await mssqlExec(
    "CREATE TABLE e2e_people (id int IDENTITY(1,1) PRIMARY KEY, name nvarchar(50) NOT NULL, age int DEFAULT 18, created datetime2(3) DEFAULT sysutcdatetime()); INSERT INTO e2e_people (name, age) VALUES (N'Ann', 30), (N'Bob', 40), (N'Cid', 50)",
  );
  const { app, page } = await launch();
  try {
    const ws = await connect(app, page, 'mssql', 'Matrix SQL Server 2022', 1433, MSSQL_PORT);
    await expect(ws.locator('.titlebar-meta')).toContainText(/SQL Server 2022/);
    // The default constraint on age is dropped and put back around ALTER COLUMN.
    await editAndRestructure(
      app,
      ws,
      /ALTER TABLE \[dbo\]\.\[e2e_people\] ALTER COLUMN \[age\] BIGINT NULL/,
    );
    await ws.screenshot({ path: join(SHOTS, '21-mssql.png') });
    const rows = await mssqlExec(
      "SELECT p.name, p.age, TYPE_NAME(c.user_type_id) AS t, OBJECT_DEFINITION(c.default_object_id) AS d FROM e2e_people p CROSS JOIN sys.columns c WHERE c.object_id = OBJECT_ID('e2e_people') AND c.name = 'age' ORDER BY p.id",
    );
    expect(rows).toEqual([
      { name: 'Ann', age: '31', t: 'bigint', d: '((18))' },
      { name: 'Bøb ☃', age: '40', t: 'bigint', d: '((18))' },
      { name: 'Cid', age: '50', t: 'bigint', d: '((18))' },
    ]);
    await ws.getByTitle(/^New query tab/).click();
    const status = await runQuery(ws, "SELECT TOP (2) name FROM e2e_people WHERE name LIKE N'B%'");
    expect(status).toMatch(/1 rows/);
  } finally {
    await app.close();
    await mssqlExec('DROP TABLE IF EXISTS e2e_people');
  }
});
