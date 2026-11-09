#!/usr/bin/env bash
# Builds the SQL Editor files in supabase/manual/ from the versioned migrations:
#   01_setup.sql            every migration in one transaction (fresh project)
#   updates/<migration>.sql one file per migration, for projects that already ran earlier ones
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p supabase/manual/updates

record() {
  local b v n
  b=$(basename "$1" .sql); v=${b%%_*}; n=${b#*_}
  echo "create schema if not exists supabase_migrations;"
  echo "create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);"
  echo "insert into supabase_migrations.schema_migrations (version, name) values ('$v', '$n') on conflict do nothing;"
}

out=supabase/manual/01_setup.sql
{
  echo "-- Gleeday Operations Center: one-shot setup for the Supabase SQL Editor (fresh project)."
  echo "-- Generated from supabase/migrations by tools/build-manual-setup.sh. Do not edit by hand."
  echo "begin;"
  for f in supabase/migrations/*.sql; do echo; echo "-- ===== $(basename "$f") ====="; cat "$f"; echo; record "$f"; done
  echo "commit;"
  echo "select 'Gleeday setup complete' as result;"
} > "$out"

prev=()
for f in supabase/migrations/*.sql; do
  b=$(basename "$f")
  v=${b%%_*}
  earlier=$(printf "'%s'," "${prev[@]:-}" | sed "s/,$//; s/^''$//")
  {
    echo "-- Gleeday update: $b"
    echo "-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing."
    echo "-- Refuses to run twice, or before the earlier updates."
    echo "begin;"
    echo "create schema if not exists supabase_migrations;"
    echo "create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);"
    echo "do \$guard\$ begin"
    echo "  if exists (select 1 from supabase_migrations.schema_migrations where version = '$v') then"
    echo "    raise exception 'Update $v is already applied — nothing to do.';"
    echo "  end if;"
    if [ -n "$earlier" ]; then
      echo "  if (select count(*) from supabase_migrations.schema_migrations where version in ($earlier)) < ${#prev[@]} then"
      echo "    raise exception 'Apply the earlier updates first.';"
      echo "  end if;"
    fi
    echo "end \$guard\$;"
    cat "$f"; echo
    record "$f"
    echo "commit;"
    echo "select 'Update ${b%%_*} applied' as result;"
  } > "supabase/manual/updates/$b"
  prev+=("$v")
done
echo "wrote $out and supabase/manual/updates/"
