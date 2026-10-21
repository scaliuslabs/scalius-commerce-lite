// @vitest-environment node
import { describe, expect, it } from "vitest";
import { storefrontCopy } from "./storefront-copy";

describe("chrome copy", () => {
  it("puts what each phrase was given into it, in both languages", () => {
    for (const language of ["en", "bn"] as const) {
      const { header, nav, footer } = storefrontCopy(language).chrome;
      expect(header.call("+8801711000000")).toContain("+8801711000000");
      expect(nav.allOf("Shoes")).toContain("Shoes");
      expect(nav.showAll("Shoes")).toContain("Shoes");
      expect(nav.featuredIn("Shoes")).toContain("Shoes");
      expect(footer.aboutStore("Nila")).toContain("Nila");
      expect(footer.call("017")).toContain("017");
      expect(footer.showMoreLinks("7", "Care")).toContain("7");
      expect(footer.showMoreLinks("7", "Care")).toContain("Care");
      expect(footer.hideExtraLinks("Care")).toContain("Care");
      expect(footer.rights("2026", "Nila")).toContain("2026");
      expect(footer.rights("2026", "Nila")).toContain("Nila");
      expect(footer.rightsNoName("2026")).toContain("2026");
    }
  });

  it("keeps the Bangla chrome in Bengali script", () => {
    const bn = storefrontCopy("bn").chrome;
    const text = JSON.stringify(bn, (_key, value) => (typeof value === "function" ? value(7, "X") : value));
    const stripped = text.replace(/"[^"]*":/g, "").replace(/[X\d©"{}[\],: .ঀ-৿–—।-]/g, "");
    expect(stripped).toBe("");
  });
});
