import { describe, expect, it } from "vitest";

import {
  DEFAULT_STORE_TIME_ZONE,
  commerceCalendarDateKey,
  commerceCalendarDayBounds,
  commerceDayStart,
  commerceMonthBounds,
  commerceWallTimeToEpoch,
  isValidTimeZone,
  normalizeTimeZone,
  shiftCommerceCalendarDateKey,
  timeZoneOffsetSeconds,
  zoneOffsetSchedule,
} from "./commerce-time";

const seconds = (iso: string) => Date.parse(iso) / 1000;

describe("commerce calendar time", () => {
  it("uses the Bangladesh day at the UTC boundary", () => {
    expect(DEFAULT_STORE_TIME_ZONE).toBe("Asia/Dhaka");
    expect(commerceCalendarDateKey("Asia/Dhaka", new Date("2026-08-13T17:59:59.000Z")))
      .toBe("2026-08-13");
    expect(commerceCalendarDateKey("Asia/Dhaka", new Date("2026-08-13T18:00:00.000Z")))
      .toBe("2026-08-14");
  });

  it("returns exact inclusive UTC boundaries for a merchant day", () => {
    expect(commerceCalendarDayBounds("Asia/Dhaka", "2026-08-14")).toEqual({
      start: seconds("2026-08-13T18:00:00.000Z"),
      end: seconds("2026-08-14T17:59:59.000Z"),
    });
  });

  it("computes month boundaries independently of the host timezone", () => {
    expect(commerceMonthBounds("Asia/Dhaka", new Date("2026-07-31T18:30:00.000Z"))).toEqual({
      currentMonthStart: seconds("2026-07-31T18:00:00.000Z"),
      previousMonthStart: seconds("2026-06-30T18:00:00.000Z"),
    });
  });

  it("gives daylight saving days 23 and 25 hours", () => {
    // New York: 8 March 2026 springs forward, 1 November falls back.
    expect(commerceCalendarDayBounds("America/New_York", "2026-03-08")).toEqual({
      start: seconds("2026-03-08T05:00:00.000Z"),
      end: seconds("2026-03-09T03:59:59.000Z"),
    });
    expect(commerceCalendarDayBounds("America/New_York", "2026-11-01")).toEqual({
      start: seconds("2026-11-01T04:00:00.000Z"),
      end: seconds("2026-11-02T04:59:59.000Z"),
    });
    expect(commerceMonthBounds("Europe/Berlin", new Date("2026-04-15T12:00:00.000Z"))).toEqual({
      currentMonthStart: seconds("2026-03-31T22:00:00.000Z"),
      previousMonthStart: seconds("2026-02-28T23:00:00.000Z"),
    });
  });

  it("starts a day after the gap when the zone skips midnight", () => {
    // Santiago springs forward at 00:00 local on 6 September 2026: the day starts at 01:00 (UTC-3).
    expect(commerceDayStart("America/Santiago", "2026-09-06")).toBe(seconds("2026-09-06T04:00:00.000Z"));
    expect(commerceCalendarDateKey("America/Santiago", seconds("2026-09-06T04:00:00.000Z") * 1000)).toBe("2026-09-06");
    expect(commerceCalendarDateKey("America/Santiago", seconds("2026-09-06T03:59:59.000Z") * 1000)).toBe("2026-09-05");
  });

  it("maps store wall times through daylight saving", () => {
    expect(commerceWallTimeToEpoch("America/New_York", "2026-07-01", 9, 0)).toBe(seconds("2026-07-01T13:00:00.000Z"));
    // 02:30 does not exist on 8 March 2026: it moves past the gap.
    expect(commerceWallTimeToEpoch("America/New_York", "2026-03-08", 2, 30)).toBe(seconds("2026-03-08T07:30:00.000Z"));
    // 01:30 happens twice on 1 November 2026: the earlier.
    expect(commerceWallTimeToEpoch("America/New_York", "2026-11-01", 1, 30)).toBe(seconds("2026-11-01T05:30:00.000Z"));
    expect(commerceWallTimeToEpoch("Asia/Dhaka", "2026-02-30", 0, 0)).toBeNull();
  });

  it("lists each offset change of a range to the second", () => {
    expect(zoneOffsetSchedule("Asia/Dhaka", seconds("2026-01-01T00:00:00Z"), seconds("2027-01-01T00:00:00Z")))
      .toEqual({ initialOffset: 21_600, changes: [] });
    expect(zoneOffsetSchedule("Europe/London", seconds("2026-01-01T00:00:00Z"), seconds("2027-01-01T00:00:00Z"))).toEqual({
      initialOffset: 0,
      changes: [
        { at: seconds("2026-03-29T01:00:00Z"), offset: 3_600 },
        { at: seconds("2026-10-25T01:00:00Z"), offset: 0 },
      ],
    });
    expect(timeZoneOffsetSeconds("America/Los_Angeles", seconds("2026-07-01T00:00:00Z"))).toBe(-25_200);
  });

  it("validates zones and falls back to the default", () => {
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(normalizeTimeZone("Mars/Olympus")).toBe("Asia/Dhaka");
    expect(normalizeTimeZone(" UTC ")).toBe("UTC");
  });

  it("shifts date-only keys without viewer-timezone drift", () => {
    expect(shiftCommerceCalendarDateKey("2026-01-01", -1)).toBe("2025-12-31");
  });
});
