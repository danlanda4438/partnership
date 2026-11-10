-- STEP 4: Register your five existing Grok bots in the Gleeday workspace.
-- Run after the updates up to 20261111000100. Safe to run more than once (updates in place).
-- This gives each bot an identity, channels and limits. It does NOT connect them: connecting
-- happens in Grok (see docs/BOT_CONNECTION_GUIDE.md), and you approve each connection.
begin;

do $$
begin
  if not exists (select 1 from public.workspaces where slug = 'gleeday') then
    raise exception 'Workspace "gleeday" not found — run 03_first_owner.sql first.';
  end if;
  if not exists (select 1 from public.worker_event_types where event_type = 'prospect.added') then
    raise exception 'Apply update 20261111000100_coordinator_tools.sql first.';
  end if;
end $$;

with ws as (select id from public.workspaces where slug = 'gleeday'),
bots(name, role, description, capabilities, routine_ref, daily_limit, parallel) as (values
  ('Soled', 'coordinator', 'Manages tasks: assigns work to the team and handles blocked work', array['tasks.assign', 'gmail.send', 'impact.manage'], 'SOLED', 20, 3),
  ('Gleeday affiliates', 'affiliates', 'Affiliate program outreach and follow-ups (Instantly, Gmail, impact.com)', array['gmail.send', 'impact.manage'], 'GLEEDAY_AFFILIATES', 25, 2),
  ('Gleeday Co-Marketing', 'co_marketing', 'Co-marketing program outreach and follow-ups (Instantly, Gmail, impact.com)', array['gmail.send', 'impact.manage'], 'GLEEDAY_CO_MARKETING', 25, 2),
  ('Gleeday Media & PR', 'media_pr', 'Paid media program: outreach, proposals, placements', array['gmail.send'], 'GLEEDAY_MEDIA_PR', 25, 2),
  ('Gleeday Listing', 'listings', 'Listing program: submissions, reviews, live checks', array['gmail.send'], 'GLEEDAY_LISTING', 25, 2)
)
insert into public.worker_identities (workspace_id, name, role, description, capabilities, routine_secret_ref, daily_action_budget, max_concurrent_tasks)
select ws.id, b.name, b.role, b.description, b.capabilities, b.routine_ref, b.daily_limit, b.parallel from ws, bots b
on conflict (workspace_id, name) do update
  set role = excluded.role, description = excluded.description, capabilities = excluded.capabilities,
      routine_secret_ref = excluded.routine_secret_ref;

-- Channels: Soled sees all four; each other bot only its own.
insert into public.worker_channel_scopes (workspace_id, worker_id, channel_id)
select w.workspace_id, w.id, c.id
from public.worker_identities w
join public.workspaces ws on ws.id = w.workspace_id and ws.slug = 'gleeday'
join public.channels c on c.workspace_id = w.workspace_id
where (w.role = 'coordinator')
   or (w.role = c.kind::text)
on conflict do nothing;

commit;

select w.name, w.role, w.capabilities, w.daily_action_budget as daily_limit, w.routine_secret_ref as routine_name,
       (select string_agg(c.kind::text, ', ' order by c.kind) from public.worker_channel_scopes s join public.channels c on c.id = s.channel_id where s.worker_id = w.id) as channels
from public.worker_identities w join public.workspaces ws on ws.id = w.workspace_id and ws.slug = 'gleeday'
order by w.role = 'coordinator' desc, w.name;
-- Expect 5 rows. Soled: all four channels. Every other bot: one channel.
