-- STEP 5: Let Soled, Gleeday affiliates and Gleeday Co-Marketing carry out APPROVED impact.com actions.
-- Run after update 20261115000100_owner_tasks_and_impact.sql. Safe to run more than once.
-- It only adds the "impact.manage" permission; nothing else about the bots changes.
-- Every partner-facing impact.com action still needs your approval in the app first.
begin;

do $$
begin
  if not exists (select 1 from public.worker_event_types where event_type = 'impact.partner_joined') then
    raise exception 'Apply update 20261115000100_owner_tasks_and_impact.sql first.';
  end if;
end $$;

update public.worker_identities w
   set capabilities = array_append(w.capabilities, 'impact.manage')
 where w.workspace_id = (select id from public.workspaces where slug = 'gleeday')
   and w.name in ('Soled', 'Gleeday affiliates', 'Gleeday Co-Marketing')
   and not ('impact.manage' = any (w.capabilities));

select w.name, w.capabilities,
       case when 'impact.manage' = any (w.capabilities) then 'OK' else '—' end as impact
  from public.worker_identities w
 where w.workspace_id = (select id from public.workspaces where slug = 'gleeday')
 order by w.name;

commit;
