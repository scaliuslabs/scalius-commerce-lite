import { describe, expect, it } from "vitest";

import {
  COMMERCE_TIME_ZONE,
  commerceCalendarDateKey,
  commerceCalendarDayBounds,
  commerceMonthBounds,
  formatCommerceCalendarDate,
  shiftCommerceCalendarDateKey,
} from "./commerce-time";

describe("commerce calendar time", () => {
  it("uses the Bangladesh day at the UTC boundary", () => {
    expect(COMMERCE_TIME_ZONE).toBe("Asia/Dhaka");
    expect(commerceCalendarDateKey(new Date("2026-08-13T17:59:59.000Z")))
      .toBe("2026-08-13");
    expect(commerceCalendarDateKey(new Date("2026-08-13T18:00:00.000Z")))
      .toBe("2026-08-14");
  });

  it("returns exact inclusive UTC boundaries for a merchant day", () => {
    expect(commerceCalendarDayBounds("2026-08-14")).toEqual({
      start: Date.parse("2026-08-13T18:00:00.000Z") / 1000,
      end: Date.parse("2026-08-14T17:59:59.000Z") / 1000,
    });
  });

  it("computes month boundaries independently of the host timezone", () => {
    expect(commerceMonthBounds(new Date("2026-07-31T18:30:00.000Z"))).toEqual({
      currentMonthStart: Date.parse("2026-07-31T18:00:00.000Z") / 1000,
      previousMonthStart: Date.parse("2026-06-30T18:00:00.000Z") / 1000,
    });
  });

  it("shifts and formats date-only keys without viewer-timezone drift", () => {
    expect(shiftCommerceCalendarDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(formatCommerceCalendarDate("2026-08-14")).toBe("Aug 14, 2026");
    expect(formatCommerceCalendarDate("not-a-date")).toBe("not-a-date");
  });
});
