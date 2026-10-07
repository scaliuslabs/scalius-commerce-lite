import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { setStoreTimeZone } from "~/lib/store-time-zone";
import { eventTime } from "./event-time";

describe("when something happened", () => {
  // 18:00 in Dhaka on Wednesday 7 October 2026.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T12:00:00Z") });
    setStoreTimeZone("Asia/Dhaka");
  });
  afterEach(() => {
    vi.useRealTimers();
    setLocale("en");
  });

  it("tells recent events relative to now and older ones by date, never numerically", () => {
    expect(eventTime("2026-10-07T11:59:30Z")).toBe("Just now");
    expect(eventTime("2026-10-07T11:19:00Z")).toBe("41 min ago");
    expect(eventTime("2026-10-07T09:42:00Z")).toBe("Today at 3:42 PM");
    expect(eventTime("2026-10-06T17:42:00Z")).toBe("Yesterday at 11:42 PM");
    expect(eventTime("2026-10-04T03:05:00Z")).toBe("Sunday at 9:05 AM");
    expect(eventTime("2026-09-24T01:28:00Z")).toBe("Sep 24 at 7:28 AM");
    // Another year keeps its year, and the time unless a list leaves it to the tooltip.
    expect(eventTime("2025-10-03T09:42:00Z")).toBe("Oct 3, 2025 at 3:42 PM");
    expect(eventTime("2025-10-03T09:42:00Z", { withTime: false })).toBe("Oct 3, 2025");
  });

  it("says nothing for a missing or unreadable time", () => {
    expect(eventTime(null)).toBeNull();
    expect(eventTime("not-a-date")).toBeNull();
  });

  it("speaks Bangla in Bangla", () => {
    setLocale("bn");
    expect(eventTime("2026-10-07T11:59:30Z")).toBe("এইমাত্র");
    expect(eventTime("2026-10-07T11:19:00Z")).toBe("৪১ মিনিট আগে");
  });
});
