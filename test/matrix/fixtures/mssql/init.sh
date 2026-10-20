#!/bin/bash
# Starts SQL Server, loads the RaSQL fixture once, then marks the container ready for the
# healthcheck. The official image has no init-script directory like the MySQL and PostgreSQL ones.
set -u
/opt/mssql/bin/sqlservr &
server=$!
SQLCMD=$(ls /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd 2>/dev/null | head -1)
for _ in $(seq 1 180); do
  "$SQLCMD" -C -S 127.0.0.1 -U sa -P "$MSSQL_SA_PASSWORD" -Q 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
if [ ! -f /var/opt/mssql/rasql-loaded ]; then
  "$SQLCMD" -C -I -b -S 127.0.0.1 -U sa -P "$MSSQL_SA_PASSWORD" -i /fixtures/00-setup.sql &&
    "$SQLCMD" -C -I -b -S 127.0.0.1 -U rasql -P rasql -d rasql -i /fixtures/01-fixture.sql &&
    touch /var/opt/mssql/rasql-loaded
fi
[ -f /var/opt/mssql/rasql-loaded ] && touch /tmp/rasql-ready
wait $server
