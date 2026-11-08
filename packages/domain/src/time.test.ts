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
