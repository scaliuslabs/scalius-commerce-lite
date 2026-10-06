import { describe, expect, it } from "vitest";
import {
  formatAdminDate,
  formatAdminCalendarDate,
  formatAdminTimestamp,
  formatAdminTime,
  adminCalendarDateKey,
} from "./admin-time";
import { getStoreTimeZone, setStoreTimeZone } from "./store-time-zone";
import {
  formatOrderDate,
  formatOrderTimestamp,
} from "~/components/admin/orderview/formatters";

describe("admin commerce time", () => {
  it("keeps a UTC day-boundary order on the Bangladesh store date", () => {
    const unixSeconds = Date.parse("2026-07-18T20:53:00.000Z") / 1_000;

    expect(getStoreTimeZone()).toBe("Asia/Dhaka");
    expect(formatAdminDate(unixSeconds)).toBe("Jul 19, 2026");
    expect(formatAdminTimestamp(unixSeconds)).toBe("Jul 19, 2026, 2:53 AM");
    expect(formatAdminTime(unixSeconds)).toBe("02:53:00 AM");
  });

  it("keeps order formatting on the same shared admin boundary", () => {
    const value = "2026-07-18T20:53:00.000Z";

    expect(formatOrderDate(value)).toBe(formatAdminDate(value));
    expect(formatOrderTimestamp(value)).toBe(formatAdminTimestamp(value));
  });

  it("keeps date-only activity keys and generated filenames on the merchant day", () => {
    expect(formatAdminCalendarDate("2026-07-19")).toBe("Jul 19, 2026");
    expect(adminCalendarDateKey(new Date("2026-07-18T20:53:00.000Z")))
      .toBe("2026-07-19");
  });

  it("fails closed for missing or invalid timestamps", () => {
    expect(formatAdminDate(null)).toBeNull();
    expect(formatAdminTimestamp(undefined)).toBeNull();
    expect(formatAdminTimestamp("not-a-date")).toBeNull();
    expect(formatAdminTime("not-a-date")).toBeNull();
  });

  it("follows the store's zone once it is known, daylight saving included", () => {
    setStoreTimeZone("America/New_York");
    try {
      // 2026-07-18 20:53 UTC is 4:53 PM EDT; in January it is EST (UTC-5).
      expect(formatAdminTimestamp("2026-07-18T20:53:00.000Z")).toBe("Jul 18, 2026, 4:53 PM");
      expect(formatAdminTimestamp("2026-01-18T20:53:00.000Z")).toBe("Jan 18, 2026, 3:53 PM");
      expect(adminCalendarDateKey(new Date("2026-07-19T03:00:00.000Z"))).toBe("2026-07-18");
    } finally {
      setStoreTimeZone("Asia/Dhaka");
    }
  });
});
