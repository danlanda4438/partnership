-- STEP 2 — Verification. Read-only: changes nothing.
-- Every row should say "OK".
select 'tables created' as check, case when count(*) >= 29 then 'OK' else 'PROBLEM: ' || count(*) end as result
  from pg_tables where schemaname = 'public'
union all
select 'RLS on every table', case when count(*) = 0 then 'OK' else 'PROBLEM: ' || string_agg(relname, ', ') end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
union all
select 'anon has no table access', case when count(*) = 0 then 'OK' else 'PROBLEM: ' || count(*) || ' grants' end
  from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'
union all
select 'attachments bucket private', case when bool_and(not public) then 'OK' else 'PROBLEM' end
  from storage.buckets where id = 'attachments'
union all
select 'migrations recorded', case when count(*) = 6 then 'OK' else 'PROBLEM: ' || count(*) end
  from supabase_migrations.schema_migrations where version like '20261108%';
