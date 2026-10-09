-- RaSQL engine-matrix fixture. Loaded by every engine in test/matrix/docker-compose.yml.
-- Every awkward value docs/ARCHITECTURE.md section 10 lists. Must load on MySQL 5.7 (the
-- strictest of the set), MySQL 8.x, MariaDB 10.6+ and Percona 8.0 without edits.

USE rasql;
SET NAMES utf8mb4;
SET time_zone = '+00:00';
-- Zero dates, out-of-range TIME and friends need the lenient mode.
SET sql_mode = '';

-- ---------------------------------------------------------------------------
-- kinds: one column of every type RaSQL must render
-- ---------------------------------------------------------------------------
CREATE TABLE kinds (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tiny TINYINT NOT NULL DEFAULT 0,
  flag TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'looks like a boolean, is not',
  small SMALLINT UNSIGNED NULL,
  medium MEDIUMINT NULL,
  normal INT NULL,
  big BIGINT NULL,
  ubig BIGINT UNSIGNED NULL,
  decim DECIMAL(20,6) NULL,
  f FLOAT NULL,
  d DOUBLE NULL,
  bits BIT(7) NULL,
  c CHAR(3) NULL,
  vc VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  latin VARCHAR(255) CHARACTER SET latin1 NULL COMMENT 'holds utf8 bytes, the WordPress mess',
  bin BINARY(4) NULL,
  vbin VARBINARY(16) NULL COMMENT 'holds invalid utf-8',
  tb TINYBLOB NULL,
  b BLOB NULL,
  mb MEDIUMBLOB NULL,
  lb LONGBLOB NULL,
  tt TINYTEXT NULL,
  t TEXT NULL,
  mt MEDIUMTEXT NULL,
  lt LONGTEXT NULL,
  en ENUM('one','two','three') NULL,
  st SET('a','b','c') NULL,
  dt DATE NULL,
  tm TIME NULL,
  tm6 TIME(6) NULL,
  dtt DATETIME NULL,
  dtt6 DATETIME(6) NULL,
  ts TIMESTAMP NULL DEFAULT NULL,
  ts6 TIMESTAMP(6) NULL DEFAULT NULL,
  yr YEAR NULL,
  js JSON NULL,
  geo GEOMETRY NULL,
  pt POINT NULL,
  note VARCHAR(10) NULL DEFAULT 'dflt' COMMENT 'a column comment',
  PRIMARY KEY (id),
  UNIQUE KEY uq_c (c),
  KEY idx_small_vc (small, vc(10))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Every column type RaSQL must render';

INSERT INTO kinds (tiny, flag, small, medium, normal, big, ubig, decim, f, d, bits, c, vc, latin, bin, vbin,
  tb, b, mb, lb, tt, t, mt, lt, en, st, dt, tm, tm6, dtt, dtt6, ts, ts6, yr, js, geo, pt, note)
VALUES (
  -128, 1, 65535, -8388608, 2147483647, -9223372036854775807, 18446744073709551615,
  12345678901234.567891, 1.5, 2.25, b'1010101', 'abc', 'héllo ☃ 🦈', X'C3A9C3A8', X'00FF0102', X'FFFE41',
  X'00FF', X'00FF', X'00FF', X'00FF', 'tiny text', 'text ☃', 'medium text', 'long text',
  'two', 'a,c', '2024-02-29', '12:34:56', '12:34:56.123456', '2024-02-29 13:14:15',
  '2024-02-29 13:14:15.123456', '2024-02-29 13:14:15', '2024-02-29 13:14:15.654321', 2024,
  '{"a":1,"b":[1,2,3],"s":"héllo"}', ST_GeomFromText('LINESTRING(0 0,1 1)'), ST_GeomFromText('POINT(1 2)'), 'x'
);

-- All NULLs (the unique key tolerates several NULLs).
INSERT INTO kinds (tiny, flag) VALUES (0, 0);

-- Zero dates, negative and over-24h TIME, empty SET, YEAR 0000.
INSERT INTO kinds (tiny, flag, small, c, vc, latin, en, st, dt, tm, tm6, dtt, dtt6, yr)
VALUES (1, 1, 1, 'zzz', 'zero dates', 'plain', 'one', '', '0000-00-00', '-838:59:59', '100:00:00.5',
  '0000-00-00 00:00:00', '0000-00-00 00:00:00.000000', 0000);

-- ---------------------------------------------------------------------------
-- parents / children: foreign keys, composite index with prefix, generated column, triggers
-- ---------------------------------------------------------------------------
CREATE TABLE parents (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE children (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id INT UNSIGNED NOT NULL,
  label VARCHAR(50) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  full_label VARCHAR(80) GENERATED ALWAYS AS (CONCAT(label, '-', position)) VIRTUAL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_parent_position (parent_id, position),
  KEY idx_parent_label (parent_id, label(5)),
  CONSTRAINT fk_children_parent FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Has a foreign key to parents';

INSERT INTO parents (name) VALUES ('first'), ('second');
INSERT INTO children (parent_id, label, position) VALUES (1, 'alpha', 0), (1, 'beta', 1), (2, 'gamma', 0);

CREATE VIEW children_view AS
  SELECT c.id, c.label, c.position, p.name AS parent_name
  FROM children c JOIN parents p ON p.id = c.parent_id;

-- ---------------------------------------------------------------------------
-- wp_options: what a WordPress developer looks at fifty times a day
-- ---------------------------------------------------------------------------
CREATE TABLE wp_options (
  option_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  option_name VARCHAR(191) NOT NULL DEFAULT '',
  option_value LONGTEXT NOT NULL,
  autoload VARCHAR(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (option_id),
  UNIQUE KEY option_name (option_name),
  KEY autoload (autoload)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO wp_options (option_name, option_value, autoload) VALUES
  ('siteurl', 'https://example.test', 'yes'),
  ('active_plugins', 'a:2:{i:0;s:19:"akismet/akismet.php";i:1;s:9:"hello.php";}', 'yes'),
  ('widget_text', 'a:2:{i:2;a:3:{s:5:"title";s:5:"héllo";s:4:"text";s:3:"☃🦈";s:6:"filter";b:0;}s:12:"_multiwidget";i:1;}', 'yes'),
  ('rasql_json', '{"nested":{"deep":[1,2,{"x":null}]}}', 'no');

-- ---------------------------------------------------------------------------
-- many: 100,000 rows for scrolling, cancellation and the virtual grid
-- ---------------------------------------------------------------------------
CREATE TABLE many (
  i INT UNSIGNED NOT NULL AUTO_INCREMENT,
  v VARCHAR(64) NOT NULL,
  n INT NOT NULL,
  PRIMARY KEY (i),
  KEY idx_n (n)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE seq10 (d TINYINT NOT NULL PRIMARY KEY);
INSERT INTO seq10 VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9);

INSERT INTO many (v, n)
SELECT CONCAT('row ', a.d + b.d*10 + c.d*100 + d.d*1000 + e.d*10000),
       (a.d + b.d*10 + c.d*100 + d.d*1000 + e.d*10000) MOD 1000
FROM seq10 a, seq10 b, seq10 c, seq10 d, seq10 e;

DROP TABLE seq10;

-- ---------------------------------------------------------------------------
-- Routines, trigger, event
-- ---------------------------------------------------------------------------
DELIMITER //

CREATE PROCEDURE fill_many(IN cnt INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  START TRANSACTION;
  WHILE i < cnt DO
    INSERT INTO many (v, n) VALUES (CONCAT('extra ', i), i MOD 1000);
    SET i = i + 1;
  END WHILE;
  COMMIT;
END //

CREATE FUNCTION child_count(pid INT UNSIGNED) RETURNS INT
READS SQL DATA DETERMINISTIC
BEGIN
  DECLARE n INT;
  SELECT COUNT(*) INTO n FROM children WHERE parent_id = pid;
  RETURN n;
END //

CREATE TRIGGER trg_children_bi BEFORE INSERT ON children
FOR EACH ROW
BEGIN
  SET NEW.label = TRIM(NEW.label);
END //

CREATE EVENT ev_touch_parents
ON SCHEDULE EVERY 1 DAY
DO
  UPDATE parents SET updated_at = NOW() WHERE 0 //

DELIMITER ;

-- Fresh row estimates for information_schema.TABLES.
ANALYZE TABLE many, kinds, children, parents, wp_options;
