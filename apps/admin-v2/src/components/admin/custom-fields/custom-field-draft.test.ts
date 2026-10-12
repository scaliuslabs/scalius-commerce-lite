import { afterEach, describe, expect, it, vi } from "vitest";
import { checkDraft, draftFromValue, localDateTime, sameDraft, valueFromDraft } from "./custom-field-draft";

const BDT = { decimalPlaces: 2, currencyCode: "BDT", priceIncrementMinor: 100 } as const;
const none = { min: null, max: null, regex: null, choices: null };

describe("custom field drafts", () => {
  afterEach(() => vi.unstubAllEnvs());
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

  it.each([
    ["UTC", "2026-10-02T04:05:06"],
    ["Asia/Dhaka", "2026-10-02T10:05:06"],
    ["America/New_York", "2026-10-02T00:05:06"],
  ])("keeps seconds and the browser-local ISO conversion in %s", (zone, expected) => {
    vi.stubEnv("TZ", zone);
    const iso = "2026-10-02T04:05:06Z";
    expect(draftFromValue("date_time", iso)).toBe(expected);
    expect(valueFromDraft("date_time", expected)).toEqual({ value: "2026-10-02T04:05:06.000Z" });
    expect(draftFromValue("list.date_time", [iso])).toEqual([expected]);
    expect(valueFromDraft("list.date_time", ["", expected])).toEqual({ value: ["2026-10-02T04:05:06.000Z"] });
  });

  it.each(["2026-10-02", "2026-10-02T", "T04:05", "2026-02-30T04:05", "2026-10-02T24:00", "2026-10-02T04:60", "2026-10-02T04:05:60", "not a date"])("rejects an incomplete or invalid date/time draft: %s", (draft) => {
    expect(valueFromDraft("date_time", draft)).toBeNull();
    expect(checkDraft({ type: "date_time", validations: none }, draft, BDT)?.issue.code).toBe("invalid");
    expect(checkDraft({ type: "list.date_time", validations: none }, ["", draft], BDT)?.issue.code).toBe("invalid");
  });

  it("keeps clear, minute-only and existing browser DST behavior", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(valueFromDraft("date_time", "")).toEqual({ value: null });
    expect(valueFromDraft("list.date_time", ["", ""])).toEqual({ value: null });
    expect(valueFromDraft("date_time", "2026-10-02T04:05")).toEqual({ value: "2026-10-02T08:05:00.000Z" });
    // This presentation change retains Date's existing gap/fold policy.
    expect(valueFromDraft("date_time", "2026-03-08T02:30:07")).toEqual({ value: "2026-03-08T07:30:07.000Z" });
    expect(valueFromDraft("date_time", "2026-11-01T01:30:07")).toEqual({ value: "2026-11-01T05:30:07.000Z" });
  });

});
