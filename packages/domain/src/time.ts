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
