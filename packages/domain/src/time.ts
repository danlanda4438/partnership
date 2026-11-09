export const DISPLAY_TIMEZONE = "Asia/Jerusalem";

export type TimestampPrecision = "exact" | "minute" | "day" | "month" | "year" | "unknown";

/**
 * Formats a stored UTC timestamp for display in Asia/Jerusalem, never showing more
 * precision than the source actually had. Undated records render as "Date unknown".
 */
export function formatEvidenceTime(
  iso: string | null,
  precision: TimestampPrecision = "exact",
  timeZone: string = DISPLAY_TIMEZONE,
): string {
  if (!iso || precision === "unknown") return "Date unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Date unknown";
  const base: Intl.DateTimeFormatOptions = { timeZone };
  const opts: Intl.DateTimeFormatOptions =
    precision === "year" ? { ...base, year: "numeric" }
    : precision === "month" ? { ...base, year: "numeric", month: "short" }
    : precision === "day" ? { ...base, year: "numeric", month: "short", day: "numeric" }
    : { ...base, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return new Intl.DateTimeFormat("en-GB", opts).format(date);
}

/** Offset in minutes of `timeZone` from UTC at the given instant (e.g. +120 for Jerusalem in winter). */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Converts a wall-clock date (YYYY-MM-DD) and optional time (HH:MM) in `timeZone` to a UTC ISO string.
 * Returns null for empty or invalid input.
 */
export function zonedLocalToUtc(date: string, time = "", timeZone: string = DISPLAY_TIMEZONE): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!d) return null;
  const t = /^(\d{2}):(\d{2})$/.exec(time.trim());
  const naive = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), t ? Number(t[1]) : 0, t ? Number(t[2]) : 0);
  if (Number.isNaN(naive)) return null;
  // Two passes handle instants near a DST change.
  let utc = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60000;
  utc = naive - zoneOffsetMinutes(new Date(utc), timeZone) * 60000;
  return new Date(utc).toISOString();
}

/** Short relative description such as "in 2 days", "3 h ago", "overdue by 1 day". */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? [Math.max(1, Math.round(abs / 60_000)), "min"]
    : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "h"]
    : [Math.round(abs / 86_400_000), "day"];
  const label = `${unit[0]} ${unit[1]}${unit[1] === "day" && unit[0] !== 1 ? "s" : ""}`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}
