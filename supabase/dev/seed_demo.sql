-- LOCAL DEVELOPMENT ONLY — fictional demo data for clicking through the screens.
-- Never run this against the real Supabase project. All names, emails and companies are invented
-- (example.test domains). Usage: see docs/RUNBOOK.md → "Local development with demo data".

do $$
declare
  v_user uuid := '00000000-0000-4000-8000-000000000001';
  v_ws uuid;
  ch record;
  v_soled uuid; v_aff_bot uuid; v_media_bot uuid; v_list_bot uuid;
  v_org uuid; v_contact uuid; v_opp uuid; v_ev uuid; v_msg uuid; v_task uuid;
  v_file uuid; v_batch uuid; v_row uuid;
  i int;
begin
  if exists (select 1 from public.workspaces where slug = 'gleeday-demo') then
    raise notice 'demo workspace already exists, skipping';
    return;
  end if;

  insert into auth.users (id, email) values (v_user, 'dev@example.test') on conflict do nothing;
  insert into public.workspaces (name, slug) values ('Gleeday (demo data)', 'gleeday-demo') returning id into v_ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (v_ws, v_user, 'owner');

  create temp table ch_ids on commit drop as select kind, id from public.channels where workspace_id = v_ws;

  insert into public.worker_identities (workspace_id, name, role, description, capabilities, max_concurrent_tasks, daily_action_budget)
  values (v_ws, 'Soled', 'coordinator', 'Assigns work and watches for exceptions', '{tasks.assign}', 3, null) returning id into v_soled;
  insert into public.worker_identities (workspace_id, name, role, description, capabilities, max_concurrent_tasks, daily_action_budget)
  values (v_ws, 'Affiliate Bot', 'affiliates', 'Affiliate outreach and follow-ups', '{gmail.send,research}', 2, 40) returning id into v_aff_bot;
  insert into public.worker_identities (workspace_id, name, role, description, capabilities, max_concurrent_tasks, daily_action_budget)
  values (v_ws, 'Media Bot', 'media_pr', 'Media & PR outreach', '{gmail.send}', 1, 25) returning id into v_media_bot;
  insert into public.worker_identities (workspace_id, name, role, description, capabilities, status, max_concurrent_tasks)
  values (v_ws, 'Listings Bot', 'listings', 'Directory submissions', '{listing.submit}', 'paused', 1) returning id into v_list_bot;
  insert into public.worker_channel_scopes (workspace_id, worker_id, channel_id)
  select v_ws, w, c.id from (values (v_aff_bot, 'affiliates'), (v_media_bot, 'media_pr'), (v_list_bot, 'listings'),
                                    (v_soled, 'affiliates'), (v_soled, 'co_marketing'), (v_soled, 'media_pr'), (v_soled, 'listings')) x(w, k)
  join ch_ids c on c.kind::text = x.k;

  -- Source provenance
  insert into public.source_files (workspace_id, external_file_id, title, url, channel_id)
  values (v_ws, 'demo-sheet-affiliates', 'Demo Affiliate Prospects (fictional)', 'https://example.test/sheet', (select id from ch_ids where kind = 'affiliates'))
  returning id into v_file;
  insert into public.import_batches (workspace_id, kind, status, finished_at, stats)
  values (v_ws, 'snapshot', 'completed', now() - interval '2 days', '{"rows": 3, "tabs": 1}') returning id into v_batch;

  create temp table demo_opps (name text, kind text, stage text, disposition text, milestone text, contact text, email text,
                               next_action text, due_in interval, owner text) on commit drop;
  insert into demo_opps values
    ('Harbor Lights Events', 'affiliates', 'interested', null, null, 'Maya Cohen', 'maya@harborlights.example.test', 'Send affiliate terms', interval '-3 hours', 'aff'),
    ('Northwind Party Co', 'affiliates', 'agreed', null, 'manually_onboarded', 'Leo Park', 'leo@northwind.example.test', 'Confirm first promotion date', interval '1 day', 'aff'),
    ('Bright Day Planners', 'affiliates', 'replied', null, null, 'Ana Ruiz', 'ana@brightday.example.test', null, null, 'aff'),
    ('Cedar Hall', 'affiliates', 'contacted', 'automatic_only', null, 'Tom Weiss', 'tom@cedarhall.example.test', 'Follow up after out-of-office', interval '2 days', 'aff'),
    ('Quiet Grove Retreats', 'affiliates', 'contacted', 'declined', null, 'Noa Levi', 'noa@quietgrove.example.test', null, null, 'aff'),
    ('Sunset Rooftop', 'affiliates', null, null, null, null, null, null, null, null),
    ('Lumen Venues Group', 'co_marketing', 'discussion_proposal', null, null, 'Dana Shore', 'dana@lumen.example.test', 'Review co-marketing proposal draft', interval '20 hours', 'person'),
    ('Pixel Ticketing', 'co_marketing', 'agreed', null, 'implementation', 'Ivan Petrov', 'ivan@pixeltix.example.test', 'Integration kickoff call', interval '4 days', 'person'),
    ('Tinybox Studios', 'co_marketing', 'contacted', 'needs_verification', null, null, null, 'Verify the right contact', interval '-1 day', null),
    ('The Weekend Wire', 'media_pr', 'discussion_proposal', null, 'proposal', 'Rina Gold', 'rina@weekendwire.example.test', 'Decide on sponsored feature', interval '1 day', 'media'),
    ('City Families Mag', 'media_pr', 'replied', null, null, 'Sam Lee', 'sam@cityfamilies.example.test', null, null, 'media'),
    ('Local Buzz Podcast', 'media_pr', 'live', null, 'placement_live', 'Gil Amit', 'gil@localbuzz.example.test', null, null, 'media'),
    ('EventFinder Directory', 'listings', 'agreed', null, 'pending_review', null, 'support@eventfinder.example.test', 'Check review status', interval '3 days', 'list'),
    ('KidsOut Listings', 'listings', 'live', null, 'publicly_live', null, 'hello@kidsout.example.test', null, null, 'list'),
    ('WhatsOn Weekly', 'listings', 'contacted', 'bounced', null, null, 'info@whatson.example.test', null, null, 'list');

  for ch in select * from demo_opps loop
    insert into public.organizations (workspace_id, name, website) values (v_ws, ch.name, 'https://' || lower(replace(ch.name, ' ', '')) || '.example.test')
    returning id into v_org;
    v_contact := null;
    if ch.email is not null then
      insert into public.contacts (workspace_id, organization_id, full_name, job_title)
      values (v_ws, v_org, ch.contact, case when ch.contact is not null then 'Partnerships' end) returning id into v_contact;
      insert into public.contact_identities (workspace_id, contact_id, kind, value, normalized_value, is_verified, verified_at, verification_source)
      values (v_ws, v_contact, 'email', ch.email, ch.email, true, now() - interval '10 days', 'gmail thread');
    end if;
    insert into public.opportunities (workspace_id, channel_id, organization_id, primary_contact_id, next_action, next_action_due_at,
                                      owner_user_id, owner_worker_id, last_verified_at)
    values (v_ws, (select id from ch_ids where kind::text = ch.kind), v_org, v_contact, ch.next_action, now() + ch.due_in,
            case when ch.owner = 'person' then v_user end,
            case ch.owner when 'aff' then v_aff_bot when 'media' then v_media_bot when 'list' then v_list_bot end,
            case when ch.stage is not null and ch.disposition is null then now() - interval '5 days' end)
    returning id into v_opp;

    if ch.stage is not null then
      -- First contact (an outbound email) as evidence
      insert into public.messages (workspace_id, opportunity_id, contact_id, provider, provider_message_id, provider_thread_id,
                                   direction, status, from_address, to_addresses, subject, body_text, occurred_at, occurred_at_precision)
      values (v_ws, v_opp, v_contact, 'gmail', 'demo-' || gen_random_uuid(), 'thread-' || v_opp, 'outbound',
              case when ch.disposition = 'bounced' then 'bounced' else 'sent' end::public.message_status,
              'dan@gleeday.example.test', array[coalesce(ch.email, 'unknown@example.test')],
              'Partnering with Gleeday', E'Hi,\n\nWe run Gleeday, a platform for planning kids'' events. Would you be open to a partnership?\n\nThanks,\nDan',
              now() - interval '12 days', 'exact')
      returning id into v_msg;
      insert into public.activity_events (workspace_id, opportunity_id, organization_id, contact_id, message_id, event_type, source,
                                          external_event_id, occurred_at, occurred_at_precision, actor_kind, actor_worker_id, summary)
      values (v_ws, v_opp, v_org, v_contact, v_msg, 'message.sent', 'gmail', 'demo:' || v_msg, now() - interval '12 days', 'exact',
              'worker', coalesce(case ch.owner when 'aff' then v_aff_bot when 'media' then v_media_bot when 'list' then v_list_bot end, v_soled),
              'Intro email sent')
      returning id into v_ev;
      update public.opportunities set stage = 'contacted', stage_evidence_event_id = v_ev where id = v_opp;

      if ch.stage in ('replied', 'interested', 'discussion_proposal', 'agreed', 'live') or ch.disposition = 'automatic_only' then
        insert into public.messages (workspace_id, opportunity_id, contact_id, provider, provider_message_id, provider_thread_id,
                                     direction, status, is_automatic, from_address, to_addresses, subject, body_text, occurred_at, occurred_at_precision)
        values (v_ws, v_opp, v_contact, 'gmail', 'demo-' || gen_random_uuid(), 'thread-' || v_opp, 'inbound', 'received',
                coalesce(ch.disposition = 'automatic_only', false), ch.email, array['dan@gleeday.example.test'], 'Re: Partnering with Gleeday',
                case when ch.disposition = 'automatic_only' then 'I am out of the office until next week.'
                     else E'Hi Dan, thanks for reaching out — this sounds interesting. What would it look like?' end,
                now() - interval '9 days', 'exact')
        returning id into v_msg;
        insert into public.activity_events (workspace_id, opportunity_id, organization_id, contact_id, message_id, event_type, source,
                                            external_event_id, occurred_at, occurred_at_precision, actor_kind, summary)
        values (v_ws, v_opp, v_org, v_contact, v_msg, 'message.received', 'gmail', 'demo:' || v_msg, now() - interval '9 days', 'exact',
                'provider', case when ch.disposition = 'automatic_only' then 'Out-of-office auto-reply' else 'Reply received' end)
        returning id into v_ev;
        if ch.disposition is distinct from 'automatic_only' then
          insert into public.reply_assessments (workspace_id, message_id, source, platform_label) values (v_ws, v_msg, 'platform', 'Interested');
          update public.opportunities set stage = ch.stage::public.opportunity_stage, stage_evidence_event_id = v_ev where id = v_opp;
        end if;
      end if;
      if ch.disposition is not null or ch.milestone is not null then
        update public.opportunities set disposition = ch.disposition::public.opportunity_disposition, milestone_key = ch.milestone where id = v_opp;
      end if;
    end if;

    if ch.name = 'Harbor Lights Events' then
      insert into public.source_rows (workspace_id, import_batch_id, source_file_id, tab_name, row_number, raw_values, checksum)
      values (v_ws, v_batch, v_file, 'Affiliate Prospects', 14, jsonb_build_object('Company', ch.name, 'Status', 'Sent', 'Notes', 'Met at expo (no date)'), 'demo')
      returning id into v_row;
      insert into public.activity_events (workspace_id, opportunity_id, organization_id, event_type, source, actor_kind, source_row_id, summary)
      values (v_ws, v_opp, v_org, 'import.historical_send', 'import:demo-sheet', 'import', v_row, 'Spreadsheet says "Sent" — undated historical outreach');
      insert into public.tasks (workspace_id, channel_id, opportunity_id, kind, title, assigned_worker_id, status, priority)
      values (v_ws, (select id from ch_ids where kind = 'affiliates'), v_opp, 'outreach.send_terms', 'Draft affiliate terms email', v_aff_bot, 'awaiting_approval', 10)
      returning id into v_task;
      insert into public.approvals (workspace_id, opportunity_id, task_id, action_type, summary, payload, proposed_by_worker_id, expires_at)
      values (v_ws, v_opp, v_task, 'send_message', 'Send affiliate terms to Harbor Lights Events',
              jsonb_build_object('to', jsonb_build_array(ch.email), 'from', 'dan@gleeday.example.test',
                'subject', 'Gleeday affiliate partnership — terms',
                'body', E'Hi Maya,\n\nGreat to hear you''re interested. Here is how our affiliate partnership works:\n\n• 15% commission on bookings you refer\n• Monthly payouts\n• A dedicated landing page for your audience\n\nShall I set it up?\n\nBest,\nDan',
                'attachments', jsonb_build_array(jsonb_build_object('file_name', 'Gleeday-affiliate-overview.pdf'))),
              v_aff_bot, now() + interval '2 days');
    elsif ch.name = 'The Weekend Wire' then
      insert into public.offers (workspace_id, opportunity_id, kind, terms, amount, currency, is_paid, status)
      values (v_ws, v_opp, 'paid_placement', 'Sponsored weekend feature + newsletter mention', 1200, 'USD', true, 'proposed');
      insert into public.approvals (workspace_id, opportunity_id, action_type, summary, payload, proposed_by_worker_id, expires_at)
      values (v_ws, v_opp, 'spend', 'Approve $1,200 sponsored feature in The Weekend Wire',
              jsonb_build_object('vendor', ch.name, 'amount', 1200, 'currency', 'USD', 'what', 'Sponsored weekend feature + newsletter mention',
                                 'io_status', 'Unsigned insertion order received'),
              v_media_bot, now() + interval '5 days');
    elsif ch.name = 'Bright Day Planners' then
      insert into public.tasks (workspace_id, channel_id, opportunity_id, kind, title, assigned_worker_id, status, blocked_reason)
      values (v_ws, (select id from ch_ids where kind = 'affiliates'), v_opp, 'outreach.follow_up', 'Follow up on reply', v_aff_bot, 'blocked',
              'Reply asks for a phone call — needs a person');
    elsif ch.name = 'City Families Mag' then
      v_task := null;
      insert into public.approvals (workspace_id, opportunity_id, action_type, summary, payload, proposed_by_worker_id, expires_at)
      values (v_ws, v_opp, 'send_message', 'Reply to City Families Mag', jsonb_build_object('to', jsonb_build_array(ch.email),
              'subject', 'Re: Partnering with Gleeday', 'body', 'Thanks Sam — attaching our press kit.'), v_media_bot, now() + interval '1 day')
      returning id into v_task;
      update public.approvals set status = 'approved', decided_by_user_id = v_user, decided_at = now() - interval '3 hours' where id = v_task;
      perform private.begin_approval_execution(v_task, (select payload_hash from public.approvals where id = v_task), 'demo');
      perform private.finish_approval_execution(v_task, 'uncertain', '{"error": "Connection timed out after sending"}');
    end if;
  end loop;

  -- Queue and history
  insert into public.tasks (workspace_id, channel_id, kind, title, assigned_worker_id, status, priority)
  values (v_ws, (select id from ch_ids where kind = 'listings'), 'listing.submit', 'Submit Gleeday to 3 new directories', v_list_bot, 'queued', 50),
         (v_ws, (select id from ch_ids where kind = 'media_pr'), 'research.media', 'Find 10 parenting newsletters', null, 'queued', 100),
         (v_ws, (select id from ch_ids where kind = 'affiliates'), 'outreach.follow_up', 'Follow up with 4 quiet affiliates', v_aff_bot, 'succeeded', 100),
         (v_ws, (select id from ch_ids where kind = 'listings'), 'listing.check', 'Check EventFinder review status', v_list_bot, 'dead_lettered', 100);

  insert into public.campaigns (workspace_id, channel_id, provider, external_campaign_id, name, status, status_checked_at, health_note)
  values (v_ws, (select id from ch_ids where kind = 'affiliates'), 'instantly', 'demo-1', 'Affiliates — venues wave 2', 'error', now() - interval '1 hour', 'Sending account disconnected'),
         (v_ws, (select id from ch_ids where kind = 'media_pr'), 'instantly', 'demo-2', 'Media — parenting press', 'active', now() - interval '1 hour', null);

  insert into public.integration_connections (workspace_id, provider, display_name, status, blocked_reason)
  values (v_ws, 'google_sheets', 'Google Sheets', 'blocked', 'Waiting for read access to the source sheets');

  -- Ambiguous identity: a shared info@ inbox claimed by two people (not merged)
  insert into public.organizations (workspace_id, name) values (v_ws, 'Twin Oaks Venues') returning id into v_org;
  for i in 1..2 loop
    insert into public.contacts (workspace_id, organization_id, full_name) values (v_ws, v_org, case i when 1 then 'Ruth B.' else 'Omer K.' end)
    returning id into v_contact;
    insert into public.contact_identities (workspace_id, contact_id, kind, value, normalized_value)
    values (v_ws, v_contact, 'email', 'info@twinoaks.example.test', 'info@twinoaks.example.test');
  end loop;
end $$;
