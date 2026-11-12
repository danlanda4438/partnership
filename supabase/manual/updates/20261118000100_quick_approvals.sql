-- Gleeday update: 20261118000100_quick_approvals.sql
-- Paste into Supabase Dashboard -> SQL Editor -> New query -> Run. All-or-nothing.
-- Refuses to run twice, or before the earlier updates.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
do $guard$ begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '20261118000100') then
    raise exception 'Update 20261118000100 is already applied — nothing to do.';
  end if;
  if (select count(*) from supabase_migrations.schema_migrations where version in ('20261108000100','20261108000200','20261108000300','20261108000400','20261108000500','20261108000600','20261109000100','20261110000100','20261110000200','20261111000100','20261112000100','20261113000100','20261114000100','20261115000100','20261116000100','20261117000100')) < 16 then
    raise exception 'Apply the earlier updates first.';
  end if;
end $guard$;
-- Quick and bulk approvals: the list carries a short preview of each proposal and its
-- fingerprint (payload hash). A decision from the list still applies only to that exact
-- content: if a proposal changed since the list was shown, the decision is refused.
create or replace function public.ui_approvals(p_workspace_id uuid, p_status public.approval_status default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'summary', a.summary, 'action_type', a.action_type, 'status', a.status,
      'created_at', a.created_at, 'expires_at', a.expires_at, 'decided_at', a.decided_at,
      'proposed_by', coalesce(w.name, 'a person'), 'opportunity_id', a.opportunity_id,
      'organization_name', org.name, 'channel_kind', c.kind,
      'payload_hash', a.payload_hash,
      'preview', jsonb_strip_nulls(jsonb_build_object(
        'to', case when jsonb_typeof(a.payload -> 'to') = 'array'
                   then (select string_agg(x, ', ') from jsonb_array_elements_text(a.payload -> 'to') x)
                   else a.payload ->> 'to' end,
        'subject', a.payload ->> 'subject',
        'body', left(regexp_replace(coalesce(a.payload ->> 'body', ''), '\s+', ' ', 'g'), 220),
        'platform', a.payload ->> 'platform',
        'action', a.payload ->> 'action',
        'partner', a.payload ->> 'partner',
        'attachments', case when jsonb_typeof(a.payload -> 'attachments') = 'array'
                            then jsonb_array_length(a.payload -> 'attachments') end)))
    order by a.created_at desc), '[]'::jsonb)
  from public.approvals a
  left join public.worker_identities w on w.id = a.proposed_by_worker_id
  left join public.opportunities o on o.id = a.opportunity_id
  left join public.organizations org on org.id = o.organization_id
  left join public.channels c on c.id = o.channel_id
  where a.workspace_id = p_workspace_id
    and (p_status is null or a.status = p_status)
    and (p_status is not null or a.created_at > now() - interval '30 days' or a.status = 'pending');
$$;

create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20261118000100', 'quick_approvals') on conflict do nothing;
commit;
select 'Update 20261118000100 applied' as result;
