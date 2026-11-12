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
