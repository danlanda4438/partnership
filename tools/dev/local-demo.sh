#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY. Builds a throwaway database with the Supabase test stub, all
# migrations and fictional demo data, then starts the web app reading it as the demo owner.
# Nothing here touches the real Supabase project.
#
#   LOCAL_PG=postgres://postgres@localhost:54329 tools/dev/local-demo.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
PG=${LOCAL_PG:-postgres://postgres@localhost:54329}
DB=${LOCAL_DEMO_DB:-gleeday_demo}
PORT=${PORT:-3210}

psql "$PG/postgres" -q -c "drop database if exists $DB with (force)" -c "create database $DB"
psql "$PG/$DB" -q -v ON_ERROR_STOP=1 -f supabase/tests/support/supabase_stub.sql
for f in supabase/migrations/*.sql; do psql "$PG/$DB" -q -v ON_ERROR_STOP=1 -1 -f "$f" > /dev/null; done
psql "$PG/$DB" -q -v ON_ERROR_STOP=1 -f supabase/dev/seed_demo.sql

echo "Demo database ready. Starting http://localhost:$PORT as dev@example.test (owner)…"
cd apps/web
GLEEDAY_LOCAL_DB_URL="$PG/$DB" \
GLEEDAY_LOCAL_USER_ID=00000000-0000-4000-8000-000000000001 \
GLEEDAY_LOCAL_USER_EMAIL=dev@example.test \
  exec npx next dev -p "$PORT"
