-- Gleeday update: 20261116000100_conversations.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261116000100') then
    raise exception 'Update 20261116000100 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600','20261109000100','20261110000100','20261110000200','20261111000100','20261112000100','20261113000100','20261114000100','20261115000100')) < 14 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Conversations with the bots. The owner writes a message and tags a bot (default: the
-- coordinator, Soled). The app turns each message into a task for that bot and wakes it;
-- the bot answers in the same thread (and may do the work, propose approvals, or — Soled —
-- hand work to another bot, which can then answer in the thread too).

create table public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_id uuid not null,                       -- = id of the thread's first message
  author_user_id uuid references auth.users(id),
  author_worker_id uuid,
  to_worker_id uuid,                             -- the bot a person's message is addressed to
  body text not null check (length(body) between 1 and 8000),
  task_id uuid,                                  -- the task created for a person's message
  opportunity_id uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, author_worker_id) references public.worker_identities (workspace_id, id),
  foreign key (workspace_id, to_worker_id) references public.worker_identities (workspace_id, id),
  foreign key (workspace_id, task_id) references public.tasks (workspace_id, id),
  foreign key (workspace_id, opportunity_id) references public.opportunities (workspace_id, id),
  check ((author_user_id is null) <> (author_worker_id is null))
);
create index conversation_messages_thread on public.conversation_messages (workspace_id, thread_id, created_at);
alter table public.conversation_messages enable row level security;
revoke all on public.conversation_messages from anon, authenticated;
grant select on public.conversation_messages to authenticated;
create policy conversation_messages_select on public.conversation_messages for select to authenticated
  using (workspace_id in (select private.member_workspace_ids()));
create trigger conversation_messages_immutable before update or delete on public.conversation_messages
  for each row execute function private.forbid_mutation();

-- A person sends a message to a bot (new thread, or a reply in an existing thread).
create function public.send_bot_message(p_workspace_id uuid, p_to_worker_id uuid, p_body text,
                                        p_thread_id uuid default null, p_opportunity_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bot public.worker_identities;
  v_msg uuid := gen_random_uuid();
  v_thread uuid := coalesce(p_thread_id, v_msg);
  v_task uuid;
  v_opp uuid := p_opportunity_id;
  v_channel uuid;
begin
  if not private.has_workspace_role(p_workspace_id, array['owner','admin','member']::public.member_role[]) then
    raise exception 'not authorized to message bots in this workspace' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(length(trim(p_body)), 0) = 0 then
    raise exception 'write a message first' using errcode = 'invalid_parameter_value';
  end if;
  if p_to_worker_id is null then
    select * into v_bot from public.worker_identities
     where workspace_id = p_workspace_id and status = 'active' and role = 'coordinator' order by created_at limit 1;
  else
    select * into v_bot from public.worker_identities where id = p_to_worker_id and workspace_id = p_workspace_id;
  end if;
  if v_bot.id is null or v_bot.status <> 'active' then
    raise exception 'that bot is not active' using errcode = 'invalid_parameter_value';
  end if;
  if p_thread_id is not null then
    if not exists (select 1 from public.conversation_messages where workspace_id = p_workspace_id and id = p_thread_id) then
      raise exception 'conversation not found' using errcode = 'no_data_found';
    end if;
    select opportunity_id into v_opp from public.conversation_messages where id = p_thread_id;
  end if;
  if v_opp is not null then
    select channel_id into v_channel from public.opportunities where id = v_opp and workspace_id = p_workspace_id;
    if v_channel is null then
      raise exception 'partner not found' using errcode = 'no_data_found';
    end if;
    if not exists (select 1 from public.worker_channel_scopes s where s.worker_id = v_bot.id and s.channel_id = v_channel) then
      raise exception '% does not work on this partner''s program', v_bot.name using errcode = 'invalid_parameter_value';
    end if;
  end if;

  insert into public.tasks (workspace_id, channel_id, opportunity_id, kind, title, details, assigned_worker_id, priority, created_by_user_id)
  values (p_workspace_id, v_channel, v_opp, 'owner.message', left(regexp_replace(trim(p_body), '\s+', ' ', 'g'), 120),
          jsonb_build_object('thread_id', v_thread, 'message_id', v_msg, 'message', trim(p_body),
                             'how_to_answer', 'Call getConversation for the thread, answer with replyToOwner, do any work asked (approval rules apply), then reportTaskResult.'),
          v_bot.id, 20, auth.uid())
  returning id into v_task;

  insert into public.conversation_messages (id, workspace_id, thread_id, author_user_id, to_worker_id, body, task_id, opportunity_id)
  values (v_msg, p_workspace_id, v_thread, auth.uid(), v_bot.id, trim(p_body), v_task, v_opp);
  return v_thread;
end;
$$;
revoke all on function public.send_bot_message(uuid, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.send_bot_message(uuid, uuid, text, uuid, uuid) to authenticated;

-- A bot may take part in a thread when it was messaged there, or was given a task for it.
create function private.require_thread_access(p_worker public.worker_identities, p_thread_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not exists (select 1 from public.conversation_messages m
                 where m.workspace_id = p_worker.workspace_id and m.thread_id = p_thread_id and m.to_worker_id = p_worker.id)
     and not exists (select 1 from public.tasks t
                 where t.workspace_id = p_worker.workspace_id and t.details ->> 'thread_id' = p_thread_id::text
                   and (t.assigned_worker_id = p_worker.id
                        or exists (select 1 from public.task_attempts a where a.task_id = t.id and a.worker_id = p_worker.id))) then
    raise exception 'conversation not found for this bot' using errcode = 'no_data_found';
  end if;
end;
$$;

create function public.worker_get_conversation(p_worker_id uuid, p_thread_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
begin
  perform private.require_thread_access(v_w, p_thread_id);
  return jsonb_build_object('thread_id', p_thread_id, 'messages', coalesce((
    select jsonb_agg(jsonb_build_object(
             'at', m.created_at,
             'from', coalesce(w.name, 'owner'),
             'to', tw.name,
             'text', m.body,
             'opportunity_id', m.opportunity_id) order by m.created_at)
    from public.conversation_messages m
    left join public.worker_identities w on w.id = m.author_worker_id
    left join public.worker_identities tw on tw.id = m.to_worker_id
    where m.workspace_id = v_w.workspace_id and m.thread_id = p_thread_id), '[]'::jsonb));
end;
$$;

create function public.worker_reply(p_worker_id uuid, p_thread_id uuid, p_text text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_w public.worker_identities := private.require_active_worker(p_worker_id);
  v_id uuid;
begin
  perform private.require_thread_access(v_w, p_thread_id);
  if coalesce(length(trim(p_text)), 0) = 0 then
    raise exception 'text is required' using errcode = 'invalid_parameter_value';
  end if;
  insert into public.conversation_messages (workspace_id, thread_id, author_worker_id, body)
  values (v_w.workspace_id, p_thread_id, v_w.id, left(trim(p_text), 8000))
  returning id into v_id;
  return jsonb_build_object('message_id', v_id, 'thread_id', p_thread_id);
end;
$$;
revoke all on function public.worker_get_conversation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.worker_reply(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.worker_get_conversation(uuid, uuid) to service_role;
grant execute on function public.worker_reply(uuid, uuid, text) to service_role;
grant execute on function private.require_thread_access(public.worker_identities, uuid) to service_role;

-- Screens -----------------------------------------------------------------------------
create function public.ui_conversations(p_workspace_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x ->> 'last_at' desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'thread_id', f.thread_id,
      'first_text', f.body,
      'to', tw.name,
      'partner', org.name,
      'last_at', l.created_at,
      'last_text', l.body,
      'last_from', coalesce(lw.name, 'You'),
      'messages', (select count(*) from public.conversation_messages c where c.workspace_id = f.workspace_id and c.thread_id = f.thread_id),
      'waiting_for_bot', exists (select 1 from public.conversation_messages p join public.tasks t on t.id = p.task_id
                                 where p.thread_id = f.thread_id and p.workspace_id = f.workspace_id
                                   and t.status in ('queued', 'claimed'))
    ) as x
    from public.conversation_messages f
    left join public.worker_identities tw on tw.id = f.to_worker_id
    left join public.opportunities o on o.id = f.opportunity_id
    left join public.organizations org on org.id = o.organization_id
    cross join lateral (select * from public.conversation_messages l
                         where l.workspace_id = f.workspace_id and l.thread_id = f.thread_id
                         order by l.created_at desc limit 1) l
    left join public.worker_identities lw on lw.id = l.author_worker_id
    where f.workspace_id = p_workspace_id and f.id = f.thread_id
  ) s;
$$;

create function public.ui_conversation(p_workspace_id uuid, p_thread_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'thread_id', p_thread_id,
    'partner', (select jsonb_build_object('id', o.id, 'name', org.name)
                  from public.conversation_messages f join public.opportunities o on o.id = f.opportunity_id
                  join public.organizations org on org.id = o.organization_id
                 where f.workspace_id = p_workspace_id and f.id = p_thread_id),
    'last_bot', (select m.to_worker_id from public.conversation_messages m
                  where m.workspace_id = p_workspace_id and m.thread_id = p_thread_id and m.to_worker_id is not null
                  order by m.created_at desc limit 1),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'at', m.created_at, 'text', m.body,
               'from_bot', w.name, 'to_bot', tw.name,
               'task_status', t.status, 'task_reason', t.blocked_reason) order by m.created_at)
      from public.conversation_messages m
      left join public.worker_identities w on w.id = m.author_worker_id
      left join public.worker_identities tw on tw.id = m.to_worker_id
      left join public.tasks t on t.id = m.task_id
      where m.workspace_id = p_workspace_id and m.thread_id = p_thread_id), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'bot', w.name,
                                          'blocked_reason', t.blocked_reason) order by t.created_at)
      from public.tasks t left join public.worker_identities w on w.id = t.assigned_worker_id
      where t.workspace_id = p_workspace_id and t.details ->> 'thread_id' = p_thread_id::text and t.kind <> 'owner.message'), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'summary', a.summary, 'status', a.status) order by a.created_at)
      from public.approvals a join public.tasks t on t.id = a.task_id
      where a.workspace_id = p_workspace_id and t.details ->> 'thread_id' = p_thread_id::text), '[]'::jsonb)
  );
$$;
revoke all on function public.ui_conversations(uuid) from public, anon;
revoke all on function public.ui_conversation(uuid, uuid) from public, anon;
grant execute on function public.ui_conversations(uuid) to authenticated;
grant execute on function public.ui_conversation(uuid, uuid) to authenticated;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261116000100', 'conversations') on conflict do nothing;
commit;
select 'Update 20261116000100 applied' as result;
