// Renders the reconciliation report as a self-contained HTML page for the owner to review.
import type { Report } from "./report";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const CH: Record<string, string> = { affiliates: "Affiliates", co_marketing: "Co-Marketing", media_pr: "Media & PR", listings: "Listings" };
const STAGES = ["contacted", "replied", "interested", "discussion_proposal", "agreed", "live"];
const STAGE_LABEL: Record<string, string> = { contacted: "Contacted", replied: "Replied", interested: "Interested", discussion_proposal: "Discussion / Proposal", agreed: "Agreed", live: "Live" };
const KIND_LABEL: Record<string, [string, string]> = {
  history_sent_identified: ["Older sources say “sent”, but there's no send in the Nov 8 record", "Needs your decision: record as historical outreach, or ignore. Nothing is recorded until you decide."],
  history_sent_unidentified: ["Older “sent” markers with no identifiable recipient", "Held. No recipient is invented."],
  tab_contacted_not_in_ledger: ["Channel tab says contacted, but the Nov 8 record has no send", "Imported as not contacted until verified. Often a LinkedIn connection request or a party counted under another channel."],
  status_conflict: ["Status text says “Not contacted” but a send is recorded", "Imported as contacted, because the recorded send (with its timestamp) is the evidence."],
  ledger_party_not_in_inventory: ["Contacted parties missing from the channel tab", "Created from the Nov 8 record so their history isn't lost."],
  contact_mismatch: ["LinkedIn contact marked wrong", "Marked needs verification."],
  connection_only: ["LinkedIn connection requests only", "Not counted as contact (brief rule)."],
  org_alias: ["Merged because they share a website domain", "Same company domain = one organization. Check none of these are wrong."],
  contact_multiple_orgs: ["Same email listed under several organizations", "Mostly chain HQ emails repeated on venue rows. Kept once, linked to the first."],
  name_link: ["Linked by identical outlet name (no email on either side)", "Media & PR only."],
  index_other_stream: ["Index partners outside the four workstreams", "Kept in the archive only."],
  excluded_impact: ["impact.com rows", "Excluded by design."],
  offer_unmatched: ["Offers that couldn't be linked to a partner", "Not imported until linked."],
};

export function renderReportHtml(r: Report): string {
  const channels = Object.keys(r.ledger);
  const totalRows = r.snapshot.reduce((a, f) => a + f.tabs.reduce((b, t) => b + t.rows, 0), 0);
  const totalLinks = r.snapshot.reduce((a, f) => a + f.tabs.reduce((b, t) => b + t.links, 0), 0);
  const totalFormulas = r.snapshot.reduce((a, f) => a + f.tabs.reduce((b, t) => b + t.formulas, 0), 0);
  const cmp = (mine: number, sheet: string | undefined) => {
    const s = Number(sheet);
    return Number.isFinite(s) && sheet !== undefined ? `${mine} <span class="${mine === s ? "ok" : "warn"}">${mine === s ? "✓ matches" : `sheet: ${esc(sheet)}`}</span>` : String(mine);
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Migration Dry Run</title>
<style>
:root{--bg:#f6f6f3;--surface:#fff;--text:#1c1c1a;--muted:#6b6b66;--border:#e2e2dc;--ok:#1f5c36;--okbg:#e5f3ea;--warn:#7a5200;--warnbg:#fdf3dc;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#131312;--surface:#1c1c1a;--text:#ededea;--muted:#a3a39d;--border:#32322e;--ok:#9fdcb5;--okbg:#173123;--warn:#f3d48a;--warnbg:#3a2e10;--accent:#7fbfa9}}
:root[data-theme="dark"]{--bg:#131312;--surface:#1c1c1a;--text:#ededea;--muted:#a3a39d;--border:#32322e;--ok:#9fdcb5;--okbg:#173123;--warn:#f3d48a;--warnbg:#3a2e10;--accent:#7fbfa9}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:28px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:34px 0 10px}h3{font-size:15px;margin:0 0 6px}
.muted{color:var(--muted)}.small{font-size:13px}.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:10px 0}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}.stat{font-size:26px;font-weight:650}
.table{overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:10px}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
td,th{padding:7px 12px;border-bottom:1px solid var(--border);text-align:left;font-size:14px;vertical-align:top}th{color:var(--muted);font-weight:500}td.n,th.n{text-align:right}tr:last-child td{border-bottom:0}
.ok{background:var(--okbg);color:var(--ok);border-radius:999px;padding:1px 8px;font-size:12px;margin-left:6px;white-space:nowrap}
.warn{background:var(--warnbg);color:var(--warn);border-radius:999px;padding:1px 8px;font-size:12px;margin-left:6px;white-space:nowrap}
details{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin:8px 0}summary{cursor:pointer;font-weight:600}
ul{margin:6px 0;padding-left:20px}li{margin:3px 0}.pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;background:var(--warnbg);color:var(--warn)}
</style></head><body><main>
<h1>Spreadsheet migration: dry run</h1>
<p class="muted">Generated ${esc(r.generatedAt.slice(0, 16).replace("T", " "))} UTC from your 5 exported workbooks. <strong>Nothing has been written to the app yet.</strong> Your Google Sheets were not touched.</p>

<h2>1. Did the numbers come out right?</h2>
<p>The app's counts, rebuilt from the raw outreach record, compared with your <em>Outreach totals Nov8</em> tab:</p>
<div class="table"><table><thead><tr><th>Channel</th><th class="n">Parties reached</th><th class="n">Human replies</th><th class="n">Positive outcomes</th><th class="n">Automatic only</th><th class="n">Bounced</th></tr></thead><tbody>
${channels.map((c) => { const l = r.ledger[c as keyof typeof r.ledger]; const t = l.sheetTotals ?? {};
  return `<tr><td>${CH[c]}</td><td class="n">${cmp(l.contacted, t["Reached unique parties / workflows"])}</td><td class="n">${cmp(l.humanReplies, t["Human replies"])}</td><td class="n">${cmp(l.positiveFlags, t["Positive / positive outcomes"])}</td><td class="n">${l.automaticOnly}</td><td class="n">${l.bounced}</td></tr>`; }).join("")}
</tbody></table></div>
<p class="small muted">Affiliates' 12 positives are Instantly “Interested” labels. They're kept as labels, not counted as agreed deals. Media & PR positives mean a next step or offer, not approved spend. Listings positives are approvals, launches and one paid placement, none of them human replies.</p>

<h2>2. What will be created in the app</h2>
<div class="grid">
<div class="card"><div class="muted small">Organizations</div><div class="stat">${r.normalized.organizations.toLocaleString()}</div><div class="small muted">${r.normalized.venueLocations.toLocaleString()} are individual venue locations linked to their chain</div></div>
<div class="card"><div class="muted small">People</div><div class="stat">${r.normalized.contacts.toLocaleString()}</div><div class="small muted">${r.normalized.verifiedEmails} verified emails, ${r.normalized.unverifiedEmails.toLocaleString()} unverified</div></div>
<div class="card"><div class="muted small">Evidence events</div><div class="stat">${r.normalized.events}</div><div class="small muted">${r.normalized.outboundMessages} sends, ${r.normalized.inboundMessages} replies</div></div>
<div class="card"><div class="muted small">Offers</div><div class="stat">${r.normalized.offers.total}</div><div class="small muted">${r.normalized.offers.accepted} accepted · ${r.normalized.offers.proposed} proposed (≈ $${Math.round(r.normalized.offers.amountProposedUsd).toLocaleString()}, <strong>not approved spend</strong>)</div></div>
</div>
<div class="table"><table><thead><tr><th>Channel</th><th class="n">Not yet contacted</th>${STAGES.map((s) => `<th class="n">${STAGE_LABEL[s]}</th>`).join("")}<th>Dispositions</th><th>Milestones</th></tr></thead><tbody>
${Object.entries(r.normalized.opportunities).map(([c, o]) => `<tr><td>${CH[c]}</td><td class="n">${o.inventory.toLocaleString()}</td>${STAGES.map((s) => `<td class="n">${o.byStage[s] ?? 0}</td>`).join("")}<td class="small">${Object.entries(o.byDisposition).map(([k, n]) => `${esc(k.replace(/_/g, " "))} ${n}`).join(", ") || "—"}</td><td class="small">${Object.entries(o.byMilestone).map(([k, n]) => `${esc(k.replace(/_/g, " "))} ${n}`).join(", ") || "—"}</td></tr>`).join("")}
</tbody></table></div>
<p class="small muted">Every stage is backed by a specific recorded send or reply. Each record keeps a link to the exact spreadsheet row it came from.</p>

<h2>3. Things to review (${r.exceptions.filter((e) => e.severity !== "info").reduce((a, e) => a + e.count, 0)} items need a look)</h2>
${r.exceptions.map((e) => { const [title, help] = KIND_LABEL[e.kind] ?? [e.kind, ""]; return `<details${e.severity === "review" ? " open" : ""}><summary>${esc(title)}: ${e.count} ${e.severity === "review" ? '<span class="pill">review</span>' : ""}</summary>
<p class="small muted">${esc(help)}</p><ul>${e.examples.map((x) => `<li><strong>${esc(x.title)}</strong>. <span class="small">${esc(x.detail)}</span>${x.source ? `<div class="small muted">${esc(x.source)}</div>` : ""}</li>`).join("")}</ul>${e.count > e.examples.length ? `<p class="small muted">…and ${e.count - e.examples.length} more (full list in the import tool).</p>` : ""}</details>`; }).join("")}

<h2>4. Is everything preserved?</h2>
<div class="card"><ul>
<li><strong>${totalRows.toLocaleString()}</strong> spreadsheet rows across ${r.snapshot.reduce((a, f) => a + f.tabs.length, 0)} tabs are kept as an unchangeable archive, each with a fingerprint (checksum) so later changes can be detected.</li>
<li><strong>${totalLinks.toLocaleString()}</strong> link destinations kept. <strong>${totalFormulas}</strong> formulas kept as text, never run.</li>
<li>Your <em>Source history</em> tabs preserve <strong>${r.registry.originalTabsInHistory}</strong> tabs from <strong>${r.registry.originalFilesInHistory}</strong> original workbooks. The index registry lists ${r.registry.registryEntries} entries; the brief mentions 19 workbooks / 77 tabs, so up to 2 original files may only be reachable through their original links.</li>
<li>Google comments aren't included in Excel downloads; they stay reachable in the original sheets. <em>Unified contacts</em> is archived as a dated snapshot, not used as live truth.</li>
</ul></div>
<div class="table"><table><thead><tr><th>Workbook</th><th>Tab</th><th class="n">Rows</th><th class="n">Links</th><th class="n">Formulas</th></tr></thead><tbody>
${r.snapshot.map((f) => f.tabs.map((t, i) => `<tr><td class="small">${i === 0 ? esc(f.file) : ""}</td><td class="small">${esc(t.name)}</td><td class="n">${t.rows.toLocaleString()}</td><td class="n">${t.links.toLocaleString()}</td><td class="n">${t.formulas}</td></tr>`).join("")).join("")}
</tbody></table></div>

<h2>5. What happens next</h2>
<div class="card"><ol>
<li>You review section 3 and tell me about anything that looks wrong.</li>
<li>For the older “sent” records (section 3, first item): you decide whether to record them as historical outreach or ignore them.</li>
<li>I build the import into the app. You'll upload these same files on an admin page, see this same report, and click Import. It can be re-run safely.</li>
<li>Switching over (the app becomes the source of truth, sheets become read-only archives) happens only when you approve it, with a backup and a way back.</li>
</ol></div>
</main></body></html>`;
}
