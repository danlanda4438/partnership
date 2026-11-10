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
