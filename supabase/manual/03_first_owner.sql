-- STEP 3 — Create the Gleeday workspace and make you its owner. Safe to run more than once.
-- Before running: Dashboard -> Authentication -> Users -> "Add user" -> "Create new user"
-- with your email and "Auto Confirm User" ticked (no password needed; you sign in by email link).
-- If you use a different email, change it on the line marked <<< below.
begin;

insert into public.workspaces (name, slug)
values ('Gleeday', 'gleeday')
on conflict (slug) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
select w.id, u.id, 'owner'
from public.workspaces w
join auth.users u on lower(u.email) = lower('dan@gleeday.com')   -- <<< your login email
where w.slug = 'gleeday'
on conflict (workspace_id, user_id) do update set role = 'owner', status = 'active', revoked_at = null;

commit;

select w.name as workspace, u.email, m.role, m.status,
       (select count(*) from public.channels c where c.workspace_id = w.id) as channels
from public.workspace_members m
join public.workspaces w on w.id = m.workspace_id
join auth.users u on u.id = m.user_id
where w.slug = 'gleeday';
-- Expect one row: Gleeday | dan@gleeday.com | owner | active | 4
-- If you get NO rows, the user doesn't exist yet in Authentication -> Users.
