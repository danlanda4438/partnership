// Shapes returned by the ui_* database functions (supabase/migrations/20261109000100_operations_read_models.sql).

export interface ApprovalListItem {
  id: string;
  summary: string;
  action_type: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  proposed_by: string;
  opportunity_id: string | null;
  organization_name: string | null;
  channel_kind: string | null;
  payload_hash?: string;
  preview?: { to?: string; subject?: string; body?: string; platform?: string; action?: string; partner?: string; attachments?: number };
}

export interface ExceptionItem {
  kind: string;
  id: string;
  title: string;
  detail: string;
  since: string;
  opportunity_id: string | null;
  link: string | null;
}

export interface DueItem {
  id: string;
  organization_name: string;
  channel_kind: string;
  stage: string | null;
  next_action: string | null;
  next_action_due_at: string;
  owner_worker_name: string | null;
  overdue: boolean;
}

export interface ChangeItem {
  id: string;
  event_type: string;
  summary: string | null;
  recorded_at: string;
  opportunity_id: string | null;
  organization_name: string | null;
  channel_kind: string | null;
  actor_kind: string;
  actor_worker: string | null;
}

export interface Daily {
  since: string;
  pending_approvals: ApprovalListItem[];
  exceptions: ExceptionItem[];
  due: DueItem[];
  changes: ChangeItem[];
}

export interface PipelineItem {
  id: string;
  workspace_id: string;
  channel_kind: string;
  channel_name: string;
  organization_id: string;
  organization_name: string;
  primary_contact_id: string | null;
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  stage: string | null;
  disposition: string | null;
  milestone_key: string | null;
  owner_user_id: string | null;
  owner_worker_id: string | null;
  owner_worker_name: string | null;
  next_action: string | null;
  next_action_due_at: string | null;
  last_verified_at: string | null;
  updated_at: string;
  event_count: number;
}

export interface MessageInfo {
  id: string;
  direction: "outbound" | "inbound";
  status: string;
  subject: string | null;
  from: string | null;
  to: string[];
  body_text: string | null;
  provider: string;
  provider_message_id: string | null;
  is_automatic: boolean | null;
  assessments?: {
    source: string;
    classification: string | null;
    platform_label: string | null;
    conditions: string | null;
    is_human_reply: boolean | null;
    assessed_at: string;
  }[];
}

export interface TimelineItem {
  kind: "event" | "message";
  id: string;
  event_type: string;
  source: string;
  summary: string | null;
  occurred_at: string | null;
  precision: string;
  recorded_at: string;
  actor_kind: string | null;
  actor_worker?: string | null;
  message: MessageInfo | null;
  provenance: { file: string; url: string | null; tab: string; row: number } | null;
}

export interface OpportunityDetail {
  opportunity: PipelineItem;
  stage_evidence_event_id: string | null;
  organization: {
    id: string;
    name: string;
    website: string | null;
    location_label: string | null;
    country: string | null;
    notes: string | null;
    parent: { id: string; name: string } | null;
    aliases: { alias: string; justification: string }[];
  };
  contacts: {
    id: string;
    full_name: string | null;
    job_title: string | null;
    is_primary: boolean;
    identities: { kind: string; value: string; is_verified: boolean; verification_source: string | null }[];
  }[];
  timeline: TimelineItem[];
  offers: {
    id: string;
    kind: string;
    terms: string;
    amount: string | null;
    currency: string | null;
    is_paid: boolean;
    status: string;
    io_signed: boolean;
    approval_id: string | null;
    created_at: string;
  }[];
  attachments: { id: string; file_name: string; mime_type: string | null; size_bytes: number | null; storage_path: string; created_at: string }[];
  tasks: { id: string; title: string; kind: string; status: string; due_at: string | null; blocked_reason: string | null; worker: string | null }[];
  approvals: { id: string; summary: string; action_type: string; status: string; created_at: string }[];
  sibling_opportunities: { id: string; channel_kind: string; stage: string | null; disposition: string | null }[];
  milestones: { key: string; label: string }[];
  workers: { id: string; name: string }[];
}

export interface ApprovalDetail {
  id: string;
  summary: string;
  action_type: string;
  status: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
  decided_at: string | null;
  decision_note: string | null;
  executed_at: string | null;
  execution_evidence: Record<string, unknown> | null;
  proposed_by: string;
  opportunity_id: string | null;
  organization_name: string | null;
  channel_kind: string | null;
  task_id: string | null;
  task_title: string | null;
  history: { event_type: string; to_status: string; actor_kind: string; note: string | null; created_at: string }[];
}

export interface TaskItem {
  id: string;
  title: string;
  kind: string;
  status: string;
  priority: number;
  channel_kind: string | null;
  opportunity_id: string | null;
  organization_name: string | null;
  worker: string | null;
  due_at: string | null;
  attempt_count: number;
  max_attempts: number;
  lease_expires_at: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface BotItem {
  id: string;
  name: string;
  role: string;
  description: string | null;
  status: string;
  capabilities: string[];
  max_concurrent_tasks: number;
  daily_action_budget: number | null;
  routine_secret_ref: string | null;
  channels: string[];
  active_attempts: number;
  succeeded_7d: number;
  failed_7d: number;
  blocked_7d: number;
  last_seen_at: string | null;
}

export interface Integrations {
  connections: {
    id: string;
    provider: string;
    display_name: string;
    status: string;
    account_identity: string | null;
    scopes: string[];
    blocked_reason: string | null;
    last_checked_at: string | null;
    last_error: string | null;
    cursors: { stream: string; last_synced_at: string | null; last_success_at: string | null }[];
  }[];
  campaigns: { id: string; name: string; provider: string; status: string; status_checked_at: string | null; health_note: string | null; channel_kind: string | null }[];
  source_files: {
    id: string;
    title: string;
    url: string | null;
    owner_label: string | null;
    channel_kind: string | null;
    is_included: boolean;
    exclusion_reason: string | null;
    rows_captured: number;
    tabs: number;
    last_captured_at: string | null;
  }[];
  import_batches: { id: string; kind: string; status: string; started_at: string; finished_at: string | null; stats: Record<string, unknown> }[];
}

export interface MemberItem {
  member_id: string;
  user_id: string;
  email: string;
  role: string;
  status: string;
  is_you: boolean;
}

export interface NotificationPrefs {
  digest_cadence: string;
  digest_local_time: string;
  digest_weekday: number;
  digest_timezone: string;
  notify_approvals: boolean;
  notify_exceptions: boolean;
  notify_material_changes: boolean;
  is_default?: boolean;
}

export interface MetricsRow {
  scope: string;
  opportunities: number;
  inventory: number;
  by_stage: Record<string, number>;
  by_disposition: Record<string, number>;
  organizations_engaged: number;
  contacts_reached: number;
  message_events: number;
  outbound_attempts: number;
  outbound_accepted: number;
  bounced: number;
  failed: number;
  uncertain: number;
  drafts: number;
  inbound_messages: number;
  human_replies: number;
  automatic_replies: number;
  unassessed_replies: number;
  platform_positive_labels: number;
  paid_only_replies: number;
  undated_messages: number;
  active_opportunities: number;
  verified_last_30_days: number;
  last_evidence_at: string | null;
}
