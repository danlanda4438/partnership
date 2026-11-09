import { zonedLocalToUtc } from "@gleeday/domain";

export type Precision = "exact" | "minute" | "day" | "month" | "year" | "unknown";

const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "me.com",
  "aol.com", "msn.com", "protonmail.com", "proton.me", "ymail.com", "comcast.net", "mail.com",
]);

// Hosting/social platforms: a URL on these identifies a profile, not the company that owns the domain.
const PLATFORM_DOMAINS = new Set([
  "youtube.com", "youtu.be", "instagram.com", "facebook.com", "fb.com", "tiktok.com", "pinterest.com", "linkedin.com",
  "twitter.com", "x.com", "threads.net", "etsy.com", "amazon.com", "linktr.ee", "linktree.com", "beacons.ai",
  "google.com", "docs.google.com", "sites.google.com", "goo.gl", "bit.ly", "wixsite.com", "wordpress.com", "blogspot.com",
  "substack.com", "beehiiv.com", "medium.com", "squarespace.com", "myshopify.com", "apps.apple.com", "apple.com",
  "play.google.com", "gigsalad.com", "thebash.com", "yelp.com", "reddit.com", "eventbrite.com", "canva.com", "notion.site",
]);

export const norm = (s: string | undefined | null) => (s ?? "").trim();
export const lower = (s: string | undefined | null) => norm(s).toLowerCase();

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export function emails(text: string | undefined | null): string[] {
  return [...new Set((norm(text).match(EMAIL_RE) ?? []).map((e) => e.toLowerCase().replace(/\.$/, "")))];
}

/** Website domain without www. Returns null for blanks, "not found" and shared mail domains. */
export function domainOf(urlOrDomain: string | undefined | null): string | null {
  let s = lower(urlOrDomain);
  if (!s || /^(not found|unknown|n\/a|none|-)/.test(s)) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#\s;,]/)[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  if (GENERIC_DOMAINS.has(s) || PLATFORM_DOMAINS.has(s)) return null;
  for (const p of PLATFORM_DOMAINS) if (s.endsWith(`.${p}`)) return null;   // e.g. name.wixsite.com, shop.etsy.com
  return s;
}

/** Like domainOf, but keeps a platform's own domain for the platform itself (GigSalad → gigsalad.com). */
export function orgDomain(website: string | undefined | null, name: string): string | null {
  const d = domainOf(website);
  if (d) return d;
  let raw = lower(website).replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#\s;,]/)[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) || GENERIC_DOMAINS.has(raw)) return null;
  const root = raw.split(".").slice(-2, -1)[0];
  return root && root.length >= 4 && lower(name).replace(/[^a-z0-9]/g, "").includes(root.replace(/-/g, "")) ? (raw = raw.split(".").slice(-2).join(".")) : null;
}

export function emailDomain(email: string): string | null {
  return domainOf(email.split("@")[1]);
}

export const isGenericDomain = (d: string) => GENERIC_DOMAINS.has(d);

export interface ParsedTime { at: string | null; precision: Precision; timezone: string | null; raw: string }

/**
 * Parses spreadsheet time text without inventing precision:
 *   "2026-11-05 22:37 Asia/Jerusalem" → exact minute, Jerusalem
 *   "2026-11-01 00:00:00" or "2026-11-01" → day (time-of-day not recorded)
 *   "2026-10-28 (LinkedIn displayed date)" → day
 *   anything else → unknown
 */
export function parseTime(raw: string | undefined | null): ParsedTime {
  const r = norm(raw);
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?\s+(Asia\/Jerusalem)\b/.exec(r);
  if (m) return { at: zonedLocalToUtc(m[1], `${m[2]}:${m[3]}`, m[4]), precision: "minute", timezone: m[4], raw: r };
  const iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(r);
  if (iso && !(iso[2] === "00" && iso[3] === "00")) return { at: new Date(r).toISOString(), precision: "minute", timezone: "UTC", raw: r };
  const d = /^(\d{4}-\d{2}-\d{2})(?=$|[^0-9])/.exec(r);
  if (d) return { at: zonedLocalToUtc(d[1], "12:00", "Asia/Jerusalem"), precision: "day", timezone: "Asia/Jerusalem", raw: r };
  return { at: null, precision: "unknown", timezone: null, raw: r };
}

export const slug = (s: string) => lower(s).normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
