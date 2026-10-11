import { describe, expect, it } from "vitest";
import { sameFormValue } from "./form-values";

describe("form value equality", () => {
  it("ignores object key order inside ordered rows, but preserves row order", () => {
    const saved = [{ id: "a", enabled: true }, { id: "b", enabled: false }];
    expect(sameFormValue(saved, [{ enabled: true, id: "a" }, { enabled: false, id: "b" }])).toBe(true);
    expect(sameFormValue(saved, [...saved].reverse())).toBe(false);
  });

  it("does not normalize away meaningful empty, type or attachment changes", () => {
    expect(sameFormValue(0, -0)).toBe(true);
    expect(sameFormValue(NaN, NaN)).toBe(true);
    expect(sameFormValue(NaN, null)).toBe(false);
    expect(sameFormValue(null, undefined)).toBe(false);
    expect(sameFormValue("", null)).toBe(false);
    expect(sameFormValue(0, "0")).toBe(false);
    expect(sameFormValue({ optional: undefined }, {})).toBe(true);
    expect(sameFormValue(new Blob(["before"]), new Blob(["after"]))).toBe(false);
  });

  it("compares copied dates by their timestamp, without equating them to text", () => {
    const saved = new Date("2026-10-12T00:00:00Z");
    expect(sameFormValue(saved, new Date(saved))).toBe(true);
    expect(sameFormValue(saved, new Date(saved.getTime() + 1))).toBe(false);
    expect(sameFormValue(saved, saved.toISOString())).toBe(false);
  });
});
