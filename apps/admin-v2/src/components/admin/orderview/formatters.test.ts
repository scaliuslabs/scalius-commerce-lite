import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "~/i18n";
import { formatOrderTimestamp } from "./formatters";

describe("order timestamps", () => {
  afterEach(() => setLocale("en"));

  it("never mixes a Latin AM/PM into Bangla", () => {
    setLocale("bn");
    const text = formatOrderTimestamp("2026-09-24T01:28:00Z")!;
    expect(text).not.toMatch(/AM|PM/);
    expect(text).toContain("০৭:২৮");
  });

  it("keeps the 12-hour clock in English, in Dhaka time", () => {
    expect(formatOrderTimestamp("2026-09-24T01:28:00Z")).toBe("Sep 24, 2026, 7:28 AM");
  });
});
