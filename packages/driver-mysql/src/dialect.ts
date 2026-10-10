import {
  BASIC_FILTER_OPERATORS,
  DriverError,
  type DialectInfo,
  type Filter,
  type TypeDescriptor,
  type Value,
} from '@rasql/driver-protocol';
import { BaseDialect, formatLiteral } from '@rasql/driver-sdk';

const KEYWORDS = (
  'ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY CALL ' +
  'CASCADE CASE CHANGE CHAR CHARACTER CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS ' +
  'CUBE CUME_DIST CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DATABASES DAY_HOUR ' +
  'DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC DECIMAL DECLARE DEFAULT DELAYED DELETE DENSE_RANK DESC DESCRIBE ' +
  'DETERMINISTIC DISTINCT DISTINCTROW DIV DOUBLE DROP DUAL EACH ELSE ELSEIF EMPTY ENCLOSED ESCAPED EXCEPT EXISTS ' +
  'EXIT EXPLAIN FALSE FETCH FIRST_VALUE FLOAT FLOAT4 FLOAT8 FOR FORCE FOREIGN FROM FULLTEXT FUNCTION GENERATED ' +
  'GET GRANT GROUP GROUPING GROUPS HAVING HIGH_PRIORITY HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE IN ' +
  'INDEX INFILE INNER INOUT INSENSITIVE INSERT INT INT1 INT2 INT3 INT4 INT8 INTEGER INTERSECT INTERVAL INTO ' +
  'IO_AFTER_GTIDS IO_BEFORE_GTIDS IS ITERATE JOIN JSON_TABLE KEY KEYS KILL LAG LAST_VALUE LATERAL LEAD LEADING ' +
  'LEAVE LEFT LIKE LIMIT LINEAR LINES LOAD LOCALTIME LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP ' +
  'LOW_PRIORITY MASTER_BIND MASTER_SSL_VERIFY_SERVER_CERT MATCH MAXVALUE MEDIUMBLOB MEDIUMINT MEDIUMTEXT ' +
  'MIDDLEINT MINUTE_MICROSECOND MINUTE_SECOND MOD MODIFIES NATURAL NOT NO_WRITE_TO_BINLOG NTH_VALUE NTILE NULL ' +
  'NUMERIC OF ON OPTIMIZE OPTIMIZER_COSTS OPTION OPTIONALLY OR ORDER OUT OUTER OUTFILE OVER PARTITION ' +
  'PERCENT_RANK PRECISION PRIMARY PROCEDURE PURGE RANGE RANK READ READS READ_WRITE REAL RECURSIVE REFERENCES ' +
  'REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT RETURN REVOKE RIGHT RLIKE ROW ROWS ' +
  'ROW_NUMBER SCHEMA SCHEMAS SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR SET SHOW SIGNAL SMALLINT SPATIAL ' +
  'SPECIFIC SQL SQLEXCEPTION SQLSTATE SQLWARNING SQL_BIG_RESULT SQL_CALC_FOUND_ROWS SQL_SMALL_RESULT SSL ' +
  'STARTING STORED STRAIGHT_JOIN SYSTEM TABLE TERMINATED THEN TINYBLOB TINYINT TINYTEXT TO TRAILING TRIGGER ' +
  'TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING UTC_DATE UTC_TIME UTC_TIMESTAMP VALUES ' +
  'VARBINARY VARCHAR VARCHARACTER VARYING VIRTUAL WHEN WHERE WHILE WINDOW WITH WRITE XOR YEAR_MONTH ZEROFILL'
).split(' ');

const TYPES: TypeDescriptor[] = [
  { name: 'TINYINT', category: 'integer', hasLength: true, unsignedAllowed: true },
  { name: 'SMALLINT', category: 'integer', hasLength: true, unsignedAllowed: true },
  { name: 'MEDIUMINT', category: 'integer', hasLength: true, unsignedAllowed: true },
  { name: 'INT', category: 'integer', hasLength: true, unsignedAllowed: true },
  { name: 'BIGINT', category: 'integer', hasLength: true, unsignedAllowed: true },
  {
    name: 'DECIMAL',
    category: 'decimal',
    hasPrecision: true,
    hasScale: true,
    unsignedAllowed: true,
  },
  { name: 'FLOAT', category: 'float', unsignedAllowed: true },
  { name: 'DOUBLE', category: 'float', unsignedAllowed: true },
  { name: 'BIT', category: 'bit', hasLength: true },
  { name: 'BOOLEAN', category: 'boolean' },
  { name: 'CHAR', category: 'text', hasLength: true },
  { name: 'VARCHAR', category: 'text', hasLength: true },
  { name: 'TINYTEXT', category: 'text' },
  { name: 'TEXT', category: 'text' },
  { name: 'MEDIUMTEXT', category: 'text' },
  { name: 'LONGTEXT', category: 'text' },
  { name: 'BINARY', category: 'binary', hasLength: true },
  { name: 'VARBINARY', category: 'binary', hasLength: true },
  { name: 'TINYBLOB', category: 'binary' },
  { name: 'BLOB', category: 'binary' },
  { name: 'MEDIUMBLOB', category: 'binary' },
  { name: 'LONGBLOB', category: 'binary' },
  { name: 'DATE', category: 'date' },
  { name: 'TIME', category: 'time', hasPrecision: true },
  { name: 'DATETIME', category: 'datetime', hasPrecision: true },
  { name: 'TIMESTAMP', category: 'datetime', hasPrecision: true },
  { name: 'YEAR', category: 'integer' },
  { name: 'ENUM', category: 'enum', hasValues: true },
  { name: 'SET', category: 'set', hasValues: true },
  { name: 'JSON', category: 'json' },
  { name: 'GEOMETRY', category: 'spatial' },
  { name: 'POINT', category: 'spatial' },
  { name: 'LINESTRING', category: 'spatial' },
  { name: 'POLYGON', category: 'spatial' },
  { name: 'MULTIPOINT', category: 'spatial' },
  { name: 'MULTILINESTRING', category: 'spatial' },
  { name: 'MULTIPOLYGON', category: 'spatial' },
  { name: 'GEOMETRYCOLLECTION', category: 'spatial' },
];

export class MysqlDialect extends BaseDialect {
  describe(): DialectInfo {
    return {
      id: 'mysql',
      identifierQuote: '`',
      keywords: KEYWORDS,
      types: TYPES,
      pingSql: 'SELECT 1',
      filterOperators: [...BASIC_FILTER_OPERATORS, 'regexp', 'not regexp', 'has member'],
    };
  }

  protected override filterToSql(f: Filter): string {
    if (f.op !== 'regexp' && f.op !== 'not regexp' && f.op !== 'has member')
      return super.filterToSql(f);
    if (f.value === undefined || Array.isArray(f.value))
      throw new DriverError('UNSUPPORTED', `Filter ${f.op} on ${f.column} needs one value`);
    const col = this.quoteIdentifier(f.column);
    const value = this.quoteLiteral(f.value);
    if (f.op === 'has member') return `FIND_IN_SET(${value}, ${col}) > 0`;
    return `${col} ${f.op === 'regexp' ? 'REGEXP' : 'NOT REGEXP'} ${value}`;
  }

  quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  quoteLiteral(v: Value): string {
    if (v.t === 'geometry') {
      const hex = Array.from(v.v, (x) => x.toString(16).padStart(2, '0')).join('');
      return `ST_GeomFromWKB(X'${hex}'${v.srid === undefined ? '' : `, ${v.srid}`})`;
    }
    return formatLiteral(v, { hex: 'x-quote', booleans: 'numeric', escapeBackslashes: true });
  }
}
