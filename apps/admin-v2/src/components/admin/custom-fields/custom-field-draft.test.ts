import { describe, expect, it } from "vitest";
import { checkDraft, draftFromValue, localDateTime, sameDraft, valueFromDraft } from "./custom-field-draft";

const BDT = { decimalPlaces: 2, currencyCode: "BDT", priceIncrementMinor: 100 } as const;
const none = { min: null, max: null, regex: null, choices: null };

describe("custom field drafts", () => {
  it("turns API values into drafts and back", () => {
    expect(draftFromValue("integer", 12)).toBe("12");
    expect(draftFromValue("boolean", false)).toBe("false");
    expect(draftFromValue("json", { a: 1 })).toBe('{\n  "a": 1\n}');
    expect(draftFromValue("list.decimal", ["1.5", "2"])).toEqual(["1.5", "2"]);
    expect(draftFromValue("list.url", null)).toEqual([]);
    expect(valueFromDraft("boolean", "true")).toEqual({ value: true });
    expect(valueFromDraft("boolean", "")).toEqual({ value: null });
    expect(valueFromDraft("json", '{"a":1}')).toEqual({ value: { a: 1 } });
    expect(valueFromDraft("json", "{")).toBeNull();
    // Blank list items never save; an all-blank list clears.
    expect(valueFromDraft("list.single_line_text", ["S", " ", "M"])).toEqual({ value: ["S", "M"] });
    expect(valueFromDraft("list.single_line_text", ["", ""])).toEqual({ value: null });
  });

  it("round-trips a date-time through the browser's local time", () => {
    const local = localDateTime("2026-10-02T04:00:00Z");
    expect(valueFromDraft("date_time", local)).toEqual({ value: "2026-10-02T04:00:00.000Z" });
  });

  it("treats drafts that save the same thing as equal", () => {
    expect(sameDraft(" Cotton ", "Cotton")).toBe(true);
    expect(sameDraft(["S", ""], ["S"])).toBe(true);
    expect(sameDraft(["S"], ["M"])).toBe(false);
  });

  it("checks drafts with the shared codec, numbering list items as shown", () => {
    expect(checkDraft({ type: "money", validations: none }, "120", BDT)).toBeNull();
    expect(checkDraft({ type: "money", validations: none }, "12.5", BDT)).toEqual({ issue: { code: "whole_amount", limit: undefined } });
    expect(checkDraft({ type: "single_line_text", validations: { ...none, max: 3 } }, "abcd", BDT))
      .toEqual({ issue: { code: "too_long", limit: 3 } });
    expect(checkDraft({ type: "list.integer", validations: none }, ["1", "", "x"], BDT))
      .toEqual({ issue: { code: "invalid", limit: undefined, index: 2 } });
    expect(checkDraft({ type: "json", validations: none }, "{", BDT)).toEqual({ issue: { code: "invalid" } });
    expect(checkDraft({ type: "color", validations: none }, "", BDT)).toBeNull();
  });
});
