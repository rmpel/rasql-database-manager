import { describe, expect, it } from 'vitest';
import {
  V,
  type AlterCapabilities,
  type TableDefinition,
  type TypeDescriptor,
} from '@rasql/driver-protocol';
import {
  buildNativeType,
  destructive,
  diffStructure,
  draftFromDefinition,
  draftProblem,
  formatDefault,
  kindLabel,
  kindOf,
  kindsFor,
  newColumnDraft,
  parseNativeType,
  partsForKind,
  typesOfKind,
} from './structure';

const TYPES: TypeDescriptor[] = [
  { name: 'TINYINT', category: 'integer', hasLength: true, unsignedAllowed: true },
  { name: 'INT', category: 'integer', hasLength: true, unsignedAllowed: true },
  { name: 'BIGINT', category: 'integer', hasLength: true, unsignedAllowed: true },
  {
    name: 'DECIMAL',
    category: 'decimal',
    hasPrecision: true,
    hasScale: true,
    unsignedAllowed: true,
  },
  { name: 'DOUBLE', category: 'float', unsignedAllowed: true },
  { name: 'VARCHAR', category: 'text', hasLength: true },
  { name: 'LONGTEXT', category: 'text' },
  { name: 'DATETIME', category: 'datetime', hasPrecision: true },
  { name: 'TIMESTAMP', category: 'datetime', hasPrecision: true },
  { name: 'ENUM', category: 'enum', hasValues: true },
];

const ALL: AlterCapabilities = {
  addColumn: true,
  dropColumn: true,
  renameColumn: true,
  modifyColumn: true,
  moveColumn: true,
  indexes: true,
  primaryKey: true,
  foreignKeys: true,
  tableComment: true,
  columnComments: true,
  renameTable: true,
  collations: true,
};

const TABLE: TableDefinition = {
  schema: 'wp',
  name: 'wp_posts',
  kind: 'table',
  columns: [
    {
      name: 'ID',
      ordinal: 1,
      nativeType: 'bigint(20) unsigned',
      valueType: 'int',
      nullable: false,
      autoIncrement: true,
    },
    {
      name: 'post_title',
      ordinal: 2,
      nativeType: 'varchar(200)',
      valueType: 'text',
      nullable: false,
      autoIncrement: false,
      default: V.text(''),
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_520_ci',
    },
    {
      name: 'post_status',
      ordinal: 3,
      nativeType: "enum('publish','draft','it''s')",
      valueType: 'enum',
      nullable: false,
      autoIncrement: false,
      default: V.enum('publish'),
    },
    {
      name: 'menu_order',
      ordinal: 4,
      nativeType: 'int(11)',
      valueType: 'int',
      nullable: false,
      autoIncrement: false,
      default: V.int('0'),
    },
    {
      name: 'modified',
      ordinal: 5,
      nativeType: 'TIMESTAMP',
      valueType: 'datetime',
      nullable: false,
      autoIncrement: false,
      default: { t: 'expression', sql: 'CURRENT_TIMESTAMP' },
      extra: 'on update CURRENT_TIMESTAMP',
    },
  ],
  indexes: [{ name: 'PRIMARY', unique: true, primary: true, columns: [{ name: 'ID' }] }],
  foreignKeys: [],
  options: {},
};

describe('type parts', () => {
  it('parses and rebuilds native types without losing anything', () => {
    for (const native of [
      'bigint(20) unsigned',
      'decimal(10,2)',
      'varchar(200)',
      "enum('publish','draft','it''s')",
      'datetime(6)',
      'longtext',
      'int unsigned zerofill',
    ]) {
      // Rebuilt in upper case; the parts are what matter.
      expect(buildNativeType(parseNativeType(native, TYPES), TYPES)).toBe(
        native.replace(/^[a-z]+|unsigned|zerofill/g, (w) => w.toUpperCase()),
      );
    }
    expect(parseNativeType("enum('a','it''s')", TYPES).values).toEqual(['a', "it's"]);
    expect(parseNativeType('decimal(10,2) unsigned', TYPES)).toMatchObject({
      base: 'DECIMAL',
      precision: '10',
      scale: '2',
      unsigned: true,
    });
  });

  it('groups types by kind and picks sensible ones for a new kind', () => {
    expect(kindOf(TYPES, 'BIGINT')?.label).toBe('Whole number');
    const label = (id: string): string =>
      kindLabel(
        kindsFor(TYPES).find((k) => k.id === id)!,
        TYPES,
      );
    expect(label('float')).toBe('Approximate number (DOUBLE)');
    expect(label('integer')).toBe('Whole number (INT, BIGINT, TINYINT)');
    expect(label('text')).toBe('Text (VARCHAR, LONGTEXT)');
    expect(label('choice')).toBe('Choice from a list (ENUM)');
    expect(typesOfKind(TYPES, 'integer').map((t) => t.name)).toEqual(['TINYINT', 'INT', 'BIGINT']);
    expect(partsForKind(TYPES, 'text')).toMatchObject({ base: 'VARCHAR', length: '255' });
    expect(partsForKind(TYPES, 'decimal')).toMatchObject({ precision: '10', scale: '2' });
  });

  it('shows defaults the way people read them', () => {
    expect(formatDefault(V.text(''))).toBe("'' (empty)");
    expect(formatDefault(V.int('0'))).toBe('0');
    expect(formatDefault(V.null())).toBe('NULL');
    expect(formatDefault({ t: 'expression', sql: 'CURRENT_TIMESTAMP' })).toBe('CURRENT_TIMESTAMP');
    expect(formatDefault(V.datetime('0000-00-00 00:00:00'))).toBe('0000-00-00 00:00:00');
    expect(formatDefault(undefined)).toBe('');
  });
});

describe('diffStructure', () => {
  it('finds no changes in an untouched draft', () => {
    expect(diffStructure(TABLE, draftFromDefinition(TABLE, TYPES), TYPES, ALL)).toEqual([]);
  });

  it('turns edits into modify, add, drop, move and index changes', () => {
    const d = draftFromDefinition(TABLE, TYPES);
    const [id, title, status, order, modified] = d.columns;
    title!.type = { ...title!.type, length: '255' };
    title!.name = 'title';
    order!.dropped = true;
    status!.type = { ...status!.type, values: ['publish', 'draft', 'private'] };
    const added = newColumnDraft(TYPES, ['ID']);
    added.name = 'views';
    added.type = { ...partsForKind(TYPES, 'integer'), unsigned: true };
    added.nullable = false;
    added.defaultMode = 'value';
    added.defaultText = '0';
    // Move modified to the front, add the new column after the title.
    d.columns = [modified!, id!, title!, added, status!, order!];
    d.indexes.push({
      key: 'x',
      original: null,
      name: 'by_status',
      kind: 'index',
      columns: [{ name: 'post_status', length: '' }],
      dropped: false,
    });
    const changes = diffStructure(TABLE, d, TYPES, ALL);
    expect(changes).toEqual([
      { kind: 'dropColumn', name: 'menu_order' },
      {
        kind: 'modifyColumn',
        name: 'modified',
        column: expect.objectContaining({
          name: 'modified',
          nativeType: 'TIMESTAMP',
          extra: 'on update CURRENT_TIMESTAMP',
        }),
        after: null,
      },
      {
        kind: 'modifyColumn',
        name: 'post_title',
        column: expect.objectContaining({
          name: 'title',
          nativeType: 'VARCHAR(255)',
          default: V.text(''),
          collation: 'utf8mb4_unicode_520_ci',
        }),
      },
      {
        kind: 'addColumn',
        column: expect.objectContaining({
          name: 'views',
          nativeType: 'INT UNSIGNED',
          nullable: false,
          default: V.int('0'),
        }),
        after: 'title',
      },
      {
        kind: 'modifyColumn',
        name: 'post_status',
        column: expect.objectContaining({ nativeType: "ENUM('publish','draft','private')" }),
      },
      {
        kind: 'addIndex',
        index: {
          name: 'by_status',
          unique: false,
          primary: false,
          columns: [{ name: 'post_status' }],
        },
      },
    ]);
    expect(destructive(TABLE, changes)).toEqual([
      'Column menu_order and all its data are removed.',
      'Column post_title changes from varchar(200) to VARCHAR(255); values that do not fit are cut off or rejected.',
      "Column post_status changes from enum('publish','draft','it''s') to ENUM('publish','draft','private'); values that do not fit are cut off or rejected.",
    ]);
  });

  it('asks only for a rename when the driver cannot modify in place', () => {
    const d = draftFromDefinition(TABLE, TYPES);
    d.columns[3]!.name = 'sort_order';
    expect(
      diffStructure(TABLE, d, TYPES, { ...ALL, modifyColumn: false, moveColumn: false }),
    ).toEqual([{ kind: 'renameColumn', from: 'menu_order', to: 'sort_order' }]);
  });

  it('reports what keeps a draft from applying', () => {
    const d = draftFromDefinition(TABLE, TYPES);
    d.columns[1]!.name = 'ID';
    expect(draftProblem(d, TYPES)).toBe('Two columns are called ID');
    d.columns[1]!.name = 'title';
    d.columns[2]!.type = { ...d.columns[2]!.type, values: [] };
    expect(draftProblem(d, TYPES)).toBe('post_status: List at least one value');
  });
});
