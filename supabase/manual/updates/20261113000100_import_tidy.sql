-- Gleeday update: 20261113000100_import_tidy.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261113000100') then
    raise exception 'Update 20261113000100 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600','20261109000100','20261110000100','20261110000200','20261111000100','20261112000100')) < 11 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Imports run from the owner's browser tab; closing or reloading the tab leaves a batch "running".
-- Starting a new import marks such abandoned attempts (no activity for 15 minutes) as failed.
create or replace function public.import_begin(p_workspace_id uuid, p_user_id uuid, p_meta jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace_id and m.user_id = p_user_id
                 and m.status = 'active' and m.role in ('owner', 'admin')) then
    raise exception 'only owners and admins can import' using errcode = 'insufficient_privilege';
  end if;
  update public.import_batches b
     set status = 'failed', finished_at = now(),
         report = coalesce(b.report, '{}'::jsonb) || jsonb_build_object('note', 'Abandoned (the browser tab was closed or reloaded); superseded by a later import.')
   where b.workspace_id = p_workspace_id and b.status = 'running'
     and coalesce((select max(r.captured_at) from public.source_rows r where r.import_batch_id = b.id), b.started_at) < now() - interval '15 minutes';
  insert into public.import_batches (workspace_id, kind, status, mapping_version, stats)
  values (p_workspace_id, 'upsert', 'running', coalesce(p_meta ->> 'mapping_version', 'v1'), coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.import_begin(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_begin(uuid, uuid, jsonb) to service_role;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261113000100', 'import_tidy') on conflict do nothing;
commit;
select 'Update 20261113000100 applied' as result;
