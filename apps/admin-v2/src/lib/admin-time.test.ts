import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { adminCalendarDateKey } from "./admin-time";
import { getStoreTimeZone, setStoreRegion, setStoreTimeZone } from "./store-time-zone";
import { formatOrderDate, formatOrderTimestamp } from "~/components/admin/orderview/formatters";

const space = (text: string | null) => text?.replace(/\s/g, " ") ?? null;

describe("admin commerce time", () => {
  // Event times read relative to now, so the clock is fixed.
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T12:00:00Z") }));
  afterEach(() => {
    vi.useRealTimers();
    setLocale("en");
    setStoreRegion("BD");
    setStoreTimeZone("Asia/Dhaka");
  });

  it("keeps a UTC day-boundary order on the Bangladesh store date", () => {
    const value = "2026-07-18T20:53:00.000Z";
    expect(getStoreTimeZone()).toBe("Asia/Dhaka");
    expect(formatOrderDate(value)).toBe("Jul 19, 2026");
    expect(space(formatOrderTimestamp(value))).toBe("Jul 19 at 2:53 AM");
    setLocale("bn");
    expect(space(formatOrderTimestamp(value))).toBe("১৯ জুল ০২:৫৩");
  });

  it("keeps date-only activity keys and generated filenames on the merchant day", () => {
    expect(adminCalendarDateKey(new Date("2026-07-18T20:53:00.000Z"))).toBe("2026-07-19");
  });

  it("fails closed for missing or invalid timestamps", () => {
    expect(formatOrderDate(null)).toBeNull();
    expect(formatOrderTimestamp(undefined)).toBeNull();
    expect(formatOrderTimestamp("not-a-date")).toBeNull();
  });

  it("follows the store's zone and country once they are known, daylight saving included", () => {
    setStoreTimeZone("America/New_York");
    // 2026-07-18 20:53 UTC is 4:53 PM EDT; in January it is EST (UTC-5).
    expect(space(formatOrderTimestamp("2026-07-18T20:53:00.000Z"))).toBe("Jul 18 at 4:53 PM");
    expect(space(formatOrderTimestamp("2026-01-18T20:53:00.000Z"))).toBe("Jan 18 at 3:53 PM");
    expect(adminCalendarDateKey(new Date("2026-07-19T03:00:00.000Z"))).toBe("2026-07-18");
    setStoreTimeZone("Europe/London");
    setStoreRegion("GB");
    expect(space(formatOrderTimestamp("2026-07-18T20:53:00.000Z"))).toBe("18 Jul at 21:53");
  });
});
