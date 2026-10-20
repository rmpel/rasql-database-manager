import type { ColumnDefinition, TableDefinition } from '@rasql/driver-protocol';
import { Refusal, assertNoFileAccess, assertNoUnsafeFunctions } from './scope.js';
import {
  findTopLevel,
  isWord,
  nameOf,
  readTableName,
  splitTopLevelCommas,
  textBetween,
  type Flavor,
  type Statement,
  type Token,
} from './sql.js';
import {
  compareCharsets,
  compareTypes,
  parseColumnType,
  parseTypeText,
  type TypeChange,
} from './types.js';

/**
 * How a statement in a change set is treated (MCP.md section 6). 'check' becomes 'safe' or
 * 'destructive' once its data checks have run.
 */
export type Safety = 'safe' | 'check' | 'destructive';

export interface TableName {
  schema?: string;
  name: string;
}

/** A read that counts the rows a narrowing change would damage. Zero means the data fits. */
export interface DataCheck {
  description: string;
  sql: string;
}

export interface StatementAnalysis {
  sql: string;
  /** Data changes run in a transaction; structure changes commit at once on MySQL. */
  kind: 'data' | 'structure' | 'read' | 'other';
  safety: Safety;
  /** Plain-language reasons, one per finding. */
  reasons: string[];
  tables: TableName[];
  checks: DataCheck[];
  /** A COUNT(*) that estimates the rows a data change touches. */
  estimateSql?: string;
  /** Rows an INSERT … VALUES adds. */
  insertRows?: number;
}

export interface AnalysisContext {
  flavor: Flavor;
  /** The table as the engine describes it, or null when it does not exist. */
  describe(table: TableName): Promise<TableDefinition | null>;
}

export function quoteIdent(flavor: Flavor, name: string): string {
  if (flavor === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  if (flavor === 'mssql') return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

export const qualified = (flavor: Flavor, t: TableName): string =>
  t.schema !== undefined
    ? `${quoteIdent(flavor, t.schema)}.${quoteIdent(flavor, t.name)}`
    : quoteIdent(flavor, t.name);

const tableName = (t: { schema?: string; name: string }): TableName =>
  t.schema !== undefined ? { schema: t.schema, name: t.name } : { name: t.name };

/** Statement keywords the change set runs itself, or that point outside the connection. */
const REFUSED_HEADS = new Set([
  'BEGIN',
  'START',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'END',
  'XA',
]);

/** Analyze one statement. Throws Refusal for statements agents may never run. */
export async function analyzeStatement(
  stmt: Statement,
  ctx: AnalysisContext,
): Promise<StatementAnalysis> {
  const { tokens, sql } = stmt;
  const head = tokens[0];
  if (!head) throw new Refusal('The statement is empty');
  if (head.kind === 'word' && REFUSED_HEADS.has(head.value))
    throw new Refusal(
      `${head.value} is not allowed in a change set; RaSQL runs the whole change set in one transaction`,
    );
  assertNoFileAccess(stmt);
  assertNoUnsafeFunctions(stmt);

  const result = (
    kind: StatementAnalysis['kind'],
    safety: Safety,
    reason: string,
    tables: TableName[] = [],
  ): StatementAnalysis => ({ sql, kind, safety, reasons: [reason], tables, checks: [] });

  const { flavor } = ctx;
  const kw = head.kind === 'word' ? head.value : '';

  if (
    ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE'].includes(kw) &&
    findTopLevel(tokens, (t) => isWord(t, 'INTO')) === -1
  )
    return result('read', 'safe', 'only reads');

  if (kw === 'INSERT') {
    let i = 1;
    while (isWord(tokens[i], 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE')) i++;
    if (isWord(tokens[i], 'OR')) {
      // SQLite: INSERT OR REPLACE deletes the conflicting row first.
      if (isWord(tokens[i + 1], 'REPLACE'))
        return result('data', 'destructive', 'INSERT OR REPLACE deletes conflicting rows');
      i += 2;
    }
    if (isWord(tokens[i], 'INTO')) i++;
    const t = readTableName(tokens, i);
    const out = result('data', 'safe', 'adds rows', t ? [tableName(t)] : []);
    const values = findTopLevel(tokens, (tk) => isWord(tk, 'VALUES', 'VALUE'));
    if (values !== -1) {
      const end = findTopLevel(tokens, (tk) => isWord(tk, 'ON', 'RETURNING', 'AS'), values + 1);
      const rows = splitTopLevelCommas(tokens.slice(values + 1, end === -1 ? tokens.length : end));
      out.insertRows = rows.length;
    }
    if (
      findTopLevel(tokens, (tk) => isWord(tk, 'DUPLICATE')) !== -1 ||
      findTopLevel(tokens, (tk) => isWord(tk, 'CONFLICT')) !== -1
    )
      out.reasons.push('updates rows that already exist');
    return out;
  }
  if (kw === 'REPLACE') {
    const t = readTableName(tokens, isWord(tokens[1], 'INTO') ? 2 : 1);
    return result(
      'data',
      'destructive',
      'REPLACE deletes rows that conflict before inserting',
      t ? [tableName(t)] : [],
    );
  }
  if (kw === 'MERGE') return result('data', 'destructive', 'MERGE can delete rows');

  if (kw === 'UPDATE') {
    let i = 1;
    while (isWord(tokens[i], 'LOW_PRIORITY', 'IGNORE', 'ONLY')) i++;
    const t = readTableName(tokens, i);
    const tables = t ? [tableName(t)] : [];
    const where = findTopLevel(tokens, (tk) => isWord(tk, 'WHERE'));
    if (where === -1)
      return result(
        'data',
        'destructive',
        'UPDATE without a WHERE clause changes every row',
        tables,
      );
    const out = result('data', 'safe', 'changes only the rows its WHERE clause selects', tables);
    // Single-table form: UPDATE t [alias] SET … WHERE …
    const set = findTopLevel(tokens, (tk) => isWord(tk, 'SET'));
    const joined = tokens
      .slice(0, set === -1 ? 0 : set)
      .some((tk) => isWord(tk, 'JOIN') || (tk.kind === 'punct' && tk.value === ','));
    if (t && set !== -1 && !joined && findTopLevel(tokens, (tk) => isWord(tk, 'FROM')) === -1) {
      const end = findTopLevel(
        tokens,
        (tk) => isWord(tk, 'ORDER', 'LIMIT', 'RETURNING', 'OUTPUT'),
        where + 1,
      );
      const cond = textBetween(sql, tokens, where + 1, end === -1 ? tokens.length : end);
      const alias = t.next < set ? tokens[t.next] : undefined;
      const from =
        alias && (alias.kind === 'word' || alias.kind === 'ident') && !isWord(alias, 'SET')
          ? ` AS ${quoteIdent(flavor, nameOf(alias))}`
          : '';
      out.estimateSql = `SELECT COUNT(*) FROM ${qualified(flavor, tableName(t))}${from} WHERE ${cond}`;
    }
    return out;
  }
  if (kw === 'DELETE') {
    const from = tokens.findIndex((tk) => isWord(tk, 'FROM'));
    const t = from === -1 ? readTableName(tokens, 1) : readTableName(tokens, from + 1);
    const tables = t ? [tableName(t)] : [];
    const out = result('data', 'destructive', 'DELETE removes rows', tables);
    const where = findTopLevel(tokens, (tk) => isWord(tk, 'WHERE'));
    const simple =
      t &&
      from !== -1 &&
      tokens
        .slice(t.next, where === -1 ? tokens.length : where)
        .every((tk) => !isWord(tk, 'JOIN', 'USING') && tk.value !== ',');
    if (simple && where !== -1) {
      const end = findTopLevel(
        tokens,
        (tk) => isWord(tk, 'ORDER', 'LIMIT', 'RETURNING', 'OUTPUT'),
        where + 1,
      );
      const cond = textBetween(sql, tokens, where + 1, end === -1 ? tokens.length : end);
      const alias = t.next < where ? tokens[t.next] : undefined;
      const as =
        alias && (alias.kind === 'word' || alias.kind === 'ident') && !isWord(alias, 'AS')
          ? ` AS ${quoteIdent(flavor, nameOf(alias))}`
          : '';
      out.estimateSql = `SELECT COUNT(*) FROM ${qualified(flavor, tableName(t))}${as} WHERE ${cond}`;
    } else if (simple) {
      out.estimateSql = `SELECT COUNT(*) FROM ${qualified(flavor, tableName(t))}`;
      out.reasons = ['DELETE without a WHERE clause removes every row'];
    }
    return out;
  }
  if (kw === 'TRUNCATE') {
    const t = readTableName(tokens, isWord(tokens[1], 'TABLE') ? 2 : 1);
    return result(
      'structure',
      'destructive',
      'TRUNCATE removes every row',
      t ? [tableName(t)] : [],
    );
  }

  if (kw === 'DROP') {
    let i = 1;
    while (isWord(tokens[i], 'TEMPORARY')) i++;
    const what = tokens[i]?.value ?? '';
    if (what === 'INDEX' && flavor !== 'sqlite')
      return result('structure', 'safe', 'drops an index; no data is lost');
    let j = i + 1;
    while (isWord(tokens[j], 'IF', 'EXISTS')) j++;
    const t = readTableName(tokens, j);
    const tables = what === 'TABLE' && t ? [tableName(t)] : [];
    return result(
      'structure',
      'destructive',
      `DROP ${what} removes it and everything in it`,
      tables,
    );
  }

  if (kw === 'CREATE') {
    if (flavor === 'sqlite')
      return result('structure', 'destructive', 'SQLite structure changes always ask');
    let i = 1;
    if (isWord(tokens[i], 'OR') && isWord(tokens[i + 1], 'REPLACE'))
      return result(
        'structure',
        'destructive',
        'CREATE OR REPLACE replaces an existing definition',
      );
    while (
      isWord(
        tokens[i],
        'TEMPORARY',
        'TEMP',
        'GLOBAL',
        'LOCAL',
        'UNLOGGED',
        'UNIQUE',
        'FULLTEXT',
        'SPATIAL',
        'CLUSTERED',
        'NONCLUSTERED',
      )
    )
      i++;
    const what = tokens[i]?.value ?? '';
    if (what === 'TABLE' || what === 'INDEX' || what === 'VIEW') {
      let j = i + 1;
      if (what === 'INDEX') {
        const on = tokens.findIndex((tk) => isWord(tk, 'ON'));
        j = on === -1 ? j : on + 1;
        if (isWord(tokens[j], 'ONLY')) j++;
      }
      while (isWord(tokens[j], 'IF', 'NOT', 'EXISTS', 'CONCURRENTLY')) j++;
      const t = readTableName(tokens, j);
      return result(
        'structure',
        'safe',
        `creates a ${what.toLowerCase()}; nothing existing changes`,
        t && what !== 'VIEW' ? [tableName(t)] : [],
      );
    }
    return result('structure', 'destructive', `RaSQL does not classify CREATE ${what}`);
  }

  if (kw === 'RENAME' && isWord(tokens[1], 'TABLE'))
    return result('structure', 'safe', 'renames a table; no data is lost');
  if (kw === 'COMMENT' && isWord(tokens[1], 'ON'))
    return result('structure', 'safe', 'changes a comment');

  if (kw === 'ALTER' && isWord(tokens[1], 'TABLE')) {
    if (flavor === 'sqlite')
      return result('structure', 'destructive', 'SQLite structure changes always ask');
    return analyzeAlterTable(stmt, ctx);
  }

  return result(
    'other',
    'destructive',
    `RaSQL cannot classify ${kw || 'this statement'} with confidence`,
  );
}

interface ColumnSpec {
  name: string;
  type: ReturnType<typeof parseColumnType>;
  notNull: boolean;
  explicitNull: boolean;
  hasDefault: boolean;
  charset?: string;
  using: boolean;
}

/** A column definition: name, type and the attributes that matter for data loss. */
function readColumnSpec(tokens: Token[], i: number, flavor: Flavor): ColumnSpec | null {
  const nameTok = tokens[i];
  if (!nameTok || (nameTok.kind !== 'word' && nameTok.kind !== 'ident')) return null;
  const type = parseColumnType(tokens, flavor, i + 1);
  const rest = type ? tokens.slice(type.next) : [];
  const spec: ColumnSpec = {
    name: nameOf(nameTok),
    type,
    notNull: false,
    explicitNull: false,
    hasDefault: false,
    using: false,
  };
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k] as Token;
    if (isWord(t, 'NOT') && isWord(rest[k + 1], 'NULL')) {
      spec.notNull = true;
      k++;
    } else if (isWord(t, 'NULL')) spec.explicitNull = true;
    else if (isWord(t, 'DEFAULT', 'AUTO_INCREMENT', 'IDENTITY', 'GENERATED', 'AS'))
      spec.hasDefault = true;
    else if (isWord(t, 'PRIMARY')) spec.notNull = true;
    else if (isWord(t, 'USING')) spec.using = true;
    else if ((isWord(t, 'CHARACTER') && isWord(rest[k + 1], 'SET')) || isWord(t, 'CHARSET')) {
      const cs = rest[isWord(t, 'CHARSET') ? k + 1 : k + 2];
      if (cs) spec.charset = nameOf(cs).toLowerCase();
    }
  }
  return spec;
}

const ADD_SAFE = new Set([
  'INDEX',
  'KEY',
  'UNIQUE',
  'PRIMARY',
  'FULLTEXT',
  'SPATIAL',
  'CONSTRAINT',
  'FOREIGN',
  'CHECK',
]);
const DROP_SAFE = new Set(['INDEX', 'KEY', 'FOREIGN', 'PRIMARY', 'CONSTRAINT', 'CHECK']);
const OPTION_SAFE = new Set([
  'COMMENT',
  'AUTO_INCREMENT',
  'ALGORITHM',
  'LOCK',
  'ROW_FORMAT',
  'STATS_PERSISTENT',
  'STATS_AUTO_RECALC',
  'STATS_SAMPLE_PAGES',
  'KEY_BLOCK_SIZE',
  'FORCE',
  'ORDER',
  'ENABLE',
  'DISABLE',
  'OWNER',
  'VALIDATE',
  'NOCHECK',
  'WITH',
]);
const VERBS = new Set([
  'ADD',
  'DROP',
  'MODIFY',
  'CHANGE',
  'ALTER',
  'RENAME',
  'CONVERT',
  'DEFAULT',
  'CHARACTER',
  'CHARSET',
  'COLLATE',
  'ENGINE',
  'SET',
]);

async function analyzeAlterTable(
  stmt: Statement,
  ctx: AnalysisContext,
): Promise<StatementAnalysis> {
  const { tokens, sql } = stmt;
  const { flavor } = ctx;
  let i = 2;
  while (isWord(tokens[i], 'IF', 'EXISTS', 'ONLY', 'ONLINE', 'IGNORE')) i++;
  const t = readTableName(tokens, i);
  const out: StatementAnalysis = {
    sql,
    kind: 'structure',
    safety: 'safe',
    reasons: [],
    tables: [],
    checks: [],
  };
  if (!t) {
    out.safety = 'destructive';
    out.reasons.push('RaSQL could not read the table name');
    return out;
  }
  const table = tableName(t);
  out.tables.push(table);
  let def: TableDefinition | null | undefined;
  const definition = async (): Promise<TableDefinition | null> => {
    if (def === undefined) def = await ctx.describe(table);
    return def;
  };
  const column = async (name: string): Promise<ColumnDefinition | undefined> =>
    (await definition())?.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());

  const worse = (s: Safety): void => {
    if (s === 'destructive' || (s === 'check' && out.safety === 'safe')) out.safety = s;
  };
  const apply = (target: string, change: TypeChange): void => {
    out.reasons.push(`${target}: ${change.reason}`);
    worse(change.safety);
    if (change.safety === 'check') {
      const col = quoteIdent(flavor, target);
      out.checks.push({
        description: `${target}: ${change.reason}`,
        sql: `SELECT COUNT(*) FROM ${qualified(flavor, table)} WHERE ${col} IS NOT NULL AND (${change.condition(col)})`,
      });
    }
  };
  const nullCheck = (target: string): void => {
    out.reasons.push(`${target}: becomes NOT NULL; no row may hold NULL`);
    worse('check');
    out.checks.push({
      description: `${target}: no row may hold NULL`,
      sql: `SELECT COUNT(*) FROM ${qualified(flavor, table)} WHERE ${quoteIdent(flavor, target)} IS NULL`,
    });
  };
  /** Compare an existing column with its new definition. */
  const redefine = async (
    oldName: string,
    spec: ColumnSpec,
    keepsNullability: boolean,
  ): Promise<void> => {
    const old = await column(oldName);
    if (!old) {
      worse('destructive');
      out.reasons.push(`${oldName}: RaSQL cannot find this column`);
      return;
    }
    if (spec.using) {
      worse('destructive');
      out.reasons.push(`${oldName}: a USING conversion can change any value`);
      return;
    }
    const from = parseTypeText(old.nativeType, flavor);
    if (!from || !spec.type) {
      worse('destructive');
      out.reasons.push(
        `${oldName}: RaSQL cannot read the type ${spec.type ? old.nativeType : 'given'}`,
      );
      return;
    }
    apply(spec.name, compareTypes(from, spec.type.type, flavor, old.charset));
    if (spec.charset) apply(spec.name, compareCharsets(old.charset, spec.charset, flavor));
    if (!keepsNullability && old.nullable && spec.notNull) nullCheck(spec.name);
    if (spec.name !== oldName) out.reasons.push(`${oldName}: renamed to ${spec.name}`);
  };

  const parts = splitTopLevelCommas(tokens.slice(t.next));
  let lastVerb = '';
  let lastObject = '';
  for (const raw of parts) {
    let p = raw;
    const first = p[0];
    if (!first) continue;
    // SQL Server and others continue a list: ADD a INT, b INT / DROP COLUMN a, b.
    if (
      !(first.kind === 'word' && VERBS.has(first.value)) &&
      !(first.kind === 'word' && OPTION_SAFE.has(first.value)) &&
      lastVerb
    ) {
      p = [
        { ...first, kind: 'word', value: lastVerb, text: lastVerb },
        ...(lastObject
          ? [{ ...first, kind: 'word' as const, value: lastObject, text: lastObject }]
          : []),
        ...p,
      ];
    }
    const verb = (p[0] as Token).value;
    const obj = p[1];
    lastVerb = verb;
    lastObject = '';

    if (verb === 'ADD') {
      if (obj && obj.kind === 'word' && ADD_SAFE.has(obj.value)) {
        out.reasons.push(
          `adds ${obj.value === 'CONSTRAINT' || obj.value === 'CHECK' || obj.value === 'FOREIGN' ? 'a constraint' : 'an index'}`,
        );
        continue;
      }
      if (obj && obj.kind === 'word' && ['PARTITION', 'PERIOD'].includes(obj.value)) {
        worse('destructive');
        out.reasons.push(`RaSQL does not classify ADD ${obj.value}`);
        continue;
      }
      let k = 1;
      if (isWord(p[k], 'COLUMN')) {
        k++;
        lastObject = 'COLUMN';
      }
      while (isWord(p[k], 'IF', 'NOT', 'EXISTS')) k++;
      // MySQL: ADD (a INT, b INT)
      const specs: Token[][] =
        p[k]?.kind === 'punct' && p[k]?.value === '('
          ? splitTopLevelCommas(p.slice(k + 1, -1))
          : [p.slice(k)];
      for (const s of specs) {
        const spec = readColumnSpec(s, 0, flavor);
        if (!spec) {
          worse('destructive');
          out.reasons.push('RaSQL could not read the new column');
          continue;
        }
        if (!spec.notNull || spec.hasDefault) out.reasons.push(`adds column ${spec.name}`);
        else {
          worse('destructive');
          out.reasons.push(
            `adds column ${spec.name} as NOT NULL without a default; existing rows get an implicit value`,
          );
        }
      }
      continue;
    }

    if (verb === 'DROP') {
      if (obj && obj.kind === 'word' && DROP_SAFE.has(obj.value)) {
        out.reasons.push(
          `drops ${obj.value === 'FOREIGN' || obj.value === 'CONSTRAINT' || obj.value === 'CHECK' ? 'a constraint' : 'an index'}; no data is lost`,
        );
        continue;
      }
      if (isWord(obj, 'DEFAULT')) {
        out.reasons.push('drops a default');
        continue;
      }
      let k = 1;
      if (isWord(p[k], 'COLUMN')) {
        k++;
        lastObject = 'COLUMN';
      }
      while (isWord(p[k], 'IF', 'EXISTS')) k++;
      const name = p[k] ? nameOf(p[k] as Token) : '?';
      worse('destructive');
      out.reasons.push(
        isWord(obj, 'PARTITION')
          ? 'drops a partition and its rows'
          : `drops column ${name} and its data`,
      );
      continue;
    }

    if (verb === 'MODIFY' || verb === 'CHANGE') {
      let k = 1;
      if (isWord(p[k], 'COLUMN')) k++;
      const oldName = p[k] ? nameOf(p[k] as Token) : '';
      const spec = readColumnSpec(p, verb === 'CHANGE' ? k + 1 : k, flavor);
      if (!spec) {
        worse('destructive');
        out.reasons.push(`RaSQL could not read the ${verb} clause`);
        continue;
      }
      // MySQL redefines the whole column: a missing NOT NULL means NULL is allowed.
      await redefine(oldName, spec, false);
      continue;
    }

    if (verb === 'ALTER') {
      let k = 1;
      if (isWord(p[k], 'COLUMN')) k++;
      const nameTok = p[k];
      const name = nameTok ? nameOf(nameTok) : '';
      const action = p[k + 1];
      if (
        isWord(action, 'SET') &&
        isWord(p[k + 2], 'DEFAULT', 'VISIBLE', 'INVISIBLE', 'STATISTICS', 'STORAGE', 'COMPRESSION')
      ) {
        out.reasons.push(`${name}: changes a column attribute`);
        continue;
      }
      if (isWord(action, 'DROP') && isWord(p[k + 2], 'DEFAULT', 'NOT', 'IDENTITY', 'EXPRESSION')) {
        out.reasons.push(`${name}: ${isWord(p[k + 2], 'NOT') ? 'allows NULL' : 'drops a default'}`);
        continue;
      }
      if (isWord(action, 'SET') && isWord(p[k + 2], 'NOT')) {
        nullCheck(name);
        continue;
      }
      if (isWord(action, 'SET', 'TYPE') && (isWord(action, 'TYPE') || isWord(p[k + 2], 'DATA'))) {
        // PostgreSQL: ALTER COLUMN c [SET DATA] TYPE t [USING …]
        const typeAt = isWord(action, 'TYPE') ? k + 2 : k + 4;
        const spec = readColumnSpec([nameTok as Token, ...p.slice(typeAt)], 0, flavor);
        if (spec) await redefine(name, spec, true);
        else {
          worse('destructive');
          out.reasons.push(`${name}: RaSQL could not read the new type`);
        }
        continue;
      }
      if (flavor === 'mssql' && action) {
        // SQL Server: ALTER COLUMN c type [NULL | NOT NULL]
        const spec = readColumnSpec(p, k, flavor);
        if (spec) await redefine(name, spec, false);
        else {
          worse('destructive');
          out.reasons.push(`${name}: RaSQL could not read the new type`);
        }
        continue;
      }
      worse('destructive');
      out.reasons.push(`${name}: RaSQL does not classify this ALTER COLUMN`);
      continue;
    }

    if (verb === 'RENAME') {
      out.reasons.push('renames; no data is lost');
      continue;
    }

    if (verb === 'CONVERT') {
      // CONVERT TO CHARACTER SET cs: every text column converts.
      const csAt = p.findIndex((tk) => isWord(tk, 'SET', 'CHARSET'));
      const cs = csAt === -1 ? undefined : p[csAt + 1];
      const d = await definition();
      if (!cs || !d) {
        worse('destructive');
        out.reasons.push('RaSQL could not read the conversion');
        continue;
      }
      const target = nameOf(cs).toLowerCase();
      for (const c of d.columns.filter((col) => col.charset))
        apply(c.name, compareCharsets(c.charset, target, flavor));
      continue;
    }

    if (['DEFAULT', 'CHARACTER', 'CHARSET', 'COLLATE'].includes(verb)) {
      out.reasons.push('changes the default character set for new columns');
      continue;
    }
    if (OPTION_SAFE.has(verb)) {
      out.reasons.push(`changes the table option ${verb}`);
      continue;
    }
    if (verb === 'SET' && flavor === 'postgres' && isWord(obj, 'SCHEMA')) {
      worse('destructive');
      out.reasons.push('moves the table to another schema');
      continue;
    }
    worse('destructive');
    out.reasons.push(`RaSQL cannot classify ${verb} with confidence`);
  }
  if (!out.reasons.length) {
    out.safety = 'destructive';
    out.reasons.push('RaSQL found no change it recognizes');
  }
  return out;
}
