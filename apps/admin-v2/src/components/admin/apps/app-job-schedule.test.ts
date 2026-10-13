import { afterEach, describe, expect, it } from "vitest";
import { formatDateTime, setLocale } from "~/i18n";
import { setStoreTimeZone } from "~/lib/store-time-zone";
import { appJobScheduleText } from "./app-job-schedule";

afterEach(() => {
  setLocale("en");
  setStoreTimeZone("Asia/Dhaka");
});

describe("declared app job schedules", () => {
  it.each([
    ["* * * * *", "Every minute (at most once per check)"],
    ["*/5 * * * *", "Every 5 minutes (at most once per check)"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["0,30 * * * *", "Every 30 minutes"],
    ["5 * * * *", "Every hour at :05"],
  ])("describes %s without promising a run more often than the platform checks", (expression, expected) => {
    setLocale("en");
    expect(appJobScheduleText(expression)).toBe(expected);
  });

  it.each(["*/7 * * * *", "5/15 * * * *", "0 9 1-31 * 1", "0 9 * * 1-5", "0 9 1 * *", "0 9 * 1 *", "0 9,17 * * *", "*/15 9 * * *", "nonsense"])("does not approximate %s", (expression) => {
    setLocale("en");
    expect(appJobScheduleText(expression)).toBe("App-defined schedule");
  });

  it("keeps daily and weekly wall times unchanged when the store zone changes", () => {
    setLocale("en");
    const time = formatDateTime(new Date(Date.UTC(2023, 0, 1, 9, 30)), { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
    for (const zone of ["America/New_York", "Asia/Dhaka"]) {
      setStoreTimeZone(zone);
      expect(appJobScheduleText("30 9 * * *")).toBe(`Daily at ${time}`);
      expect(appJobScheduleText("30 9 * * 1")).toBe(`Every Monday at ${time}`);
      expect(appJobScheduleText("30 9 * * 7")).toBe(`Every Sunday at ${time}`);
    }
  });

  it("formats Bangla numbers, time, weekday and fallback text", () => {
    setLocale("bn");
    expect(appJobScheduleText("*/15 * * * *")).toBe("প্রতি ১৫ মিনিটে");
    expect(appJobScheduleText("5 * * * *")).toBe("প্রতি ঘণ্টার :০৫ মিনিটে");
    const time = formatDateTime(new Date(Date.UTC(2023, 0, 1, 9, 30)), { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
    expect(time).toMatch(/[০-৯]/);
    expect(appJobScheduleText("30 9 * * 1")).toBe(`প্রতি সোমবার ${time}`);
    expect(appJobScheduleText("0 9 1-31 * 1")).toBe("অ্যাপের নির্ধারিত সময়সূচি");
  });
});
