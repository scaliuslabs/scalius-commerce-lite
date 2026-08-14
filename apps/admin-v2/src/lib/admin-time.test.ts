import { describe, expect, it } from "vitest";
import {
  ADMIN_TIME_ZONE,
  formatAdminDate,
  formatAdminCalendarDate,
  formatAdminTimestamp,
  adminCalendarDateKey,
} from "./admin-time";
import {
  formatOrderDate,
  formatOrderTimestamp,
} from "~/components/admin/orderview/formatters";

describe("admin commerce time", () => {
  it("keeps a UTC day-boundary order on the Bangladesh store date", () => {
    const unixSeconds = Date.parse("2026-07-18T20:53:00.000Z") / 1_000;

    expect(ADMIN_TIME_ZONE).toBe("Asia/Dhaka");
    expect(formatAdminDate(unixSeconds)).toBe("Jul 19, 2026");
    expect(formatAdminTimestamp(unixSeconds)).toBe("Jul 19, 2026, 2:53 AM");
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
  });
});
