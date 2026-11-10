-- Gleeday update: 20261114000100_approval_guard.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261114000100') then
    raise exception 'Update 20261114000100 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600','20261109000100','20261110000100','20261110000200','20261111000100','20261112000100','20261113000100')) < 12 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- A bot may not report a task as succeeded while an action of that task is still
-- waiting for the owner, approved but not carried out, or executing. Found in the
-- first live test: a bot proposed an email, skipped requestApproval and reported the
-- task as done, which made it look as if the email had been sent.

create or replace function public.worker_report(p_worker_id uuid, p_task_id uuid, p_lease_token text, p_outcome text, p_result jsonb, p_evidence jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_t public.tasks;
  v_open public.approval_status;
begin
  perform private.require_active_worker(p_worker_id);
  if p_outcome = 'succeeded' then
    select a.status into v_open from public.approvals a
     where a.task_id = p_task_id and a.status in ('pending', 'approved', 'executing')
     order by a.created_at desc limit 1;
    if v_open = 'executing' then
      raise exception 'an approved action of this task is still executing: report its outcome first' using errcode = 'check_violation';
    elsif v_open = 'pending' then
      raise exception 'this task has a proposal waiting for the owner''s approval: call requestApproval and stop; nothing has been approved or sent' using errcode = 'check_violation';
    elsif v_open = 'approved' then
      raise exception 'this task has an approved action that was never carried out: call startApprovedAction first, or reportBlocked' using errcode = 'check_violation';
    end if;
  end if;
  if p_outcome = 'blocked' and coalesce(p_result ->> 'reason', '') = '' then
    raise exception 'a blocked report needs a reason' using errcode = 'invalid_parameter_value';
  end if;
  v_t := private.report_task(p_worker_id, p_task_id, p_lease_token, p_outcome, p_result, p_evidence);
  return jsonb_build_object('task_id', v_t.id, 'status', v_t.status, 'attempt_count', v_t.attempt_count, 'max_attempts', v_t.max_attempts);
end;
$$;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261114000100', 'approval_guard') on conflict do nothing;
commit;
select 'Update 20261114000100 applied' as result;
