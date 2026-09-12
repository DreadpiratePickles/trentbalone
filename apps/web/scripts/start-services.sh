#!/usr/bin/env bash
# Bootstrap Postgres + Redis for the Trent app inside this reset-prone container.
# System packages live under /usr (wiped on container reset) but data + this
# script live under /app (persistent). Re-run any time the DB/redis are down.
set -e

PG_BIN_DIR="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1)"
PG_DATA="/app/.runtime/pgdata"
PG_LOG="/app/.runtime/pg.log"
REDIS_LOG="/app/.runtime/redis.log"

mkdir -p /app/.runtime

# Reinstall binaries if a container reset wiped them.
if [ -z "$PG_BIN_DIR" ] || [ ! -x "$PG_BIN_DIR/postgres" ] || ! command -v redis-server >/dev/null 2>&1; then
  echo "[start-services] postgres/redis binaries missing — reinstalling…"
  apt-get install -y postgresql postgresql-contrib redis-server >/tmp/dbreinstall.log 2>&1 || true
  PG_BIN_DIR="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | head -1)"
fi

# Initialise the persistent data dir on first run.
if [ ! -f "$PG_DATA/PG_VERSION" ]; then
  echo "[start-services] initialising postgres data dir at $PG_DATA"
  mkdir -p "$PG_DATA"
  chown -R postgres:postgres /app/.runtime 2>/dev/null || true
  su postgres -c "$PG_BIN_DIR/initdb -D $PG_DATA -U postgres --auth=trust" >/dev/null 2>&1 || \
    "$PG_BIN_DIR/initdb" -D "$PG_DATA" -U postgres --auth=trust >/dev/null 2>&1
fi
chown -R postgres:postgres /app/.runtime 2>/dev/null || true

# Start postgres if not already listening.
if ! "$PG_BIN_DIR/pg_isready" -h localhost -p 5432 >/dev/null 2>&1; then
  echo "[start-services] starting postgres…"
  su postgres -c "$PG_BIN_DIR/pg_ctl -D $PG_DATA -l $PG_LOG -o '-c listen_addresses=localhost -p 5432' -w start" 2>/dev/null || \
    "$PG_BIN_DIR/pg_ctl" -D "$PG_DATA" -l "$PG_LOG" -o "-c listen_addresses=localhost -p 5432" -w start
fi

# Ensure the trent role + database exist.
"$PG_BIN_DIR/psql" -h localhost -U postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='trent'" | grep -q 1 || \
  "$PG_BIN_DIR/psql" -h localhost -U postgres -c "CREATE USER trent WITH PASSWORD 'trentdev' SUPERUSER;"
"$PG_BIN_DIR/psql" -h localhost -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='trent'" | grep -q 1 || \
  "$PG_BIN_DIR/psql" -h localhost -U postgres -c "CREATE DATABASE trent OWNER trent;"

# Start redis if not already up.
if ! redis-cli ping >/dev/null 2>&1; then
  echo "[start-services] starting redis…"
  redis-server --daemonize yes --dir /app/.runtime --logfile "$REDIS_LOG" >/dev/null 2>&1
fi

echo "[start-services] ready: postgres=$("$PG_BIN_DIR/pg_isready" -h localhost -p 5432 2>&1 | tail -1) redis=$(redis-cli ping 2>&1)"
