-- Gleeday update: 20261117000100_wakeup_throttle.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261117000100') then
    raise exception 'Update 20261117000100 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600','20261109000100','20261110000100','20261110000200','20261111000100','20261112000100','20261113000100','20261114000100','20261115000100','20261116000100')) < 15 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- One wake-up per bot at a time (at most one per 15 minutes). A bot's run lists ALL its waiting work, so sending one
-- webhook per task piled up runs (Grok then rate-limited the routine). Now:
--   * at most one wake-up per bot every 15 minutes;
--   * when several are due for the same bot, one is sent and the others are marked
--     "covered" (nothing is lost: the run picks up every queued task);
--   * a wake-up is not sent while that bot already has a task in progress (it will see new
--     work when it lists tasks again); it is retried after the cool-down.
--   * Soled is no longer woken each time a task gets stuck: stuck tasks are already in the
--     owner's Exceptions, and Soled reviews them in its daily run (getOverview).

drop trigger if exists tasks_notify_stopped on public.tasks;
update public.webhook_deliveries set status = 'skipped', last_error = 'Stuck tasks are reviewed in Soled''s daily run'
 where event_type in ('task.blocked', 'task.dead_lettered') and status in ('pending', 'failed');

create or replace function public.dispatch_claim(p_limit integer default 20)
returns table (id uuid, workspace_id uuid, worker_id uuid, routine_secret_ref text, event_type text, payload jsonb, attempts smallint)
language plpgsql
set search_path = ''
as $$
declare
  c_gap constant interval := interval '15 minutes';
begin
  -- Bots woken recently, or busy right now: postpone their due wake-ups.
  update public.webhook_deliveries d
     set next_attempt_at = greatest(now() + interval '1 minute',
           coalesce((select max(x.sent_at) from public.webhook_deliveries x
                      where x.worker_id = d.worker_id and x.status = 'sent'), now()) + c_gap)
   where d.status in ('pending', 'failed') and d.next_attempt_at <= now()
     and (exists (select 1 from public.webhook_deliveries x
                   where x.worker_id = d.worker_id
                     and ((x.status = 'sent' and x.sent_at > now() - c_gap) or (x.status = 'sending' and x.updated_at > now() - c_gap)))
          or exists (select 1 from public.tasks t join public.task_attempts a on a.id = t.current_attempt_id
                      where t.status = 'claimed' and a.worker_id = d.worker_id and t.lease_expires_at > now()));

  -- Several due for the same bot: keep the oldest, mark the rest as covered by it.
  update public.webhook_deliveries d
     set status = 'skipped', last_error = 'Covered by another wake-up of this bot (one run handles all its waiting work)'
   where d.status in ('pending', 'failed') and d.next_attempt_at <= now()
     and exists (select 1 from public.webhook_deliveries x
                  where x.worker_id = d.worker_id and x.status in ('pending', 'failed') and x.next_attempt_at <= now()
                    and (x.created_at, x.id) < (d.created_at, d.id));

  return query
  update public.webhook_deliveries d
     set status = 'sending', attempts = d.attempts + 1, next_attempt_at = now() + interval '10 minutes'
    from (select x.id from public.webhook_deliveries x
           where x.status in ('pending', 'failed') and x.next_attempt_at <= now()
           order by x.next_attempt_at limit greatest(1, least(p_limit, 100))
           for update skip locked) due
   where d.id = due.id
  returning d.id, d.workspace_id, d.worker_id,
            (select w.routine_secret_ref from public.worker_identities w where w.id = d.worker_id),
            d.event_type, d.payload, d.attempts;
end;
$$;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261117000100', 'wakeup_throttle') on conflict do nothing;
commit;
select 'Update 20261117000100 applied' as result;
