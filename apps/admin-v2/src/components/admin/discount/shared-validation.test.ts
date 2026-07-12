import { describe, expect, it } from "vitest";

import {
  discountCodeSchema,
  normalizeDiscountEndDate,
  normalizeDiscountStartDate,
} from "./shared-validation";

describe("discount admin validation", () => {
  it("normalizes codes consistently with core", () => {
    expect(discountCodeSchema.parse("  welcome-10  ")).toBe("WELCOME-10");
  });

  it("saves date-only eligibility across the selected local day", () => {
    const selected = new Date(2026, 6, 13, 12, 34, 56, 789);
    const start = normalizeDiscountStartDate(selected);
    const end = normalizeDiscountEndDate(selected);

    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
  });
});
