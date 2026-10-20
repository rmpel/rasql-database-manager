-- RaSQL engine-matrix fixture for SQL Server, loaded into database rasql as login rasql by
-- every mssql service in test/matrix/docker-compose.yml. Must load on SQL Server 2019 and later.
SET NOCOUNT ON;
GO

-- ---------------------------------------------------------------------------
-- kinds: one column of every type RaSQL must render
-- ---------------------------------------------------------------------------
CREATE TABLE kinds (
  id bigint IDENTITY(1,1) PRIMARY KEY,
  tiny tinyint,
  small smallint,
  normal int,
  big bigint,
  decim decimal(20, 6),
  price money,
  f real,
  d float,
  flag bit,
  c char(5),
  vc varchar(100),
  nvc nvarchar(100),
  nmax nvarchar(max),
  b varbinary(16),
  bmax varbinary(max),
  dt date,
  tm time(7),
  dtt datetime,
  dt2 datetime2(7),
  dt3 datetime2(3),
  sdt smalldatetime,
  dto datetimeoffset(7),
  u uniqueidentifier,
  x xml,
  rv rowversion
);
GO
INSERT INTO kinds (tiny, small, normal, big, decim, price, f, d, flag, c, vc, nvc, nmax, b, bmax, dt, tm, dtt,
  dt2, dt3, sdt, dto, u, x) VALUES
  (255, -32768, 2147483647, -9223372036854775807, 12345678.567891, 1234.5678, 1.5, 2.25, 1, 'abc', 'plain',
   N'héllo ☃ 🦈', N'text ☃', 0x00FF0102, 0x00FF, '2024-02-29', '12:34:56.1234567', '2024-02-29 13:14:15.997',
   '2024-02-29 13:14:15.1234567', '2024-02-29 13:14:15.123', '2024-02-29 13:14:00', '2024-02-29 13:14:15.1234567 +02:00',
   '6F9619FF-8B86-D011-B42D-00C04FC964FF', N'<a b="1">x</a>');
INSERT INTO kinds (tiny) VALUES (NULL);
GO

-- ---------------------------------------------------------------------------
-- parents / children: foreign keys, defaults, computed column, filtered index, comments
-- ---------------------------------------------------------------------------
CREATE TABLE parents (
  id int IDENTITY(1,1) CONSTRAINT PK_parents PRIMARY KEY,
  name nvarchar(50) NOT NULL CONSTRAINT UQ_parents_name UNIQUE,
  created_at datetime2(0) NOT NULL CONSTRAINT DF_parents_created_at DEFAULT (sysutcdatetime())
);
CREATE TABLE children (
  id int IDENTITY(1,1) CONSTRAINT PK_children PRIMARY KEY,
  parent_id int NOT NULL,
  label nvarchar(50) NOT NULL CONSTRAINT DF_children_label DEFAULT N'none',
  position int NOT NULL DEFAULT 0,
  score decimal(5, 2) NULL DEFAULT -1.5,
  full_label AS (label + N' #' + CAST(position AS nvarchar(10))),
  CONSTRAINT fk_children_parent FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE,
  CONSTRAINT uq_parent_position UNIQUE (parent_id, position)
);
CREATE INDEX idx_parent_label ON children (parent_id, label DESC);
CREATE INDEX idx_positive ON children (label) WHERE position > 0;
EXEC sys.sp_addextendedproperty N'MS_Description', N'Has a foreign key to parents', N'SCHEMA', N'dbo', N'TABLE', N'children';
EXEC sys.sp_addextendedproperty N'MS_Description', N'Shown in lists', N'SCHEMA', N'dbo', N'TABLE', N'children', N'COLUMN', N'label';
INSERT INTO parents (name) VALUES (N'first'), (N'second');
INSERT INTO children (parent_id, label, position) VALUES (1, N'alpha', 0), (1, N'beta', 1), (2, N'gamma', 0);
GO
CREATE VIEW children_view AS
  SELECT c.id, c.label, p.name AS parent FROM children c JOIN parents p ON p.id = c.parent_id;
GO

-- ---------------------------------------------------------------------------
-- wp_options: WordPress on SQL Server keeps its tables in dbo
-- ---------------------------------------------------------------------------
CREATE TABLE wp_options (
  option_id bigint IDENTITY(1,1) PRIMARY KEY,
  option_name nvarchar(191) NOT NULL DEFAULT N'' UNIQUE,
  option_value nvarchar(max) NOT NULL,
  autoload nvarchar(20) NOT NULL DEFAULT N'yes'
);
INSERT INTO wp_options (option_name, option_value, autoload) VALUES
  (N'siteurl', N'http://example.test', N'yes'),
  (N'active_plugins', N'a:2:{i:0;s:19:"akismet/akismet.php";i:1;s:9:"hello.php";}', N'yes'),
  (N'widget_text', N'a:1:{s:5:"title";s:6:"Héllo";}', N'no');
GO

-- ---------------------------------------------------------------------------
-- many: 100,000 rows for scrolling, cancellation and the virtual grid
-- ---------------------------------------------------------------------------
CREATE TABLE many (id int IDENTITY(1,1) PRIMARY KEY, v nvarchar(40) NOT NULL, n int NOT NULL);
WITH d AS (SELECT n FROM (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) t(n)),
  seq AS (SELECT a.n + 10 * b.n + 100 * c.n + 1000 * e.n + 10000 * f.n + 1 AS i FROM d a, d b, d c, d e, d f)
INSERT INTO many (v, n) SELECT N'row ' + CAST(i AS nvarchar(10)), i % 1000 FROM seq ORDER BY i;
GO

-- ---------------------------------------------------------------------------
-- Routines, trigger, sequence, a second schema
-- ---------------------------------------------------------------------------
CREATE FUNCTION dbo.child_count (@pid int) RETURNS int AS
BEGIN
  RETURN (SELECT COUNT(*) FROM children WHERE parent_id = @pid);
END
GO
CREATE FUNCTION dbo.children_of (@pid int) RETURNS TABLE AS
  RETURN SELECT id, label FROM children WHERE parent_id = @pid;
GO
CREATE PROCEDURE dbo.fill_many @cnt int AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @i int = 0;
  WHILE @i < @cnt
  BEGIN
    INSERT INTO many (v, n) VALUES (N'extra ' + CAST(@i AS nvarchar(10)), @i % 1000);
    SET @i += 1;
  END
END
GO
CREATE TRIGGER trg_children_ai ON children AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  UPDATE c SET label = LTRIM(RTRIM(c.label)) FROM children c JOIN inserted i ON i.id = c.id;
END
GO
CREATE SEQUENCE invoice_numbers AS int START WITH 1000 INCREMENT BY 10;
GO
CREATE SCHEMA sales;
GO
CREATE TABLE sales.orders (id int IDENTITY(1,1) PRIMARY KEY, total decimal(10, 2) NOT NULL);
GO
