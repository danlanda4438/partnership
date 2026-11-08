-- STEP 0 — Safety check. Read-only: changes nothing.
-- Run this first. If the "existing_tables" result lists anything, STOP and tell Claude
-- before running 01_setup.sql (the project is not empty).
select
  (select count(*) from pg_tables where schemaname = 'public') as existing_tables,
  (select string_agg(tablename, ', ') from pg_tables where schemaname = 'public') as table_names,
  (select count(*) from auth.users) as existing_users,
  current_setting('server_version') as postgres_version;
