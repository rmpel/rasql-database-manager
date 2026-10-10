import { describe, expect, it } from 'vitest';
import { BASIC_FILTER_OPERATORS, V, type ColumnMeta } from '@rasql/driver-protocol';
import {
  activeFilterCount,
  compileFilters,
  draftsFromFilters,
  emptyFilters,
  groupDrafts,
  inputShape,
  operatorsFor,
  parseMembers,
  searchFilters,
  type FilterDraft,
  type FilterState,
} from './filters';

const col = (name: string, valueType: ColumnMeta['valueType']): ColumnMeta => ({
  name,
  nativeType: valueType,
  valueType,
  nullable: true,
  isPrimaryKey: false,
});

const COLUMNS = [
  col('id', 'int'),
  col('title', 'text'),
  col('status', 'enum'),
  col('flags', 'set'),
  col('published', 'date'),
  col('data', 'bytes'),
];
const MEMBERS = { status: ['draft', 'publish'], flags: ['sticky', 'hidden'] };

let id = 100;
const rule = (
  column: string,
  op: FilterDraft['op'],
  text = '',
  extra: Partial<FilterDraft> = {},
) => ({
  id: id++,
  column,
  op,
  text,
  text2: '',
  values: [],
  ...extra,
});
const state = (drafts: FilterDraft[], more: Partial<FilterState> = {}): FilterState => ({
  ...emptyFilters(),
  drafts,
  ...more,
});

describe('operator menus', () => {
  it('offers text matching first for text and ranges for numbers', () => {
    expect(operatorsFor(col('t', 'text'))[0]).toBe('contains');
    expect(operatorsFor(col('n', 'int'))).toContain('between');
    expect(operatorsFor(col('n', 'int'))).not.toContain('contains');
    expect(operatorsFor(col('e', 'enum'))).toEqual([
      '=',
      '!=',
      'in',
      'not in',
      'is null',
      'is not null',
    ]);
  });

  it('leaves out what the driver cannot build', () => {
    expect(operatorsFor(col('t', 'text'), BASIC_FILTER_OPERATORS)).not.toContain('regexp');
    expect(operatorsFor(col('t', 'text'), [...BASIC_FILTER_OPERATORS, 'regexp'])).toContain(
      'regexp',
    );
    expect(operatorsFor(col('s', 'set'))[0]).toBe('contains');
  });

  it('chooses the input by operator and column kind', () => {
    expect(inputShape('between', 'number', false)).toBe('two');
    expect(inputShape('is empty', 'text', false)).toBe('none');
    expect(inputShape('=', 'enum', true)).toBe('member');
    expect(inputShape('in', 'enum', true)).toBe('members');
    expect(inputShape('in', 'enum', false)).toBe('list');
    expect(inputShape('has member', 'set', true)).toBe('member');
    expect(inputShape('=', 'bool', false)).toBe('bool');
  });
});

describe('compileFilters', () => {
  it('skips unfinished rules instead of matching the empty string', () => {
    expect(compileFilters(state([rule('title', 'contains')]), COLUMNS)).toEqual({
      where: [],
      whereSql: '',
    });
    expect(activeFilterCount(state([rule('title', 'contains')]), COLUMNS)).toBe(0);
  });

  it('types values by column and keeps pattern operators as text', () => {
    const r = compileFilters(
      state([
        rule('id', '>', '5'),
        rule('title', 'starts with', 'wp_'),
        rule('published', 'starts with', '2024-05'),
      ]),
      COLUMNS,
    );
    expect(r).toEqual({
      where: [
        { column: 'id', op: '>', value: V.int('5') },
        { column: 'title', op: 'starts with', value: V.text('wp_') },
        { column: 'published', op: 'starts with', value: V.text('2024-05') },
      ],
      whereSql: '',
    });
    expect(compileFilters(state([rule('id', '=', 'abc')]), COLUMNS)).toEqual({
      error: 'id: Expected an integer',
    });
  });

  it('groups rules on the same column with the chosen match', () => {
    const r = compileFilters(
      state([rule('id', '<', '3'), rule('title', 'contains', 'x'), rule('id', '>', '5')], {
        groupMatch: { id: 'any' },
      }),
      COLUMNS,
    );
    expect(r).toEqual({
      where: [
        {
          match: 'any',
          filters: [
            { column: 'id', op: '<', value: V.int('3') },
            { column: 'id', op: '>', value: V.int('5') },
          ],
        },
        { column: 'title', op: 'contains', value: V.text('x') },
      ],
      whereSql: '',
    });
  });

  it('turns a half-filled between into an open range', () => {
    expect(compileFilters(state([rule('id', 'between', '', { text2: '9' })]), COLUMNS)).toEqual({
      where: [{ column: 'id', op: '<=', value: V.int('9') }],
      whereSql: '',
    });
    expect(compileFilters(state([rule('id', 'not between', '2', { text2: '' })]), COLUMNS)).toEqual(
      {
        where: [{ column: 'id', op: '<', value: V.int('2') }],
        whereSql: '',
      },
    );
    expect(compileFilters(state([rule('id', 'between', '2', { text2: '9' })]), COLUMNS)).toEqual({
      where: [{ column: 'id', op: 'between', value: [V.int('2'), V.int('9')] }],
      whereSql: '',
    });
  });

  it('uses enum and set members', () => {
    const r = compileFilters(
      state([
        rule('status', 'in', '', { values: ['draft', 'publish'] }),
        rule('flags', 'has member', 'sticky'),
      ]),
      COLUMNS,
      MEMBERS,
    );
    expect(r).toEqual({
      where: [
        { column: 'status', op: 'in', value: [V.enum('draft'), V.enum('publish')] },
        { column: 'flags', op: 'has member', value: V.text('sticky') },
      ],
      whereSql: '',
    });
  });

  it('searches text columns, and numeric columns when the term is a number', () => {
    expect(searchFilters('42', COLUMNS)).toEqual([
      { column: 'id', op: '=', value: V.int('42') },
      { column: 'title', op: 'contains', value: V.text('42') },
      { column: 'status', op: 'contains', value: V.text('42') },
      { column: 'flags', op: 'contains', value: V.text('42') },
      { column: 'published', op: 'contains', value: V.text('42') },
    ]);
    const r = compileFilters(state([], { search: 'hello', whereSql: ' a = 1 ' }), COLUMNS);
    expect(r).toEqual({
      where: [
        {
          match: 'any',
          filters: ['title', 'status', 'flags', 'published'].map((c) => ({
            column: c,
            op: 'contains',
            value: V.text('hello'),
          })),
        },
      ],
      whereSql: 'a = 1',
    });
  });
});

describe('helpers', () => {
  it('parses enum and set members', () => {
    expect(parseMembers("enum('draft','it''s','a\\\\b','')")).toEqual([
      'draft',
      "it's",
      'a\\b',
      '',
    ]);
    expect(parseMembers("set('a','b')")).toEqual(['a', 'b']);
    expect(parseMembers('varchar(20)')).toBeNull();
  });

  it('groups drafts by column in order of first appearance', () => {
    const a = rule('id', '>', '1');
    const b = rule('title', 'contains', 'x');
    const c = rule('id', '<', '9');
    expect(groupDrafts([a, b, c]).map((g) => [g.column, g.drafts.length])).toEqual([
      ['id', 2],
      ['title', 1],
    ]);
  });

  it('turns foreign-key filters back into drafts', () => {
    const s = draftsFromFilters([{ column: 'post_id', op: '=', value: V.int('7') }]);
    expect(s.drafts[0]).toMatchObject({ column: 'post_id', op: '=', text: '7' });
    expect(s.search).toBe('');
  });
});
