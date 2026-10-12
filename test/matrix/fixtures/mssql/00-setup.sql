-- Run as sa: the database and the login every test uses. CHECK_POLICY OFF allows the
-- password "rasql", the same as every other engine in the matrix.
CREATE DATABASE rasql COLLATE SQL_Latin1_General_CP1_CI_AS;
GO
CREATE LOGIN rasql WITH PASSWORD = 'rasql', CHECK_POLICY = OFF, DEFAULT_DATABASE = rasql;
GO
USE rasql;
CREATE USER rasql FOR LOGIN rasql;
ALTER ROLE db_owner ADD MEMBER rasql;
GRANT SHOWPLAN TO rasql;
GO
