// Spreadsheet snapshots → normalized import plan (organizations, contacts, opportunities,
// evidence events with messages, offers) + exceptions. Pure and deterministic: the same
// snapshots always produce the same plan and the same stable keys.
//
// Rules (from the brief):
//  * The "Outreach update Nov8" ledger is the single activity source; channel-tab statuses are
//    cross-checked against it, never counted twice.
//  * Identity: verified email → same contact; same website domain → same organization (shared
//    mail domains excluded); never names alone (Media & PR outlet-name links are reported).
//  * Drafts and connection-only actions are not contact. Platform labels stay labels.
//  * No invented timestamps or recipients; unidentified historical markers are held.
import { type Snapshot, type SnapshotRow, tab } from "./workbook";
import { domainOf, emailDomain, emails, lower, norm, orgDomain, parseTime, slug, type ParsedTime } from "./util";

export type Channel = "affiliates" | "co_marketing" | "media_pr" | "listings";
export type Stage = "contacted" | "replied" | "interested" | "discussion_proposal" | "agreed" | "live";
export type Disposition = "declined" | "on_hold" | "bounced" | "automatic_only" | "blocked" | "needs_verification";

export interface SourceRef { file: string; tab: string; row: number }

export interface PlanOrg { key: string; name: string; website: string | null; domain: string | null; parentKey: string | null; location: string | null; country: string | null; notes: string | null; sources: SourceRef[]; aliases?: { alias: string; justification: string }[] }
export interface PlanIdentity { kind: "email" | "linkedin" | "website" | "phone"; value: string; normalized: string; verified: boolean; verificationSource: string | null }
export interface PlanContact { key: string; orgKey: string; name: string | null; title: string | null; identities: PlanIdentity[]; sources: SourceRef[] }
export interface PlanOpp {
  key: string; channel: Channel; orgKey: string; primaryContactKey: string | null;
  stage: Stage | null; stageEvidenceKey: string | null; disposition: Disposition | null; milestone: string | null;
  nextAction: string | null; nextActionDue: string | null; notes: string[]; attributes: Record<string, string>; sources: SourceRef[];
  matchedBy: string[]; lastVerifiedKey?: string | null; lastVerifiedAt?: string | null;
}
export interface PlanMessage {
  provider: string; providerMessageId: string | null; threadId: string | null; direction: "outbound" | "inbound";
  status: "sent" | "bounced" | "received" | "uncertain"; isAutomatic: boolean | null;
  from: string | null; to: string[]; subject: string | null; body: string | null;
}
export interface PlanEvent {
  key: string; oppKey: string; eventType: string; time: ParsedTime; summary: string; source: SourceRef;
  message: PlanMessage | null;
  assessments: { source: "human" | "automatic" | "platform"; classification: string | null; platformLabel: string | null; isHumanReply: boolean | null; conditions: string | null }[];
}
export interface PlanOffer { key: string; oppKey: string; kind: string; terms: string; amount: number | null; currency: string | null; isPaid: boolean; status: "proposed" | "accepted" | "draft"; ioSigned: false; source: SourceRef }
export interface PlanException { kind: string; severity: "info" | "review" | "held"; title: string; detail: string; source: SourceRef | null }

export interface Plan {
  orgs: Map<string, PlanOrg>;
  contacts: Map<string, PlanContact>;
  opps: Map<string, PlanOpp>;
  events: PlanEvent[];
  offers: PlanOffer[];
  exceptions: PlanException[];
  ledgerRows: LedgerRow[];
  totalsTab: Record<string, Record<string, string>>;
  historyMarkers: { covered: number; identifiedUncovered: PlanException[]; unidentified: PlanException[] };
}

export interface LedgerRow {
  channel: Channel; partyKey: string; company: string; email: string | null; oppKey: string; matchedBy: string;
  counted: boolean; humanReply: boolean; positive: boolean; replyClass: string; platformLabel: string | null; method: string;
  currentStatus: string; bounced: boolean; automaticOnly: boolean; contacted: boolean;
}

const CHANNEL_BY_LABEL: Record<string, Channel> = {
  affiliates: "affiliates", "co-marketing": "co_marketing", "media & pr": "media_pr", listings: "listings",
};

export interface Inputs { affiliates: Snapshot; coMarketing: Snapshot; mediaPr: Snapshot; listings: Snapshot; index: Snapshot }

export function buildPlan(inp: Inputs): Plan {
  const plan: Plan = {
    orgs: new Map(), contacts: new Map(), opps: new Map(), events: [], offers: [], exceptions: [], ledgerRows: [],
    totalsTab: {}, historyMarkers: { covered: 0, identifiedUncovered: [], unidentified: [] },
  };
  const ref = (s: Snapshot, tabName: string, r: SnapshotRow): SourceRef => ({ file: s.fileName, tab: tabName, row: r.rowNumber });
  const v = (r: SnapshotRow, col: string) => norm(r.values[col]);

  // ---------------------------------------------------------------- helpers
  const emailOwner = new Map<string, string>();       // normalized email -> contact key
  const domainOrg = new Map<string, string>();         // domain -> org key
  const channelOrgOpp = new Map<string, string>();     // `${channel}|${orgKey}` -> opp key
  const listingIdOpp = new Map<string, string>();      // listing partner_id -> opp key
  const nameOpp = new Map<string, string>();           // `${channel}|${lower name}` -> opp key (reported links only)

  function upsertOrg(o: Omit<PlanOrg, "key" | "sources">, source: SourceRef, fallbackKey: string): string {
    const key = o.domain ? `org:domain:${o.domain}` : `org:${fallbackKey}`;
    const existing = plan.orgs.get(key);
    if (existing) {
      existing.sources.push(source);
      existing.website ??= o.website; existing.location ??= o.location; existing.country ??= o.country;
      if (existing.name !== o.name && o.domain) {
        existing.aliases ??= [];
        if (!existing.aliases.some((a) => a.alias === o.name)) existing.aliases.push({ alias: o.name, justification: `Same website domain ${o.domain}` });
        plan.exceptions.push({ kind: "org_alias", severity: "info", title: `${existing.name} = ${o.name}`,
          detail: `Same website domain ${o.domain}; treated as one organization (justified alias).`, source });
      }
      return key;
    }
    plan.orgs.set(key, { key, ...o, sources: [source] });
    if (o.domain) domainOrg.set(o.domain, key);
    return key;
  }

  function upsertContact(orgKey: string, name: string | null, title: string | null, identities: PlanIdentity[], source: SourceRef, fallbackKey: string): string | null {
    const verifiedEmail = identities.find((i) => i.kind === "email" && i.verified);
    const anyEmail = identities.find((i) => i.kind === "email");
    if (!name && !anyEmail) return null;
    // Same verified email → same contact. Otherwise a contact is per org+name (distinct people stay distinct).
    let key = verifiedEmail && emailOwner.get(verifiedEmail.normalized);
    if (!key) key = anyEmail ? `contact:email:${anyEmail.normalized}` : `contact:${orgKey}:${slug(name ?? fallbackKey)}`;
    const existing = plan.contacts.get(key);
    if (existing) {
      existing.sources.push(source);
      existing.name ??= name; existing.title ??= title;
      for (const i of identities) {
        const have = existing.identities.find((x) => x.kind === i.kind && x.normalized === i.normalized);
        if (!have) existing.identities.push(i);
        else if (i.verified && !have.verified) Object.assign(have, { verified: true, verificationSource: i.verificationSource });
      }
      if (existing.orgKey !== orgKey) {
        plan.exceptions.push({ kind: "contact_multiple_orgs", severity: "info", title: `${anyEmail?.value ?? name} appears under two organizations`,
          detail: `Kept under ${existing.orgKey}; also listed under ${orgKey}.`, source });
      }
      return key;
    }
    plan.contacts.set(key, { key, orgKey, name, title, identities: [...identities], sources: [source] });
    for (const i of identities) if (i.kind === "email" && !emailOwner.has(i.normalized)) emailOwner.set(i.normalized, key);
    return key;
  }

  function upsertOpp(channel: Channel, orgKey: string, contactKey: string | null, source: SourceRef, attrs: Record<string, string>, notes: string[] = []): string {
    const key = `opp:${channel}:${orgKey}`;
    const existing = plan.opps.get(key);
    if (existing) {
      existing.sources.push(source);
      existing.primaryContactKey ??= contactKey;
      Object.entries(attrs).forEach(([k, val]) => { if (val && !existing.attributes[k]) existing.attributes[k] = val; });
      existing.notes.push(...notes);
      return key;
    }
    const orgName = plan.orgs.get(orgKey)?.name;
    if (orgName && !nameOpp.has(`${channel}|${lower(orgName)}`)) nameOpp.set(`${channel}|${lower(orgName)}`, key);
    plan.opps.set(key, { key, channel, orgKey, primaryContactKey: contactKey, stage: null, stageEvidenceKey: null, disposition: null,
      milestone: null, nextAction: null, nextActionDue: null, notes: [...notes], attributes: attrs, sources: [source], matchedBy: [] });
    channelOrgOpp.set(`${channel}|${orgKey}`, key);
    return key;
  }

  const emailIdentities = (text: string, verified: boolean, verificationSource: string | null): PlanIdentity[] =>
    emails(text).map((e) => ({ kind: "email", value: e, normalized: e, verified, verificationSource }));
  const linkedin = (url: string): PlanIdentity[] =>
    url && /linkedin\.com\/in\//i.test(url) ? [{ kind: "linkedin", value: url, normalized: lower(url).replace(/\/+$/, ""), verified: false, verificationSource: null }] : [];

  // ---------------------------------------------------------------- Affiliates inventory
  {
    const s = inp.affiliates; const t = tab(s, "Gleeday Affiliate Prospects");
    for (const r of t?.rows ?? []) {
      const name = v(r, "Name"); if (!name) continue;
      const src = ref(s, t!.name, r);
      const website = v(r, "Website/blog URL") || null;
      const orgKey = upsertOrg({ name, website, domain: orgDomain(website, name), parentKey: null, location: v(r, "Location") || null, country: null,
        notes: v(r, "Personalization notes") || null }, src, `affiliates:${slug(name)}:r${r.rowNumber}`);
      const confidence = v(r, "Contact confidence");
      const verified = /^verified/i.test(confidence);
      const contactKey = upsertContact(orgKey, v(r, "Key contact name") || null, v(r, "Key contact title") || null,
        [...emailIdentities(v(r, "Email(s)"), verified, verified ? confidence : null), ...linkedin(v(r, "LinkedIn (person)"))], src, name);
      upsertOpp("affiliates", orgKey, contactKey, src, {
        category: v(r, "Category"), fit_score: v(r, "Fit score (1-5)"), potential: v(r, "Potential"), audience: v(r, "Audience/size"),
        contact_form: v(r, "Contact form URL"), sheet_status: v(r, "Status"), contact_confidence: confidence,
      });
    }
  }

  // ---------------------------------------------------------------- Co-Marketing inventory
  {
    const s = inp.coMarketing;
    const venues = tab(s, "Venues");
    const hqByChain = new Map<string, string>();
    const sorted = [...(venues?.rows ?? [])].sort((a, b) => (v(a, "level") === "HQ" ? -1 : 0) - (v(b, "level") === "HQ" ? -1 : 0));
    for (const r of sorted) {
      const chain = v(r, "chain"); const name = v(r, "name") || chain; if (!name) continue;
      const src = ref(s, venues!.name, r);
      const isHq = v(r, "level") === "HQ";
      const location = [v(r, "city"), v(r, "state")].filter(Boolean).join(", ") || null;
      let parentKey: string | null = null;
      if (!isHq && chain) {
        parentKey = hqByChain.get(lower(chain)) ?? null;
        if (!parentKey) {
          parentKey = upsertOrg({ name: chain, website: null, domain: null, parentKey: null, location: null, country: null, notes: null }, src, `venue-chain:${slug(chain)}`);
          hqByChain.set(lower(chain), parentKey);
        }
      }
      // Each venue location is its own organization (preserved), linked to its chain.
      const fallback = isHq ? `venue-chain:${slug(chain || name)}` : `venue:${slug(chain)}:${slug(name)}:${slug(location ?? "")}:${slug(v(r, "address"))}:r${r.rowNumber}`;
      const website = isHq ? (v(r, "contact_form_url") || null) : null;
      const orgKey = upsertOrg({ name: isHq ? (chain || name) : name, website, domain: isHq ? domainOf(website) : null, parentKey,
        location: isHq ? location : [location, v(r, "address")].filter(Boolean).join(" — ") || null, country: v(r, "country_flag") || null,
        notes: v(r, "personalization_notes") || null }, src, fallback);
      if (isHq && chain) hqByChain.set(lower(chain), orgKey);
      const verified = v(r, "contact_verified") === "verified";
      const contactKey = upsertContact(orgKey, v(r, "contact_name") || null, v(r, "contact_role") || null,
        [...emailIdentities(v(r, "email"), verified, verified ? v(r, "email_source") || "verified in sheet" : null), ...linkedin(v(r, "linkedin_url"))], src, name);
      const oppKey = upsertOpp("co_marketing", orgKey, contactKey, src, {
        venue_level: v(r, "level"), priority: v(r, "priority"), coming_soon: v(r, "coming_soon"),
        email_status: v(r, "email_status"), linkedin_status: v(r, "linkedin_status"), overall_status: v(r, "overall_status"),
      });
      const opp = plan.opps.get(oppKey)!;
      if (v(r, "next_action")) opp.nextAction ??= v(r, "next_action");
      if (/contact mismatch/i.test(v(r, "linkedin_status"))) {
        opp.disposition ??= "needs_verification";
        plan.exceptions.push({ kind: "contact_mismatch", severity: "review", title: `${name}: LinkedIn contact mismatch`, detail: "Sheet says the LinkedIn contact is wrong; needs a new contact.", source: src });
      }
    }
    for (const tabName of ["Platforms & integrations", "Products & tech"]) {
      const t = tab(s, tabName);
      for (const r of t?.rows ?? []) {
        const name = v(r, "name"); if (!name) continue;
        const src = ref(s, t!.name, r);
        const website = v(r, "Website") || null;
        const orgKey = upsertOrg({ name: name.replace(/\s*\(one-door route\)\s*/i, ""), website, domain: orgDomain(website, name), parentKey: null,
          location: v(r, "location") || null, country: null, notes: v(r, "personalization_notes") || null }, src, `co-m:${slug(name)}`);
        const ids = [...emailIdentities(`${v(r, "email")} ${v(r, "direct_email")}`, false, null), ...linkedin(v(r, "linkedin_url"))];
        const contactKey = upsertContact(orgKey, v(r, "contact_name") || null, v(r, "contact_role") || null, ids, src, name);
        upsertOpp("co_marketing", orgKey, contactKey, src, { segment: tabName, priority: v(r, "priority"), fit_score: v(r, "fit_score"),
          email_status: v(r, "email_status"), linkedin_status: v(r, "linkedin_status") });
      }
    }
  }

  // ---------------------------------------------------------------- Media & PR inventory
  {
    const s = inp.mediaPr; const t = tab(s, "Prospects");
    for (const r of t?.rows ?? []) {
      const name = v(r, "Name"); if (!name) continue;
      const src = ref(s, t!.name, r);
      const website = v(r, "Website") || null;
      const orgKey = upsertOrg({ name, website, domain: orgDomain(website, name), parentKey: null, location: v(r, "Geography") || null, country: null,
        notes: v(r, "Description") || null }, src, `media:${slug(name)}`);
      const contactKey = upsertContact(orgKey, null, null, emailIdentities(v(r, "Email"), false, null), src, name);
      const oppKey = upsertOpp("media_pr", orgKey, contactKey, src, { category: v(r, "Category"), opportunity_type: v(r, "Opportunity type"),
        pricing: v(r, "Pricing / model"), rank: v(r, "Rank (1-5)"), priority: v(r, "Priority"), audience: v(r, "Audience (size + source of number)") },
        v(r, "Notes / next step") ? [v(r, "Notes / next step")] : []);
      nameOpp.set(`media_pr|${lower(name)}`, oppKey);
    }
  }

  // ---------------------------------------------------------------- Listings inventory
  {
    const s = inp.listings; const t = tab(s, "Gleeday Listing Prospects");
    for (const r of t?.rows ?? []) {
      const name = v(r, "name"); if (!name) continue;
      const src = ref(s, t!.name, r);
      const website = v(r, "website") || null;
      const orgKey = upsertOrg({ name, website, domain: orgDomain(website, name), parentKey: null, location: null, country: null, notes: v(r, "priority_reason") || null },
        src, `listing:${v(r, "partner_id") || slug(name)}`);
      const contactKey = upsertContact(orgKey, v(r, "contact_person") && v(r, "contact_person") !== "unknown" ? v(r, "contact_person") : null, null,
        emailIdentities(v(r, "contact_email"), false, null), src, name);
      const oppKey = upsertOpp("listings", orgKey, contactKey, src, { partner_id: v(r, "partner_id"), type: v(r, "type"), free_paid: v(r, "free_paid"),
        priority: v(r, "priority"), sheet_status: v(r, "status"), submission_url: v(r, "listing_or_submission_url"), tracking_link: v(r, "tracking_link"),
        cost_verified: v(r, "cost_verified_oct23") }, v(r, "notes") ? [v(r, "notes")] : []);
      if (v(r, "partner_id")) listingIdOpp.set(v(r, "partner_id").replace(/\.0$/, ""), oppKey);
      applyListingStatus(plan.opps.get(oppKey)!, v(r, "status"), src);
    }
    const paid = tab(s, "Paid options");
    for (const r of paid?.rows ?? []) {
      const name = v(r, "name"); if (!name) continue;
      const src = ref(s, paid!.name, r);
      const url = v(r, "url") || null;
      const orgKey = upsertOrg({ name, website: url, domain: domainOf(url), parentKey: null, location: null, country: null, notes: v(r, "what_you_get") || null }, src, `paid-option:${slug(name)}`);
      const oppKey = upsertOpp("listings", orgKey, null, src, { category: v(r, "category"), verdict: v(r, "verdict"), checked: v(r, "checked") });
      const price = Number(v(r, "price_usd"));
      const live = /^LIVE/i.test(v(r, "verdict"));
      plan.offers.push({ key: `offer:paid-option:${slug(name)}`, oppKey, kind: "paid_listing", terms: [v(r, "what_you_get"), v(r, "duration")].filter(Boolean).join(" — ") || name,
        amount: Number.isFinite(price) && price > 0 ? price : null, currency: Number.isFinite(price) && price > 0 ? "USD" : null, isPaid: true,
        status: live ? "accepted" : "proposed", ioSigned: false, source: src });
    }
  }

  // ---------------------------------------------------------------- Index partners (cross-stream master)
  {
    const s = inp.index; const t = tab(s, "Partners");
    const streamChannel: Record<string, Channel> = { "co-m": "co_marketing", affiliate: "affiliates", listing: "listings", paid: "media_pr" };
    for (const r of t?.rows ?? []) {
      const name = v(r, "Partner"); if (!name) continue;
      const src = ref(s, t!.name, r);
      const channel = streamChannel[lower(v(r, "Stream"))];
      if (/impact\.com/i.test(`${name} ${v(r, "Website")}`)) {
        plan.exceptions.push({ kind: "excluded_impact", severity: "info", title: name, detail: "impact.com is excluded from this app by design; not imported.", source: src });
        continue;
      }
      if (!channel) {
        plan.exceptions.push({ kind: "index_other_stream", severity: "info", title: name, detail: `Stream "${v(r, "Stream")}" is outside the four workstreams; kept in the archive only.`, source: src });
        continue;
      }
      const website = v(r, "Website") || null;
      const domain = orgDomain(website, name);
      const existingOrg = domain ? domainOrg.get(domain) : undefined;
      const orgKey = existingOrg ?? upsertOrg({ name, website, domain, parentKey: null, location: null, country: null, notes: v(r, "Reach / size") || null }, src, `index:${slug(name)}`);
      if (existingOrg) plan.orgs.get(existingOrg)!.sources.push(src);
      const contactKey = upsertContact(orgKey, null, null, emailIdentities(v(r, "Contact"), false, null), src, name);
      upsertOpp(channel, orgKey, contactKey, src, { initiative: v(r, "Initiative"), index_status: v(r, "Status / notes"), deal: v(r, "The deal (this stream)") });
    }
  }

  // ---------------------------------------------------------------- Media & PR outreach details (Gmail ids, bodies)
  const mediaOutreach = new Map<string, { row: SnapshotRow; src: SourceRef }>();
  {
    const s = inp.mediaPr; const t = tab(s, "Outreach");
    for (const r of t?.rows ?? []) {
      const p = v(r, "Prospect"); if (!p) continue;
      mediaOutreach.set(lower(p), { row: r, src: ref(s, t!.name, r) });
    }
  }

  // ---------------------------------------------------------------- Activity ledger (Outreach update Nov8)
  {
    const s = inp.index; const t = tab(s, "Outreach update Nov8");
    for (const r of t?.rows ?? []) {
      const channel = CHANNEL_BY_LABEL[lower(v(r, "channel"))]; if (!channel) continue;
      const src = ref(s, t!.name, r);
      if (/impact\.com/i.test(`${v(r, "party_key")} ${v(r, "company")}`)) {
        plan.exceptions.push({ kind: "excluded_impact", severity: "info", title: v(r, "company"), detail: "impact.com is excluded from this app by design; not imported.", source: src });
        continue;
      }
      const partyKey = v(r, "party_key"); const company = v(r, "company") || partyKey;
      const email = emails(v(r, "email"))[0] ?? null;
      const status = v(r, "current_status"); const replyClass = v(r, "reply_class"); const method = v(r, "method");
      const label = v(r, "platform_label");
      const platformLabel = label && !/^(no reply|bounced)/i.test(label) && label !== "Auto reply only" ? label : null;
      const humanReply = v(r, "human_reply") === "1" || v(r, "human_reply") === "1.0";
      const positive = /^1(\.0)?$/.test(v(r, "Positive count flag"));

      // Match to an inventory opportunity in this channel.
      let oppKey: string | undefined; let matchedBy = "";
      const contactKey = email ? emailOwner.get(email) : undefined;
      if (contactKey) {
        const orgKey = plan.contacts.get(contactKey)!.orgKey;
        oppKey = channelOrgOpp.get(`${channel}|${orgKey}`); if (oppKey) matchedBy = "email";
      }
      if (!oppKey && email) {
        const d = emailDomain(email); const orgKey = d ? domainOrg.get(d) : undefined;
        if (orgKey) { oppKey = channelOrgOpp.get(`${channel}|${orgKey}`); if (oppKey) matchedBy = "email domain = website domain"; }
      }
      if (!oppKey && channel === "listings") {
        const id = /^listing:(\d+)/.exec(partyKey)?.[1]; if (id && listingIdOpp.has(id)) { oppKey = listingIdOpp.get(id); matchedBy = "listing partner_id"; }
      }
      if (!oppKey && nameOpp.has(`${channel}|${lower(company)}`)) {
        oppKey = nameOpp.get(`${channel}|${lower(company)}`); matchedBy = "identical name in the same channel";
      }
      if (!oppKey) {
        // Not in the channel inventory: create it from the ledger so the activity is not lost, and report it.
        const d = email ? emailDomain(email) : null;
        const orgKey = (d && domainOrg.get(d)) || upsertOrg({ name: company, website: null, domain: d, parentKey: null, location: null, country: null, notes: null }, src, `ledger:${slug(partyKey)}`);
        const ck = upsertContact(orgKey, v(r, "person") || null, null, email ? [{ kind: "email", value: email, normalized: email, verified: false, verificationSource: null }] : [], src, company);
        oppKey = upsertOpp(channel, orgKey, ck, src, { ledger_party_key: partyKey });
        matchedBy = "created from ledger";
        plan.exceptions.push({ kind: "ledger_party_not_in_inventory", severity: "review", title: `${company} (${v(r, "channel")})`,
          detail: `Outreach ledger party ${partyKey} has no matching row in the channel tab; created from the ledger.`, source: src });
      }
      const opp = plan.opps.get(oppKey)!;
      opp.matchedBy.push(matchedBy); opp.sources.push(src);
      if (matchedBy.startsWith("identical name")) {
        plan.exceptions.push({ kind: "name_link", severity: "info", title: company, detail: "Outreach record linked to the prospect with the identical name in the same channel (no email to confirm).", source: src });
      }

      // Contact for messages
      let msgContact = email ? emailOwner.get(email) ?? null : null;
      if (email && !msgContact) msgContact = upsertContact(opp.orgKey, v(r, "person") || null, null, [{ kind: "email", value: email, normalized: email, verified: false, verificationSource: null }], src, company);
      if (msgContact && humanReply) {
        // A human reply from this address proves the identity.
        const id = plan.contacts.get(msgContact)!.identities.find((i) => i.kind === "email" && i.normalized === email);
        if (id && !id.verified) Object.assign(id, { verified: true, verificationSource: "human reply recorded in outreach ledger" });
      }
      opp.primaryContactKey ??= msgContact;

      // Contact is established by a recorded send, not by status text (which can be stale).
      const firstRaw = v(r, "first_outreach");
      const counted = /^1/.test(v(r, "counted_contact"));
      const vendor = lower(v(r, "party_type")).startsWith("platform/vendor infrastructure");
      const notContacted = vendor || !counted;
      if (!notContacted && /^not contacted/i.test(status) && firstRaw) {
        plan.exceptions.push({ kind: "status_conflict", severity: "review", title: `${company} (${v(r, "channel")})`,
          detail: `Status says "${status}" but a ${method} send is recorded on ${firstRaw}. Imported as contacted (the recorded send is the evidence).`, source: src });
      }
      const bounced = /bounce/i.test(replyClass) || /^bounced/i.test(status);
      const automaticOnly = !humanReply && /(automatic|auto[- ]reply|out-of-office|routing)/i.test(`${replyClass} ${status}`) && !/submission|launch|approval|eligibility|payment/i.test(replyClass);
      const ledger: LedgerRow = { channel, partyKey, company, email, oppKey, matchedBy, counted,
        humanReply: humanReply && !notContacted, positive: positive && !notContacted, replyClass, platformLabel, method, currentStatus: status, bounced, automaticOnly, contacted: !notContacted };
      plan.ledgerRows.push(ledger);
      if (notContacted) continue;

      const provider = /instantly/i.test(method) ? "instantly" : /linkedin/i.test(method) && !/email/i.test(method) ? "linkedin"
        : /facebook/i.test(method) ? "facebook" : /form|submission|listing/i.test(method) ? "contact_form" : "gmail";
      const mo = channel === "media_pr" ? mediaOutreach.get(lower(company)) : undefined;
      const gmailId = mo ? norm(mo.row.values["Gmail thread/message id"]) : "";
      const first = parseTime(v(r, "first_outreach"));
      const sentKey = `event:ledger:${partyKey}:sent`;
      plan.events.push({
        key: sentKey, oppKey, eventType: channel === "listings" && provider === "contact_form" ? "listing.submitted" : "message.sent", time: first,
        summary: `${method || "Outreach"} — ${status}`, source: src,
        message: { provider, providerMessageId: provider === "gmail" && /^[0-9a-f]{12,}$/i.test(gmailId) ? gmailId : null, threadId: null,
          direction: "outbound", status: bounced ? "bounced" : "sent", isAutomatic: null, from: null, to: email ? [email] : [],
          subject: mo ? norm(mo.row.values["Final subject"] ?? mo.row.values["Subject"]) || null : null,
          body: mo ? norm(mo.row.values["Body (plain text)"]) || null : null },
        assessments: [],
      });
      const last = parseTime(v(r, "last_outreach"));
      if (last.at && first.at && last.at !== first.at && !bounced) {
        plan.events.push({ key: `event:ledger:${partyKey}:followup`, oppKey, eventType: "message.sent", time: last, summary: "Follow-up", source: src,
          message: { provider, providerMessageId: null, threadId: null, direction: "outbound", status: "sent", isAutomatic: null, from: null, to: email ? [email] : [], subject: null, body: null },
          assessments: [] });
      }
      let evidenceKey = sentKey;
      const reply = parseTime(v(r, "reply_date"));
      const hasReply = humanReply || automaticOnly || !!platformLabel || (!!reply.at && !bounced);
      if (hasReply) {
        const replyKey = `event:ledger:${partyKey}:reply`;
        plan.events.push({
          key: replyKey, oppKey, eventType: "message.received", time: reply, summary: `${replyClass}${v(r, "reply_summary") ? ` — ${v(r, "reply_summary")}` : ""}`, source: src,
          message: { provider, providerMessageId: null, threadId: null, direction: "inbound", status: "received",
            isAutomatic: humanReply ? false : automaticOnly ? true : null, from: email, to: [], subject: null, body: null },
          assessments: [
            { source: "human", classification: classify(replyClass, status, positive), platformLabel: null, isHumanReply: humanReply ? true : automaticOnly ? false : null,
              conditions: /paid|sponsor/i.test(`${status} ${replyClass}`) && positive ? "paid / sponsored only" : null },
            ...(platformLabel ? [{ source: "platform" as const, classification: null, platformLabel, isHumanReply: null, conditions: null }] : []),
          ],
        });
        if (humanReply) evidenceKey = replyKey;
      }

      // Stage and disposition from evidence
      const stage = deriveStage(channel, { humanReply, positive, replyClass, status });
      setStage(opp, stage, stage === "contacted" ? sentKey : evidenceKey);
      const disp = deriveDisposition({ bounced, automaticOnly, humanReply, replyClass, status });
      if (disp) opp.disposition = disp;
      const milestone = deriveMilestone(channel, status);
      if (milestone) opp.milestone = milestone;
      if (v(r, "next_step")) opp.nextAction = v(r, "next_step").slice(0, 500);

      // Commercial proposals mentioned in the ledger (never approved spend)
      const money = /\$\s?([\d,.]+)\s?(k\b)?/i.exec(`${replyClass} ${status} ${method}`);
      if (/proposal|IO received|paid placement/i.test(`${replyClass} ${status} ${method}`)) {
        const amount = money ? Number(money[1].replace(/,/g, "")) * (money[2] ? 1000 : 1) : null;
        plan.offers.push({ key: `offer:ledger:${partyKey}`, oppKey, kind: channel === "listings" ? "paid_listing" : "paid_placement",
          terms: `${replyClass} — ${status}`, amount, currency: amount ? "USD" : null, isPaid: true,
          status: /LIVE paid placement/i.test(status) ? "accepted" : "proposed", ioSigned: false, source: src });
      }
    }
  }

  // ---------------------------------------------------------------- Media & PR Q4 test plan offers
  {
    const s = inp.mediaPr; const t = tab(s, "Q4 Test Plan");
    for (const r of t?.rows ?? []) {
      const partner = v(r, "Partner"); if (!partner || /^(total|reserve)/i.test(partner)) continue;
      const oppKey = nameOpp.get(`media_pr|${lower(partner)}`);
      const src = ref(s, t!.name, r);
      if (!oppKey) { plan.exceptions.push({ kind: "offer_unmatched", severity: "review", title: `Q4 Test Plan: ${partner}`, detail: "No Media & PR prospect with this exact name; offer not linked.", source: src }); continue; }
      const lean = Number(v(r, "Lean $10K"));
      plan.offers.push({ key: `offer:q4:${slug(partner)}`, oppKey, kind: "paid_placement",
        terms: `Q4 test plan — ${v(r, "Confirmed price?")} — status: ${v(r, "Status (Nov 3)")}`, amount: Number.isFinite(lean) && lean > 0 ? lean : null,
        currency: Number.isFinite(lean) && lean > 0 ? "USD" : null, isPaid: true, status: "proposed", ioSigned: false, source: src });
    }
  }

  // ---------------------------------------------------------------- Cross-check: tab says contacted, ledger doesn't
  {
    const contactedInLedger = new Set(plan.ledgerRows.filter((l) => l.contacted).map((l) => l.oppKey));
    for (const opp of plan.opps.values()) {
      const a = opp.attributes;
      const says = [a.sheet_status, a.email_status, a.linkedin_status, a.overall_status].filter(Boolean).join(" | ");
      const tabContacted = /^(contacted|replied|bounced|sent|submitted|approved|launched|updated|messaged)/i.test(a.sheet_status ?? "")
        || /^(sent|bounced|messaged)/i.test(a.email_status ?? "") || /^(sent|messaged)/i.test(a.linkedin_status ?? "");
      const org = plan.orgs.get(opp.orgKey);
      const hqCovered = !!org?.parentKey && contactedInLedger.has(`opp:${opp.channel}:${org.parentKey}`);
      const sharedContactCovered = !!opp.primaryContactKey && plan.ledgerRows.some((l) => l.contacted && l.email
        && plan.contacts.get(opp.primaryContactKey!)?.identities.some((i) => i.normalized === l.email));
      if (tabContacted && !contactedInLedger.has(opp.key) && !hqCovered && !sharedContactCovered) {
        plan.exceptions.push({ kind: "tab_contacted_not_in_ledger", severity: "review", title: plan.orgs.get(opp.orgKey)?.name ?? opp.key,
          detail: `Channel tab says "${says}" but the Nov 8 outreach ledger has no send for it. Kept as not contacted until verified.`, source: opp.sources[0] });
      }
      if (/request sent|pending/i.test(a.linkedin_status ?? "") && !opp.stage) {
        plan.exceptions.push({ kind: "connection_only", severity: "info", title: plan.orgs.get(opp.orgKey)?.name ?? opp.key,
          detail: `LinkedIn "${a.linkedin_status}" is a connection request only; not counted as contact.`, source: opp.sources[0] });
      }
    }
  }

  // ---------------------------------------------------------------- Outreach totals (for reconciliation)
  {
    const t = tab(inp.index, "Outreach totals Nov8");
    for (const r of t?.rows ?? []) plan.totalsTab[v(r, "Channel")] = r.values;
  }

  // ---------------------------------------------------------------- Historical "sent" markers in Source history
  for (const s of [inp.affiliates, inp.coMarketing, inp.mediaPr, inp.listings]) {
    const t = tab(s, "Source history");
    for (const r of t?.rows ?? []) {
      if (!/^legacy/i.test(v(r, "Evidence / source status"))) continue;
      const vals = v(r, "Original headers + values JSON");
      // A field named like status/sent whose value says it was actually sent (not "not contacted"/"not started").
      let parsed: Record<string, string> = {};
      try { parsed = JSON.parse(vals); } catch { /* keep empty */ }
      const sentField = Object.entries(parsed).some(([k, val]) => /status|sent|outreach/i.test(k) && typeof val === "string"
        && /\b(sent|contacted|submitted|messaged|emailed)\b/i.test(val) && !/\b(not|never|no)\s+(yet\s+)?(contacted|sent|started|submitted|messaged)\b|^not\b|draft|queued|to send/i.test(val));
      if (!sentField) continue;
      const src = ref(s, t!.name, r);
      const em = emails(vals);
      const urls = vals.match(/https?:\/\/[^\s"',;]+/gi) ?? [];
      const domains = [...new Set([...em.map(emailDomain), ...urls.map(domainOf)].filter((d): d is string => !!d && !/docs\.google/.test(d)))];
      const contactedOrgs = new Set(plan.ledgerRows.filter((l) => l.contacted).map((l) => plan.opps.get(l.oppKey)?.orgKey));
      const covered = em.some((e) => plan.ledgerRows.some((l) => l.contacted && l.email === e))
        || domains.some((d) => { const o = domainOrg.get(d); return !!o && contactedOrgs.has(o); });
      const origin = `${v(r, "Source file")} › ${v(r, "Source tab")} row ${v(r, "Original row")}`;
      if (/impact\.com/i.test(vals) && !em.length && domains.every((d) => d === "impact.com")) continue;   // excluded by design
      if (covered) { plan.historyMarkers.covered++; continue; }
      if (em.length || domains.length) plan.historyMarkers.identifiedUncovered.push({ kind: "history_sent_identified", severity: "review", title: [...em, ...domains.filter((d) => !em.some((e) => e.endsWith(`@${d}`)))].join(", "),
        detail: `Older source marks this as sent/contacted (${origin}) but the Nov 8 ledger has no send. Review before recording.`, source: src });
      else plan.historyMarkers.unidentified.push({ kind: "history_sent_unidentified", severity: "held", title: origin,
        detail: "Older source marks something as sent/contacted with no identifiable recipient. Held — no recipient invented.", source: src });
    }
  }

  // One exception per kind + title (e.g. a chain HQ email repeated on many venue rows).
  const seen = new Map<string, PlanException>();
  for (const e of plan.exceptions) {
    const k = `${e.kind}|${e.title}`;
    const prev = seen.get(k);
    if (prev) prev.detail = prev.detail.replace(/ \(×(\d+)\)$/, (_, n) => ` (×${Number(n) + 1})`).replace(/([^)])$/, "$1 (×2)");
    else seen.set(k, { ...e });
  }
  plan.exceptions = [...seen.values()];
  return plan;
}

function setStage(opp: PlanOpp, stage: Stage, evidenceKey: string) {
  const order: Stage[] = ["contacted", "replied", "interested", "discussion_proposal", "agreed", "live"];
  if (!opp.stage || order.indexOf(stage) > order.indexOf(opp.stage)) { opp.stage = stage; opp.stageEvidenceKey = evidenceKey; }
}

function classify(replyClass: string, status: string, positive: boolean): string {
  const t = `${replyClass} ${status}`;
  if (/negative|declined|not interested/i.test(t)) return "negative";
  if (/paid|sponsor/i.test(t) && positive) return "paid_only";
  if (positive) return "positive";
  if (/automatic|auto|out-of-office|routing/i.test(t)) return "automatic";
  if (/proposal|IO|pricing|commercial/i.test(t)) return "commercial";
  return "unclear";
}

function deriveStage(channel: Channel, x: { humanReply: boolean; positive: boolean; replyClass: string; status: string }): Stage {
  const t = `${x.replyClass} ${x.status}`;
  if (/LIVE paid placement|approved - live|launched - live/i.test(t)) return "live";
  if (/IO received|proposal received|pricing received|commercial reply \/ discussion|proposal/i.test(t) && x.humanReply) return "discussion_proposal";
  if (x.humanReply && x.positive) return "interested";
  if (x.humanReply) return "replied";
  return "contacted";
}

function deriveDisposition(x: { bounced: boolean; automaticOnly: boolean; humanReply: boolean; replyClass: string; status: string }): Disposition | null {
  const t = `${x.replyClass} ${x.status}`;
  if (x.bounced) return "bounced";
  if (/negative|declined|not interested|rejected/i.test(t)) return "declined";
  if (/dropped|on hold/i.test(t)) return "on_hold";
  if (x.automaticOnly) return "automatic_only";
  if (/submitted - live \(not in directory\)/i.test(t)) return "needs_verification";
  return null;
}

function deriveMilestone(channel: Channel, status: string): string | null {
  if (channel !== "listings") return /LIVE paid placement/i.test(status) ? (channel === "media_pr" ? "placement_live" : null) : null;
  if (/launched - live|approved - live|LIVE paid placement/i.test(status)) return "publicly_live";
  if (/launch scheduled/i.test(status)) return "approved_scheduled";
  if (/pending review/i.test(status)) return "pending_review";
  if (/submitted|edit submitted/i.test(status)) return "submitted";
  return null;
}

function applyListingStatus(opp: PlanOpp, status: string, src: SourceRef) {
  if (/badge required/i.test(status)) opp.disposition = "blocked";
  else if (/^skipped|^on hold/i.test(status)) opp.disposition = "on_hold";
  else if (/^blocked|submit failed/i.test(status)) opp.disposition = "blocked";
  else if (/^rejected/i.test(status)) opp.disposition = "declined";
  void src;
}
