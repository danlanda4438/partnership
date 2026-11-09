import { describe, expect, it } from "vitest";
import { domainOf, emails, parseTime } from "./util";

describe("identity helpers", () => {
  it("never treats shared mail or social/hosting platforms as a company domain", () => {
    expect(domainOf("https://www.catchmyparty.com/page")).toBe("catchmyparty.com");
    for (const u of ["gmail.com", "https://www.youtube.com/@creator", "instagram.com/x", "https://shop.etsy.com", "name.wixsite.com/site", "https://www.gigsalad.com/vendor"]) {
      expect(domainOf(u)).toBeNull();
    }
    expect(domainOf("not found")).toBeNull();
  });

  it("extracts and lowercases emails from messy cells", () => {
    expect(emails("kara@KarasPartyIdeas.com; amber@karaspartyideas.com.")).toEqual(["kara@karaspartyideas.com", "amber@karaspartyideas.com"]);
    expect(emails("Not found")).toEqual([]);
  });
});

describe("parseTime never invents precision", () => {
  it("exact Jerusalem minutes", () => {
    expect(parseTime("2026-11-05 22:37 Asia/Jerusalem")).toMatchObject({ at: "2026-11-05T20:37:00.000Z", precision: "minute", timezone: "Asia/Jerusalem" });
  });
  it("date-only values stay day precision", () => {
    expect(parseTime("2026-11-01 00:00:00").precision).toBe("day");
    expect(parseTime("2026-10-28 (LinkedIn displayed date)").precision).toBe("day");
  });
  it("unknown stays unknown", () => {
    expect(parseTime("Not recorded in source")).toEqual({ at: null, precision: "unknown", timezone: null, raw: "Not recorded in source" });
  });
});
