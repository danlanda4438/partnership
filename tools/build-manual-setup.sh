#!/usr/bin/env bash
# Rebuilds supabase/manual/01_setup.sql from the versioned migrations.
set -euo pipefail
cd "$(dirname "$0")/.."
out=supabase/manual/01_setup.sql
{
echo "-- Gleeday Operations Center: one-shot setup for the Supabase SQL Editor."
echo "-- Generated from supabase/migrations by tools/build-manual-setup.sh. Do not edit by hand."
echo "-- Paste the whole file into Dashboard -> SQL Editor -> New query, then click Run."
echo "begin;"
for f in supabase/migrations/*.sql; do echo; echo "-- ===== $(basename "$f") ====="; cat "$f"; done
echo
echo "-- Record the migrations so the Supabase CLI knows they are applied."
echo "create schema if not exists supabase_migrations;"
echo "create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);"
for f in supabase/migrations/*.sql; do b=$(basename "$f" .sql); v=${b%%_*}; n=${b#*_}; echo "insert into supabase_migrations.schema_migrations (version, name) values ('$v', '$n') on conflict do nothing;"; done
echo "commit;"
echo "select 'Gleeday setup complete' as result;"
} > "$out"
echo "wrote $out"
