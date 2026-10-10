#!/usr/bin/env bash
# Runs all migrations (then supabase/sql/*.sql) + seed + checks on a throwaway local Postgres (needs PostGIS).
# Usage: npm run test:db   (or DATABASE_URL=postgres://... to use an existing empty DB)
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="ppi_test_$$"
ADMIN_URL="${DATABASE_URL:-postgres:///postgres}"

psql "$ADMIN_URL" -qc "create database $DB_NAME" >/dev/null
trap 'psql "$ADMIN_URL" -qc "drop database if exists $DB_NAME" >/dev/null' EXIT
URL="${ADMIN_URL%/*}/$DB_NAME"

run() { psql "$URL" -q -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }

run tests/supabase_shim.sql
for f in migrations/*.sql; do
  echo "migration: $f"
  run "$f"
done
# From update 22 on, each phase has one file in sql/ that the owner pastes into the SQL Editor.
for f in sql/*.sql; do
  [ -e "$f" ] || continue
  echo "sql: $f"
  run "$f"
done
run seed.sql
psql "$URL" -q -v ON_ERROR_STOP=1 -f tests/database_test.sql
