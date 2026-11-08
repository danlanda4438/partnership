// Shared vocabulary. These lists MUST match the database enums; tests/db/vocabulary.test.ts
// fails if they drift apart.

export const CHANNEL_KINDS = ["affiliates", "co_marketing", "media_pr", "listings"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  affiliates: "Affiliates",
  co_marketing: "Co-Marketing",
  media_pr: "Media & PR",
  listings: "Listings",
};

/**
 * Contacted funnel. There is deliberately no "research" stage: uncontacted inventory
 * has no stage at all. Drafts and connection-only actions never establish contact.
 */
export const STAGES = ["contacted", "replied", "interested", "discussion_proposal", "agreed", "live"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  contacted: "Contacted",
  replied: "Replied",
  interested: "Interested",
  discussion_proposal: "Discussion / Proposal",
  agreed: "Agreed",
  live: "Live",
};

/** Kept separate from stage: an opportunity can be "replied" and "declined". */
export const DISPOSITIONS = ["declined", "on_hold", "bounced", "automatic_only", "blocked", "needs_verification"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const MILESTONES: Record<ChannelKind, readonly { key: string; label: string }[]> = {
  affiliates: [
    { key: "agreed", label: "Agreed" },
    { key: "manually_onboarded", label: "Manually onboarded" },
    { key: "promoting", label: "Promoting" },
  ],
  co_marketing: [
    { key: "agreed", label: "Agreed" },
    { key: "implementation", label: "Implementation" },
    { key: "pilot", label: "Pilot" },
    { key: "launched", label: "Launched" },
  ],
  media_pr: [
    { key: "proposal", label: "Proposal" },
    { key: "approved_buy", label: "Approved buy" },
    { key: "signed_io", label: "Signed IO" },
    { key: "placement_live", label: "Placement live" },
  ],
  listings: [
    { key: "submitted", label: "Submitted" },
    { key: "pending_review", label: "Pending review" },
    { key: "approved_scheduled", label: "Approved or scheduled" },
    { key: "publicly_live", label: "Publicly live" },
  ],
};

export const MEMBER_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const APPROVAL_STATUSES = [
  "pending", "approved", "rejected", "expired", "cancelled",
  "executing", "executed", "execution_uncertain", "execution_failed",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TASK_STATUSES = [
  "queued", "claimed", "awaiting_approval", "blocked", "succeeded", "failed", "cancelled", "dead_lettered",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CONNECTION_STATUSES = ["not_configured", "configured", "healthy", "degraded", "blocked", "revoked"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
