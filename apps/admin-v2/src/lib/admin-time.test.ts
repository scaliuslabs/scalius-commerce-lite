import { describe, expect, it } from "vitest";
import {
  ADMIN_TIME_ZONE,
  formatAdminDate,
  formatAdminTimestamp,
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

  it("fails closed for missing or invalid timestamps", () => {
    expect(formatAdminDate(null)).toBeNull();
    expect(formatAdminTimestamp(undefined)).toBeNull();
    expect(formatAdminTimestamp("not-a-date")).toBeNull();
  });
});
