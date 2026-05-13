import { describe, expect, it } from "vitest";
import {
  sanitizeCssForStyleElement,
  sanitizeCssForStyleElementWithReport,
} from "./css-sanitize";

describe("sanitizeCssForStyleElement", () => {
  it("recovers valid top-level rules when one generated rule is malformed", () => {
    const report = sanitizeCssForStyleElementWithReport(`
      .hero { color: red; }
      .broken[ { color: blue; }
      .card { display: grid; gap: 24px; }
    `);

    expect(report.recovered).toBe(true);
    expect(report.discardedBlockCount).toBe(1);
    expect(report.css).toContain(".hero");
    expect(report.css).toContain("color:red");
    expect(report.css).toContain(".card");
    expect(report.css).toContain("display:grid");
    expect(report.css).not.toContain(".broken");
  });

  it("keeps URL sanitization in recovered CSS", () => {
    const css = sanitizeCssForStyleElement(`
      .hero { background-image: url("javascript:alert(1)"); }
    `);

    expect(css).toContain("about:blank");
    expect(css).not.toMatch(/javascript/i);
  });
});
