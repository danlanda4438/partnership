import Link from "next/link";
import {
  CHANNEL_LABELS,
  STAGE_LABELS,
  formatEvidenceTime,
  relativeTime,
  type ChannelKind,
  type Stage,
  type TimestampPrecision,
} from "@gleeday/domain";

export const DISPOSITION_LABELS: Record<string, string> = {
  declined: "Declined",
  on_hold: "On hold",
  bounced: "Bounced",
  automatic_only: "Automatic reply only",
  blocked: "Blocked",
  needs_verification: "Needs verification",
};

export const STATUS_LABELS: Record<string, string> = {
  // approvals
  pending: "Waiting for you",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
  executing: "Sending…",
  executed: "Done",
  execution_uncertain: "Outcome unknown",
  execution_failed: "Failed",
  // tasks
  queued: "Queued",
  claimed: "In progress",
  awaiting_approval: "Awaiting approval",
  blocked: "Blocked",
  succeeded: "Done",
  failed: "Failed",
  dead_lettered: "Gave up",
  // connections / bots / campaigns
  not_configured: "Not configured",
  configured: "Configured",
  healthy: "Healthy",
  degraded: "Degraded",
  revoked: "Revoked",
  active: "Active",
  paused: "Paused",
  error: "Error",
  draft: "Draft",
  completed: "Completed",
  unknown: "Unknown",
};

const TONE: Record<string, "ok" | "warn" | "bad" | "info" | "muted"> = {
  pending: "warn", approved: "info", executing: "info", executed: "ok", rejected: "muted", expired: "muted",
  cancelled: "muted", execution_uncertain: "bad", execution_failed: "bad",
  queued: "muted", claimed: "info", awaiting_approval: "warn", blocked: "bad", succeeded: "ok", failed: "bad",
  dead_lettered: "bad",
  not_configured: "warn", configured: "info", healthy: "ok", degraded: "warn", revoked: "bad",
  active: "ok", paused: "warn", error: "bad", completed: "muted", draft: "muted", unknown: "muted",
  declined: "muted", on_hold: "warn", bounced: "bad", automatic_only: "muted", needs_verification: "warn",
};

export function Pill({ value, label }: { value: string; label?: string }) {
  return <span className={`pill ${TONE[value] ?? "muted"}`}>{label ?? STATUS_LABELS[value] ?? value.replaceAll("_", " ")}</span>;
}

export function StageBadge({ stage }: { stage: string | null }) {
  if (!stage) return <span className="pill muted">Not contacted</span>;
  return <span className={`pill stage stage-${stage}`}>{STAGE_LABELS[stage as Stage] ?? stage}</span>;
}

export function DispositionBadge({ disposition }: { disposition: string | null }) {
  if (!disposition) return null;
  return <Pill value={disposition} label={DISPOSITION_LABELS[disposition] ?? disposition} />;
}

export function ChannelName({ kind }: { kind: string | null }) {
  if (!kind) return <span className="muted">—</span>;
  return <>{CHANNEL_LABELS[kind as ChannelKind] ?? kind}</>;
}

/** Shows a time in Asia/Jerusalem without inventing precision; optional relative hint. */
export function When({ at, precision = "exact", relative = false }: { at: string | null; precision?: string; relative?: boolean }) {
  if (!at) return <span className="muted">Date unknown</span>;
  const text = formatEvidenceTime(at, precision as TimestampPrecision);
  return (
    <time dateTime={at} title={at}>
      {text}
      {relative && precision === "exact" ? <span className="muted"> · {relativeTime(at)}</span> : null}
    </time>
  );
}

export function Flash({ ok, error }: { ok?: string; error?: string }) {
  if (error) return <p className="flash bad" role="alert">{error}</p>;
  if (ok) return <p className="flash ok" role="status">{ok}</p>;
  return null;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function PageHeader({ title, subtitle, actions }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

export function Stat({ label, value, href, tone }: { label: string; value: React.ReactNode; href?: string; tone?: "warn" | "bad" }) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className={`stat ${tone ?? ""}`}>{value}</div>
    </>
  );
  return href ? <Link className="card stat-card" href={href}>{body}</Link> : <div className="card stat-card">{body}</div>;
}
