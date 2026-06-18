import { describe, expect, it } from "vitest";
import { formatDateOnly, parseDateOnly } from "./date-only";

describe("date-only helpers", () => {
  it("serializes local calendar dates without timezone conversion", () => {
    expect(formatDateOnly(new Date(2026, 5, 19, 23, 59, 59))).toBe(
      "2026-06-19",
    );
  });

  it("parses valid date-only strings as local calendar dates", () => {
    const parsed = parseDateOnly("2026-06-19");

    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(5);
    expect(parsed?.getDate()).toBe(19);
  });

  it("rejects invalid or non-date-only strings", () => {
    expect(parseDateOnly("2026-02-31")).toBeUndefined();
    expect(parseDateOnly("2026-06-19T00:00:00.000Z")).toBeUndefined();
    expect(formatDateOnly(new Date(Number.NaN))).toBeUndefined();
  });
});
