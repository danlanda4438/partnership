-- Gleeday update: 20261121000100_bot_knowledge.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261121000100') then
    raise exception 'Update 20261121000100 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600','20261109000100','20261110000100','20261110000200','20261111000100','20261112000100','20261113000100','20261114000100','20261115000100','20261116000100','20261117000100','20261118000100','20261119000100','20261120000100')) < 19 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Bot knowledge files: so the bot team does not depend on one person.
--
-- Each bot keeps a knowledge file in the app (what it does, how it works, its standing
-- instructions, voice and templates, ongoing partners, lessons learned). Anyone with access
-- can open it from the Bots page and use it, with the connection steps the app adds, to set up
-- a new agent that does the same job.
--
--   * Bots write it with the MCP tool updateKnowledge; owners and admins can also edit it.
--   * Every version is kept (append-only); the newest is the current file.
--   * Weekly: the daily maintenance run gives each active bot a "knowledge.refresh" task when
--     its file is missing or older than 7 days (one open refresh task per bot at a time).
--   * Secrets never belong in it: text that looks like a password, token or API key is refused.

create table public.bot_knowledge (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  worker_id uuid not null,
  body text not null check (length(body) between 20 and 60000),
  change_note text check (change_note is null or length(change_note) <= 500),
  written_by_worker_id uuid,
  written_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, worker_id) references public.worker_identities (workspace_id, id) on delete cascade,
  foreign key (workspace_id, written_by_worker_id) references public.worker_identities (workspace_id, id),
  check ((written_by_worker_id is null) <> (written_by_user_id is null))
);
create index bot_knowledge_latest on public.bot_knowledge (worker_id, created_at desc);
alter table public.bot_knowledge enable row level security;
revoke all on public.bot_knowledge from anon, authenticated;
grant select on public.bot_knowledge to authenticated;
create policy bot_knowledge_select on public.bot_knowledge for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));
create trigger bot_knowledge_immutable before update or delete on public.bot_knowledge
  for each row execute function private.forbid_mutation();

-- Refuses text that looks like a secret (the file is meant to be copied and shared).
create function private.check_knowledge_text(p_body text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := trim(coalesce(p_body, ''));
begin
  if length(v) < 20 then
    raise exception 'the knowledge file is too short' using errcode = 'invalid_parameter_value';
  end if;
  if length(v) > 60000 then
    raise exception 'the knowledge file is too long (max 60,000 characters); keep it to what a new agent needs' using errcode = 'invalid_parameter_value';
  end if;
  if v ~* '(gwk_[0-9a-f]{16,}|sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|bearer\s+[A-Za-z0-9._~+/=-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*(?=\S*[0-9])\S{12,})' then
    raise exception 'this looks like it contains a password, token or API key. Remove it: knowledge files are shared and must never hold secrets (say where the secret is kept instead)'
      using errcode = 'invalid_parameter_value';
  end if;
  return v;
end;
$$;

-- What a new agent needs to know when it starts the weekly refresh.
create function private.knowledge_refresh_instructions()
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Update your knowledge file with updateKnowledge (read the current one first with getKnowledge). '
    || 'It must let a NEW agent, set up by someone other than the owner, do your job tomorrow. '
    || 'Rewrite the whole file (not just additions), in plain language, with these sections:' || chr(10)
    || '1. Purpose: what you do and for which programs.' || chr(10)
    || '2. Standing instructions: your routine instructions, word for word.' || chr(10)
    || '3. How I work: your routine step by step, how often, what you check first.' || chr(10)
    || '4. Outside tools and accounts: which ones you use (e.g. the Gmail account, Instantly, impact.com, LinkedIn) and what for. Names and where access is managed only, NEVER passwords, tokens or keys.' || chr(10)
    || '5. Voice and templates: how you write to partners, templates and subject lines that work.' || chr(10)
    || '6. Partners right now: important ongoing conversations and who is waiting on whom.' || chr(10)
    || '7. Lessons learned: what works, what to avoid, mistakes not to repeat.' || chr(10)
    || '8. Open issues: anything unfinished the next agent must know.' || chr(10)
    || '9. What changed this week.' || chr(10)
    || 'Use only facts you know; do not invent. Then reportTaskResult with a one-line summary of what changed.';
$$;

-- ---------------------------------------------------------------------------
-- Bots (MCP): read and write their own file
-- ---------------------------------------------------------------------------
create function public.worker_get_knowledge(p_worker_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  k public.bot_knowledge;
begin
  select * into k from public.bot_knowledge where worker_id = v_w.id order by created_at desc limit 1;
  return jsonb_build_object(
    'body', k.body, 'updated_at', k.created_at, 'change_note', k.change_note,
    'what_to_write', private.knowledge_refresh_instructions());
end;
$$;

create function public.worker_update_knowledge(p_worker_id uuid, p_body text, p_change_note text default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  v_id uuid;
begin
  insert into public.bot_knowledge (workspace_id, worker_id, body, change_note, written_by_worker_id)
  values (v_w.workspace_id, v_w.id, private.check_knowledge_text(p_body),
          nullif(left(trim(coalesce(p_change_note, '')), 500), ''), v_w.id)
  returning id into v_id;
  return jsonb_build_object('version_id', v_id, 'saved', true);
end;
$$;

revoke all on function public.worker_get_knowledge(uuid) from public, anon, authenticated;
revoke all on function public.worker_update_knowledge(uuid, text, text) from public, anon, authenticated;
grant execute on function public.worker_get_knowledge(uuid) to service_role;
grant execute on function public.worker_update_knowledge(uuid, text, text) to service_role;
grant execute on function private.check_knowledge_text(text) to service_role;
grant execute on function private.knowledge_refresh_instructions() to service_role;

-- ---------------------------------------------------------------------------
-- People: read (any member) and edit (owner/admin)
-- ---------------------------------------------------------------------------
create function public.ui_bot_knowledge(p_worker_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'bot', jsonb_build_object('id', w.id, 'name', w.name, 'role', w.role, 'description', w.description, 'status', w.status,
      'capabilities', w.capabilities, 'max_concurrent_tasks', w.max_concurrent_tasks, 'daily_action_budget', w.daily_action_budget,
      'routine_secret_ref', w.routine_secret_ref,
      'channels', coalesce((select jsonb_agg(c.kind order by c.kind) from public.worker_channel_scopes s
                            join public.channels c on c.id = s.channel_id where s.worker_id = w.id), '[]'::jsonb)),
    'current', (select jsonb_build_object('id', k.id, 'body', k.body, 'change_note', k.change_note, 'updated_at', k.created_at,
                  'written_by', coalesce(kw.name, 'a person in the app'))
                from public.bot_knowledge k left join public.worker_identities kw on kw.id = k.written_by_worker_id
                where k.worker_id = w.id order by k.created_at desc limit 1),
    'history', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'updated_at', h.created_at, 'change_note', h.change_note,
                  'written_by', coalesce(hw.name, 'a person in the app')) order by h.created_at desc)
                from (select * from public.bot_knowledge k where k.worker_id = w.id order by k.created_at desc limit 12) h
                left join public.worker_identities hw on hw.id = h.written_by_worker_id), '[]'::jsonb),
    'refresh_task', (select jsonb_build_object('id', t.id, 'status', t.status, 'created_at', t.created_at)
                from public.tasks t where t.assigned_worker_id = w.id and t.kind = 'knowledge.refresh'
                order by t.created_at desc limit 1),
    'what_to_write', private.knowledge_refresh_instructions())
  from public.worker_identities w
  where w.id = p_worker_id;
$$;

create function public.save_bot_knowledge(p_worker_id uuid, p_body text, p_change_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ws uuid;
  v_id uuid;
begin
  select workspace_id into v_ws from public.worker_identities where id = p_worker_id;
  if v_ws is null or not private.has_workspace_role(v_ws, array['owner','admin']::public.member_role[]) then
    raise exception 'only owners and admins can edit a bot''s knowledge file' using errcode = 'insufficient_privilege';
  end if;
  insert into public.bot_knowledge (workspace_id, worker_id, body, change_note, written_by_user_id)
  values (v_ws, p_worker_id, private.check_knowledge_text(p_body), nullif(left(trim(coalesce(p_change_note, '')), 500), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.ui_bot_knowledge(uuid) from public, anon;
grant execute on function public.ui_bot_knowledge(uuid) to authenticated;
grant execute on function private.knowledge_refresh_instructions() to authenticated;
revoke all on function public.save_bot_knowledge(uuid, text, text) from public, anon;
grant execute on function public.save_bot_knowledge(uuid, text, text) to authenticated;

-- The bot list shows when each file was last updated.
create or replace function public.ui_bots(p_workspace_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id, 'name', w.name, 'role', w.role, 'description', w.description, 'status', w.status,
      'capabilities', w.capabilities, 'max_concurrent_tasks', w.max_concurrent_tasks,
      'daily_action_budget', w.daily_action_budget, 'routine_secret_ref', w.routine_secret_ref,
      'channels', coalesce((select jsonb_agg(c.kind order by c.kind) from public.worker_channel_scopes s
                            join public.channels c on c.id = s.channel_id where s.worker_id = w.id), '[]'::jsonb),
      'active_attempts', (select count(*) from public.task_attempts a where a.worker_id = w.id and a.status = 'active'),
      'succeeded_7d', (select count(*) from public.task_attempts a where a.worker_id = w.id and a.status = 'succeeded'
                       and a.finished_at > now() - interval '7 days'),
      'failed_7d', (select count(*) from public.task_attempts a where a.worker_id = w.id and a.status in ('failed', 'expired')
                    and a.finished_at > now() - interval '7 days'),
      'blocked_7d', (select count(*) from public.task_attempts a where a.worker_id = w.id and a.status = 'blocked'
                     and a.finished_at > now() - interval '7 days'),
      'last_seen_at', (select max(a.heartbeat_at) from public.task_attempts a where a.worker_id = w.id),
      'knowledge_updated_at', (select max(k.created_at) from public.bot_knowledge k where k.worker_id = w.id))
    order by w.name), '[]'::jsonb)
  from public.worker_identities w
  where w.workspace_id = p_workspace_id;
$$;

-- ---------------------------------------------------------------------------
-- Weekly refresh, from the daily maintenance run
-- ---------------------------------------------------------------------------
create function private.schedule_knowledge_refresh()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_n integer;
begin
  insert into public.tasks (workspace_id, kind, title, details, assigned_worker_id, priority, max_attempts, due_at)
  select w.workspace_id, 'knowledge.refresh',
         case when k.last_at is null then 'Write your knowledge file' else 'Weekly: update your knowledge file' end,
         jsonb_build_object('instructions', private.knowledge_refresh_instructions(), 'last_updated_at', k.last_at),
         w.id, 150, 3, now() + interval '2 days'
  from public.worker_identities w
  left join lateral (select max(x.created_at) as last_at from public.bot_knowledge x where x.worker_id = w.id) k on true
  where w.status = 'active'
    and (k.last_at is null or k.last_at < now() - interval '7 days')
    and not exists (select 1 from public.tasks t
                    where t.assigned_worker_id = w.id and t.kind = 'knowledge.refresh'
                      and t.status in ('queued', 'claimed', 'awaiting_approval', 'blocked'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function private.schedule_knowledge_refresh() from public, anon, authenticated;
grant execute on function private.schedule_knowledge_refresh() to service_role;

create or replace function public.run_maintenance()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_leases integer;
  v_approvals integer;
  v_stuck integer;
  v_knowledge integer;
begin
  -- One maintenance run at a time (keeps the weekly refresh to one open task per bot).
  perform pg_advisory_xact_lock(hashtext('gleeday.run_maintenance'));
  v_leases := private.expire_leases();
  with expired as (
    update public.approvals set status = 'expired' where status = 'pending' and expires_at <= now() returning id, workspace_id, payload_hash
  ), logged as (
    insert into public.approval_events (workspace_id, approval_id, event_type, from_status, to_status, payload_hash, actor_kind)
    select workspace_id, id, 'expired', 'pending', 'expired', payload_hash, 'system' from expired returning 1
  )
  select count(*) into v_approvals from logged;
  update public.webhook_deliveries set status = 'failed', last_error = 'dispatcher timed out'
   where status = 'sending' and next_attempt_at <= now();
  get diagnostics v_stuck = row_count;
  v_knowledge := private.schedule_knowledge_refresh();
  return jsonb_build_object('expired_leases', v_leases, 'expired_approvals', v_approvals, 'requeued_deliveries', v_stuck,
                            'knowledge_refresh_tasks', v_knowledge);
end;
$$;

-- An owner or admin can ask a bot to update its file now (instead of waiting for the week).
create function public.request_knowledge_refresh(p_worker_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w public.worker_identities;
  v_id uuid;
begin
  select * into v_w from public.worker_identities where id = p_worker_id;
  if v_w.id is null or not private.has_workspace_role(v_w.workspace_id, array['owner','admin']::public.member_role[]) then
    raise exception 'only owners and admins can ask a bot to update its knowledge file' using errcode = 'insufficient_privilege';
  end if;
  if v_w.status <> 'active' then
    raise exception 'this bot is not active' using errcode = 'invalid_parameter_value';
  end if;
  select id into v_id from public.tasks
   where assigned_worker_id = v_w.id and kind = 'knowledge.refresh' and status in ('queued', 'claimed', 'awaiting_approval', 'blocked')
   order by created_at desc limit 1;
  if v_id is not null then
    return v_id;  -- one is already open
  end if;
  insert into public.tasks (workspace_id, kind, title, details, assigned_worker_id, priority, max_attempts, due_at, created_by_user_id)
  values (v_w.workspace_id, 'knowledge.refresh', 'Update your knowledge file (asked by the owner)',
          jsonb_build_object('instructions', private.knowledge_refresh_instructions()), v_w.id, 60, 3, now() + interval '1 day', auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.request_knowledge_refresh(uuid) from public, anon;
grant execute on function public.request_knowledge_refresh(uuid) to authenticated;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261121000100', 'bot_knowledge') on conflict do nothing;
commit;
select 'Update 20261121000100 applied' as result;
