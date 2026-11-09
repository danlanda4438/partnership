import type { Plan, Channel } from "./normalize";
import type { Snapshot } from "./workbook";
import { tab } from "./workbook";

const CHANNELS: Channel[] = ["affiliates", "co_marketing", "media_pr", "listings"];
const TOTALS_LABEL: Record<Channel, string> = { affiliates: "Affiliates", co_marketing: "Co-Marketing", media_pr: "Media & PR", listings: "Listings" };

export interface Report {
  generatedAt: string;
  snapshot: { file: string; sha256: string; tabs: { name: string; rows: number; links: number; formulas: number; notes: number }[] }[];
  registry: { registryEntries: number; originalFilesInHistory: number; originalTabsInHistory: number };
  normalized: {
    organizations: number; venueLocations: number; contacts: number; verifiedEmails: number; unverifiedEmails: number;
    opportunities: Record<Channel, { total: number; inFunnel: number; inventory: number; byStage: Record<string, number>; byDisposition: Record<string, number>; byMilestone: Record<string, number> }>;
    events: number; outboundMessages: number; inboundMessages: number; offers: { total: number; accepted: number; proposed: number; amountProposedUsd: number };
  };
  ledger: Record<Channel, {
    rows: number; contacted: number; uniqueOpportunities: number; humanReplies: number; positiveFlags: number; platformInterested: number;
    automaticOnly: number; bounced: number; matchedBy: Record<string, number>;
    sheetTotals: Record<string, string> | null;
  }>;
  exceptions: { kind: string; severity: string; count: number; examples: { title: string; detail: string; source: string | null }[] }[];
  history: { coveredByLedger: number; identifiedNotInLedger: number; unidentifiedHeld: number };
}

export function buildReport(plan: Plan, snapshots: Snapshot[]): Report {
  const count = <T>(xs: T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((a, x) => { const k = f(x); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const opps = [...plan.opps.values()];
  const contacts = [...plan.contacts.values()];
  const emailsAll = contacts.flatMap((c) => c.identities.filter((i) => i.kind === "email"));

  const exceptions = [...plan.exceptions, ...plan.historyMarkers.identifiedUncovered, ...plan.historyMarkers.unidentified];
  const byKind = new Map<string, typeof exceptions>();
  for (const e of exceptions) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);

  const index = snapshots.find((s) => /index/i.test(s.fileName));
  const historyTabs = new Set<string>(); const historyFiles = new Set<string>();
  for (const s of snapshots) for (const r of tab(s, "Source history")?.rows ?? []) { historyFiles.add(r.values["Source file"]); historyTabs.add(`${r.values["Source file"]}::${r.values["Source tab"]}`); }

  const offers = plan.offers;
  return {
    generatedAt: new Date().toISOString(),
    snapshot: snapshots.map((s) => ({ file: s.fileName, sha256: s.fileSha256, tabs: s.tabs.map((t) => ({
      name: t.name, rows: t.rows.length, links: t.rows.reduce((a, r) => a + r.links.length, 0),
      formulas: t.rows.reduce((a, r) => a + Object.keys(r.formulas).length, 0), notes: t.rows.reduce((a, r) => a + Object.keys(r.notes).length, 0) })) })),
    registry: { registryEntries: index ? (tab(index, "Source registry")?.rows.length ?? 0) : 0, originalFilesInHistory: historyFiles.size, originalTabsInHistory: historyTabs.size },
    normalized: {
      organizations: plan.orgs.size,
      venueLocations: [...plan.orgs.values()].filter((o) => o.parentKey).length,
      contacts: contacts.length,
      verifiedEmails: emailsAll.filter((i) => i.verified).length,
      unverifiedEmails: emailsAll.filter((i) => !i.verified).length,
      opportunities: Object.fromEntries(CHANNELS.map((c) => {
        const o = opps.filter((x) => x.channel === c);
        return [c, { total: o.length, inFunnel: o.filter((x) => x.stage).length, inventory: o.filter((x) => !x.stage).length,
          byStage: count(o.filter((x) => x.stage), (x) => x.stage!), byDisposition: count(o.filter((x) => x.disposition), (x) => x.disposition!),
          byMilestone: count(o.filter((x) => x.milestone), (x) => x.milestone!) }];
      })) as Report["normalized"]["opportunities"],
      events: plan.events.length,
      outboundMessages: plan.events.filter((e) => e.message?.direction === "outbound").length,
      inboundMessages: plan.events.filter((e) => e.message?.direction === "inbound").length,
      offers: { total: offers.length, accepted: offers.filter((o) => o.status === "accepted").length, proposed: offers.filter((o) => o.status === "proposed").length,
        amountProposedUsd: offers.filter((o) => o.status === "proposed" && o.currency === "USD").reduce((a, o) => a + (o.amount ?? 0), 0) },
    },
    ledger: Object.fromEntries(CHANNELS.map((c) => {
      const l = plan.ledgerRows.filter((x) => x.channel === c);
      return [c, { rows: l.length, contacted: l.filter((x) => x.contacted).length, uniqueOpportunities: new Set(l.filter((x) => x.contacted).map((x) => x.oppKey)).size,
        humanReplies: l.filter((x) => x.humanReply).length, positiveFlags: l.filter((x) => x.positive).length,
        platformInterested: l.filter((x) => x.platformLabel === "Interested").length, automaticOnly: l.filter((x) => x.automaticOnly).length,
        bounced: l.filter((x) => x.bounced).length, matchedBy: count(l, (x) => x.matchedBy), sheetTotals: plan.totalsTab[TOTALS_LABEL[c]] ?? null }];
    })) as Report["ledger"],
    exceptions: [...byKind.entries()].map(([kind, xs]) => ({ kind, severity: xs[0].severity, count: xs.length,
      examples: xs.slice(0, 12).map((e) => ({ title: e.title, detail: e.detail, source: e.source ? `${e.source.file} › ${e.source.tab} row ${e.source.row}` : null })) }))
      .sort((a, b) => b.count - a.count),
    history: { coveredByLedger: plan.historyMarkers.covered, identifiedNotInLedger: plan.historyMarkers.identifiedUncovered.length, unidentifiedHeld: plan.historyMarkers.unidentified.length },
  };
}
