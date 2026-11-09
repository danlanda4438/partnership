import { describe, expect, it } from "vitest";
import { formatEvidenceTime } from "./time";

describe("formatEvidenceTime", () => {
  it("shows Jerusalem local time for exact timestamps", () => {
    // 2026-01-15 10:00 UTC = 12:00 in Jerusalem (UTC+2 in winter)
    expect(formatEvidenceTime("2026-01-15T10:00:00Z")).toBe("15 Jan 2026, 12:00");
  });
  it("never invents precision the source did not have", () => {
    expect(formatEvidenceTime("2026-01-15T00:00:00Z", "day")).toBe("15 Jan 2026");
    expect(formatEvidenceTime("2026-01-15T00:00:00Z", "month")).toBe("Jan 2026");
    expect(formatEvidenceTime(null)).toBe("Date unknown");
    expect(formatEvidenceTime("2026-01-15T00:00:00Z", "unknown")).toBe("Date unknown");
  });
});

import { relativeTime, zonedLocalToUtc } from "./time";

describe("zonedLocalToUtc", () => {
  it("converts Jerusalem wall-clock time to UTC in winter and summer", () => {
    expect(zonedLocalToUtc("2026-01-15", "09:00")).toBe("2026-01-15T07:00:00.000Z");
    expect(zonedLocalToUtc("2026-07-15", "09:00")).toBe("2026-07-15T06:00:00.000Z");
  });
  it("rejects invalid input", () => {
    expect(zonedLocalToUtc("")).toBeNull();
    expect(zonedLocalToUtc("15/01/2026")).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  it("describes past and future", () => {
    expect(relativeTime("2026-11-11T12:00:00Z", now)).toBe("in 2 days");
    expect(relativeTime("2026-11-09T09:00:00Z", now)).toBe("3 h ago");
  });
});
