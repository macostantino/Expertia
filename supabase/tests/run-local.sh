#!/usr/bin/env bash
# Corre las migraciones + tests SQL contra un Postgres local descartable (PGHOST/PGPORT/PGUSER del entorno).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${DB:-agenda_test}"
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f tests/local_stub.sql
for f in migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1 | grep -v NOTICE || true; done
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f tests/agenda.test.sql 2>&1 | grep -E "OK|ERROR|FALL" || true
