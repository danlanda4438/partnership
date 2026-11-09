// Applies a human/agent verification sheet ("Lead actual status") to the import plan.
// Each verified prospect gets a dated verification entry with the checker's evidence, and its
// status is corrected — but a verification never erases a recorded send: if it contradicts the
// outreach ledger, both are kept and the conflict is reported.
import type { Channel, Plan, PlanEvent, PlanOpp, SourceRef } from "./normalize";
import { lower, norm, parseTime } from "./util";
import { type Snapshot, tab } from "./workbook";

const CHANNEL: Record<string, Channel> = { affiliates: "affiliates", "co-marketing": "co_marketing", "media & pr": "media_pr", listings: "listings" };
const ORDER = ["contacted", "replied", "interested", "discussion_proposal", "agreed", "live"] as const;

export interface VerificationResult { applied: number; unmatched: { prospect: string; channel: string }[]; merged: string[]; changes: Record<string, number> }

export function applyVerification(plan: Plan, sheet: Snapshot, verifiedOn = "2026-11-09"): VerificationResult {
  const t = tab(sheet, "Lead actual status");
  const result: VerificationResult = { applied: 0, unmatched: [], merged: [], changes: {} };
  const bump = (k: string) => { result.changes[k] = (result.changes[k] ?? 0) + 1; };
  if (!t) return result;

  const byName = (channel: Channel, name: string) =>
    [...plan.opps.values()].filter((o) => o.channel === channel && lower(plan.orgs.get(o.orgKey)?.name) === lower(name));

  for (const r of t.rows) {
    const channel = CHANNEL[lower(r.values["Channel"])];
    const prospect = norm(r.values["Prospect"]);
    if (!channel || !prospect) continue;
    const actual = norm(r.values["Actual status"]);
    const evidence = norm(r.values["Evidence"]);
    const fix = norm(r.values["Correct tracker value / fix"]);
    const touch = parseTime(r.values["Last verified touch (Asia/Jerusalem)"]);
    const src: SourceRef = { file: sheet.fileName, tab: t.name, row: r.rowNumber };

    let targets = byName(channel, prospect);
    // Verified alias: "X" is the same as "X (City)" that already holds the recorded outreach.
    if (targets.length && targets.every((o) => !o.stage) && /^replied|^contacted|^interested/i.test(actual)) {
      const longer = [...plan.opps.values()].find((o) => o.channel === channel && o.stage
        && lower(plan.orgs.get(o.orgKey)?.name).startsWith(`${lower(prospect)} (`));
      if (longer) {
        for (const dup of targets) mergeInto(plan, dup, longer);
        result.merged.push(`${prospect} → ${plan.orgs.get(longer.orgKey)?.name}`);
        targets = [longer];
      }
    }
    if (!targets.length) { result.unmatched.push({ prospect, channel }); continue; }

    for (const opp of targets) {
      result.applied++;
      const verifyKey = `event:verification:${verifiedOn}:${r.rowNumber}:${opp.key}`;
      const verifyEvent: PlanEvent = {
        key: verifyKey, oppKey: opp.key, eventType: "verification.checked",
        time: { at: `${verifiedOn}T10:00:00.000Z`, precision: "day", timezone: "Asia/Jerusalem", raw: verifiedOn },
        summary: `Verified ${verifiedOn}: ${actual}. ${evidence}${fix ? ` — Fix: ${fix}` : ""}`.slice(0, 2000),
        source: src, message: null, assessments: [],
      };
      plan.events.push(verifyEvent);
      opp.lastVerifiedKey = verifyKey; opp.lastVerifiedAt = verifyEvent.time.at;
      const hasLedgerSend = plan.events.some((e) => e.oppKey === opp.key && e.message?.direction === "outbound");
      const a = lower(actual);

      // Evidence event for a real touch the ledger didn't have (dated by the checker's finding).
      const touchEvidence = (eventType: string, summary: string): string => {
        const key = `event:verification-touch:${verifiedOn}:${r.rowNumber}:${opp.key}`;
        if (!plan.events.some((e) => e.key === key)) {
          plan.events.push({ key, oppKey: opp.key, eventType, time: touch, summary: `${summary} (found by verification ${verifiedOn}): ${evidence}`.slice(0, 2000), source: src, message: null, assessments: [] });
        }
        return key;
      };
      const raise = (stage: (typeof ORDER)[number], evidenceKey: string) => {
        if (!opp.stage || ORDER.indexOf(stage) > ORDER.indexOf(opp.stage)) { opp.stage = stage; opp.stageEvidenceKey = evidenceKey; bump(`stage → ${stage}`); }
      };

      if (a.startsWith("not contacted") || a.startsWith("linkedin request only")) {
        if (hasLedgerSend) {
          plan.exceptions.push({ kind: "verification_conflict", severity: "review", title: `${prospect} (${r.values["Channel"]})`,
            detail: `Verification says "${actual}" but the outreach record has a send. Both kept; decide which is right.`, source: src });
        } else {
          if (opp.stage) bump("stage cleared");
          opp.stage = null; opp.stageEvidenceKey = null;
          if (/paid/i.test(`${evidence} ${fix}`)) { opp.disposition = "on_hold"; bump("on hold (paid only)"); }
          if (a.startsWith("linkedin")) { opp.notes.push(`LinkedIn connection request only (verified ${verifiedOn}); not contact.`); bump("connection request only"); }
          else bump("confirmed not contacted");
        }
      } else if (a.startsWith("contacted")) {
        raise("contacted", opp.stageEvidenceKey ?? touchEvidence(/linkedin/i.test(evidence) ? "linkedin.message_sent" : "message.sent", "Contact"));
        if (opp.disposition === "needs_verification" && !/mismatch|wrong/i.test(`${evidence} ${fix}`)) opp.disposition = null;
        if (/bounce/i.test(`${evidence} ${fix}`)) opp.disposition = "bounced";
        bump("confirmed contacted");
      } else if (a.startsWith("replied – auto") || a.startsWith("replied - auto")) {
        raise("contacted", opp.stageEvidenceKey ?? touchEvidence("message.sent", "Contact"));
        opp.disposition = "automatic_only"; bump("automatic reply only");
      } else if (a.startsWith("replied")) {
        raise("replied", opp.stage ? opp.stageEvidenceKey! : touchEvidence("message.received", "Human reply"));
        bump("confirmed replied");
      } else if (a.startsWith("interested")) {
        if (!opp.stage) {
          // e.g. a duplicate row whose engagement is tracked in another channel: note, don't double count.
          opp.notes.push(`Verified ${verifiedOn}: ${actual}. ${fix}`); bump("interest noted (tracked elsewhere)");
        } else bump("confirmed interested");
      } else if (a.startsWith("unverifiable")) {
        opp.disposition = "needs_verification"; bump("needs verification");
        plan.exceptions.push({ kind: "verification_task", severity: "review", title: `${prospect} (${r.values["Channel"]})`,
          detail: `Could not be verified: ${evidence}. Create a task to check it.`, source: src });
      } else if (a.startsWith("live")) {
        raise("live", touchEvidence("placement.live", "Live"));
        if (channel === "listings") opp.milestone = "publicly_live";
        if (opp.disposition === "needs_verification") opp.disposition = null;
        bump("confirmed live");
      } else if (a.startsWith("pending review")) {
        if (opp.milestone !== "approved_scheduled" && opp.milestone !== "publicly_live") opp.milestone = "pending_review";
        bump("pending review");
      } else if (a.startsWith("blocked") || a.startsWith("submit failed")) {
        opp.disposition = "blocked"; bump("blocked");
      } else if (a.startsWith("rejected") || a.startsWith("declined")) {
        opp.disposition = "declined"; bump("declined");
      } else {
        plan.exceptions.push({ kind: "verification_unrecognized", severity: "review", title: prospect, detail: `Unrecognized verified status "${actual}".`, source: src });
      }
      if (norm(r.values["Next step"])) opp.nextAction = norm(r.values["Next step"]).slice(0, 500);
    }
  }

  // Issues the verification resolved no longer need review.
  const verifiedNames = new Set(t.rows.map((r) => lower(r.values["Prospect"])));
  const resolvable = new Set(["tab_contacted_not_in_ledger", "status_conflict", "connection_only", "name_link", "org_alias", "ledger_party_not_in_inventory", "contact_mismatch"]);
  plan.exceptions = plan.exceptions.filter((e) => !(resolvable.has(e.kind) && verifiedNames.has(lower(e.title.replace(/ \((Affiliates|Co-Marketing|Media & PR|Listings)\)$/, "")))));
  plan.historyMarkers.identifiedUncovered = plan.historyMarkers.identifiedUncovered.filter((e) => {
    const names = [...plan.opps.values()].filter((o) => o.lastVerifiedKey).map((o) => plan.orgs.get(o.orgKey));
    return !names.some((org) => org?.domain && e.title.includes(org.domain));
  });
  return result;
}

function mergeInto(plan: Plan, from: PlanOpp, into: PlanOpp) {
  if (from.key === into.key) return;
  into.sources.push(...from.sources);
  into.notes.push(...from.notes, `Merged with "${plan.orgs.get(from.orgKey)?.name}" (same outlet, confirmed by verification).`);
  for (const e of plan.events) if (e.oppKey === from.key) e.oppKey = into.key;
  for (const o of plan.offers) if (o.oppKey === from.key) o.oppKey = into.key;
  plan.opps.delete(from.key);
  plan.exceptions.push({ kind: "verified_alias", severity: "info", title: `${plan.orgs.get(from.orgKey)?.name} = ${plan.orgs.get(into.orgKey)?.name}`,
    detail: "Merged: the verification confirmed they are the same outlet.", source: from.sources[0] ?? null });
}
