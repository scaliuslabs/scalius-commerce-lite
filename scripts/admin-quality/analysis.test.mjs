import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  classifyClip,
  compileLanguageAllowlist,
  controlHeightFindings,
  englishWords,
  fieldAlignmentFindings,
  findEnglishInBn,
  findLeaks,
  skeletonShapeFinding,
} from "./analysis.mjs";
import { RULES, isGating } from "./rules.mjs";

const allow = compileLanguageAllowlist(JSON.parse(readFileSync(fileURLToPath(new URL("./language-allowlist.json", import.meta.url)), "utf8")));

describe("clipped text", () => {
  const base = { sw: 100, cw: 100, sh: 20, ch: 20, overflowX: "hidden", overflowY: "visible", textOverflow: "clip", lineClamp: 0, hasFullValue: false, srOnly: false };
  it("passes text that fits", () => {
    expect(classifyClip(base)).toBeNull();
  });
  it("flags hard-cut text", () => {
    expect(classifyClip({ ...base, sw: 180 })).toEqual({ rule: "clipped-text" });
  });
  it("flags an ellipsis with no full value, and passes one with a title", () => {
    expect(classifyClip({ ...base, sw: 180, textOverflow: "ellipsis" })).toEqual({ rule: "truncated-no-title" });
    expect(classifyClip({ ...base, sw: 180, textOverflow: "ellipsis", hasFullValue: true })).toBeNull();
  });
  it("treats a line clamp as intended truncation", () => {
    expect(classifyClip({ ...base, overflowX: "visible", overflowY: "hidden", sh: 60, lineClamp: 2 })).toEqual({ rule: "truncated-no-title" });
  });
  it("ignores scroll containers, sub-pixel differences and screen-reader text", () => {
    expect(classifyClip({ ...base, sw: 300, overflowX: "auto" })).toBeNull();
    expect(classifyClip({ ...base, sw: 101 })).toBeNull();
    expect(classifyClip({ ...base, sw: 300, srOnly: true })).toBeNull();
  });
});

describe("control heights", () => {
  const field = (id, h, extra = {}) => ({ id, kind: "input", section: 1, x: 0, y: 0, w: 200, h, iconOnly: false, ...extra });
  it("passes fields of one height", () => {
    expect(controlHeightFindings([field("a", 36), field("b", 36, { y: 60 })])).toEqual([]);
  });
  it("accepts a 1 px difference and flags 2 px", () => {
    expect(controlHeightFindings([field("a", 36), field("b", 36.9, { y: 60 })])).toEqual([]);
    const found = controlHeightFindings([field("a", 36), field("b", 40, { y: 60, kind: "combobox" })]);
    expect(found).toHaveLength(1);
    expect(found[0].scope).toBe("section");
    expect(found[0].nodes[0]).toMatch(/^a \(36px\)/);
  });
  it("flags a field and a text button of different heights in one row", () => {
    const found = controlHeightFindings([field("input", 36), { id: "button", kind: "button", section: 1, x: 220, y: -4, w: 90, h: 44, iconOnly: false }]);
    expect(found.some((item) => item.scope === "row")).toBe(true);
  });
  it("lets icon-only buttons differ and keeps sections apart", () => {
    expect(controlHeightFindings([field("a", 36), { id: "icon", kind: "button", section: 1, x: 220, y: 0, w: 28, h: 28, iconOnly: true }])).toEqual([]);
    expect(controlHeightFindings([field("a", 36), field("b", 44, { section: 2, y: 80 })])).toEqual([]);
  });
});

describe("field alignment", () => {
  const field = (id, x, y) => ({ id, section: 1, x, y, w: 300, h: 36 });
  it("passes fields in one column that start together", () => {
    expect(fieldAlignmentFindings([field("a", 24, 0), field("b", 24, 60), field("c", 24.5, 120)])).toEqual([]);
  });
  it("flags stacked fields that start 2 px apart", () => {
    const found = fieldAlignmentFindings([field("a", 24, 0), field("b", 26, 60)]);
    expect(found).toHaveLength(1);
    expect(found[0].nodes).toEqual(["b (left 26.0px)"]);
  });
  it("leaves side-by-side columns alone", () => {
    expect(fieldAlignmentFindings([field("a", 24, 0), field("b", 340, 0), field("c", 24, 60), field("d", 340, 60)])).toEqual([]);
    // Two fields on one row 10px apart are neighbours, not a misaligned column.
    expect(fieldAlignmentFindings([field("a", 24, 0), field("b", 34, 0)])).toEqual([]);
  });
});

describe("leaked values", () => {
  const leak = (text, extra = {}) => findLeaks([{ text, sel: "p", ...extra }]).map((item) => item.kind);
  it("finds raw keys, ICU, undefined, NaN, object and invalid dates", () => {
    expect(leak("orders.list.emptyTitle")).toEqual(["i18n-key"]);
    expect(leak("{count, plural, one {# item} other {# items}}")).toEqual(["icu"]);
    expect(leak("Total: ৳NaN")).toEqual(["nan"]);
    expect(leak("undefined items")).toEqual(["undefined"]);
    expect(leak("[object Object]")).toEqual(["object"]);
    expect(leak("Invalid Date")).toEqual(["invalid-date"]);
    expect(leak("Hello {name}")).toEqual(["placeholder"]);
  });
  it("leaves ordinary copy, files, domains and numbers", () => {
    for (const text of ["Orders", "image.png", "www.example.com", "v1.2.3", "Save changes.", "1.5 kg", "e.g. yourshop.com", "Undefined behaviour is fine in prose? no: Undefined"]) {
      expect(leak(text), text).not.toContain("i18n-key");
    }
    expect(leak("Hello there")).toEqual([]);
  });
  it("ignores code text except ICU and objects", () => {
    expect(leak("{{ product.title }}", { code: true })).toEqual([]);
    expect(leak("{count, plural, one {x}}", { code: true })).toEqual(["icu"]);
  });
});

describe("wrong language", () => {
  const found = (text, extra = {}) => findEnglishInBn([{ text, sel: "p", ...extra }], allow).length;
  it("flags English sentences and words in Bangla copy", () => {
    expect(found("Save changes")).toBe(1);
    expect(found("আপনার order সফল হয়েছে")).toBe(1);
    expect(found("Something went wrong")).toBe(1);
  });
  it("accepts Bangla, numbers, brands and technical terms", () => {
    expect(found("পরিবর্তন সংরক্ষণ করুন")).toBe(0);
    expect(found("৳১,২৩৫.০০")).toBe(0);
    expect(found("bKash, Pathao এবং Shopify")).toBe(0);
    expect(found("SKU")).toBe(0);
    expect(found("গুগল API কী")).toBe(0);
    expect(found("Local Admin")).toBe(0);
  });
  it("ignores emails, links, identifiers and data cells", () => {
    expect(found("admin@local.scalius.test")).toBe(0);
    expect(found("https://shop.example.com/products")).toBe(0);
    expect(found("ORD-1092 কপি")).toBe(0);
    expect(found("Cotton panjabi", { data: true })).toBe(0);
    expect(found("Hello World", { code: true })).toBe(0);
  });
  it("lists the English words it found", () => {
    expect(englishWords("অর্ডার Shipping label", allow)).toEqual(["shipping", "label"]);
  });
});

describe("skeleton shape", () => {
  it("passes a skeleton close to the content", () => {
    expect(skeletonShapeFinding(900, 1000)).toBeNull();
    expect(skeletonShapeFinding(0, 1000)).toBeNull();
  });
  it("flags a large jump", () => {
    expect(skeletonShapeFinding(836, 1946)?.delta).toBe(1110);
  });
  it("ignores small absolute jumps", () => {
    expect(skeletonShapeFinding(100, 200)).toBeNull();
  });
});

describe("rules", () => {
  it("gates only the rules marked gating, and axe serious or critical", () => {
    expect(isGating({ rule: "overflow-page", source: "harness" })).toBe(true);
    expect(isGating({ rule: "clipped-text", source: "harness" })).toBe(false);
    expect(isGating({ rule: "button-name", source: "axe", impact: "critical" })).toBe(true);
    expect(isGating({ rule: "region", source: "axe", impact: "moderate" })).toBe(false);
  });
  it("lists every rule in the docs", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../docs/ADMIN-QUALITY.md", import.meta.url)), "utf8");
    for (const rule of Object.keys(RULES).filter((id) => id !== "axe")) expect(doc, `docs/ADMIN-QUALITY.md must list ${rule}`).toContain(`\`${rule}\``);
  });
});
