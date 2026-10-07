import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { formatOrderTimestamp } from "./formatters";

describe("order timestamps", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T12:00:00Z") }));
  afterEach(() => {
    vi.useRealTimers();
    setLocale("en");
  });

  it("never mixes a Latin AM/PM into Bangla", () => {
    setLocale("bn");
    const text = formatOrderTimestamp("2026-09-24T01:28:00Z")!;
    expect(text).not.toMatch(/AM|PM/);
    expect(text).toContain("০৭:২৮");
  });

  it("tells recent events relative to now and older ones by date, never numerically", () => {
    expect(formatOrderTimestamp("2026-10-07T11:19:00Z")).toBe("41 min ago");
    expect(formatOrderTimestamp("2026-10-06T17:42:00Z")).toBe("Yesterday at 11:42 PM");
    expect(formatOrderTimestamp("2025-10-03T09:42:00Z")).toBe("Oct 3, 2025 at 3:42 PM");
  });

  it("keeps the 12-hour clock in English, in Dhaka time", () => {
    expect(formatOrderTimestamp("2026-09-24T01:28:00Z")).toBe("Sep 24 at 7:28 AM");
  });
});
