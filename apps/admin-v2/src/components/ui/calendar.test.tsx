// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "~/i18n";
import { getStoreTimeZone, setStoreTimeZone } from "~/lib/store-time-zone";
import { Calendar } from "./calendar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const selected = new Date(2026, 9, 7);

describe("Calendar language", () => {
  let host: HTMLDivElement;
  let root: Root;
  let storeTimeZone: string;

  beforeEach(() => {
    storeTimeZone = getStoreTimeZone();
    setStoreTimeZone("Pacific/Honolulu");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setLocale("en");
    setStoreTimeZone(storeTimeZone);
  });

  it.each([
    { locale: "en", month: "October", year: "2026", weekday: "S", weekdayName: "Sunday", thursday: "T", thursdayName: "Thursday", navigation: "Calendar navigation", day: "7", dayName: "Wednesday", previous: "Previous month", next: "Next month", today: "Today", chosen: "selected" },
    { locale: "bn", month: "অক্টোবর", year: "২০২৬", weekday: "র", weekdayName: "রবিবার", thursday: "বৃ", thursdayName: "বৃহস্পতিবার", navigation: "ক্যালেন্ডার নেভিগেশন", day: "৭", dayName: "বুধবার", previous: "আগের মাস", next: "পরের মাস", today: "আজ", chosen: "বাছাই করা" },
  ] as const)("renders the caption, weekdays, days and accessible names in $locale", async (expected) => {
    setLocale(expected.locale);
    await act(async () => root.render(<Calendar mode="single" defaultMonth={selected} selected={selected} today={selected} />));
    const caption = host.querySelector('[role="status"]')!;
    expect(caption.textContent).toContain(expected.month);
    expect(caption.textContent).toContain(expected.year);
    expect(host.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe(caption.textContent);
    const weekday = host.querySelector(`th[aria-label="${expected.weekdayName}"]`);
    expect(weekday?.textContent).toBe(expected.weekday);
    expect(host.querySelector(`th[aria-label="${expected.thursdayName}"]`)?.textContent).toBe(expected.thursday);
    expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe(expected.navigation);
    expect(host.querySelector(`button[aria-label="${expected.previous}"]`)).not.toBeNull();
    expect(host.querySelector(`button[aria-label="${expected.next}"]`)).not.toBeNull();
    const day = host.querySelector('button[data-day="2026-10-07"]')!;
    expect(day.textContent).toBe(expected.day);
    const name = day.getAttribute("aria-label");
    for (const part of [expected.dayName, expected.day, expected.month, expected.year, expected.today, expected.chosen]) {
      expect(name).toContain(part);
    }
  });

  it("updates an already open calendar when the dashboard language changes", async () => {
    setLocale("en");
    await act(async () => root.render(<Calendar mode="single" defaultMonth={selected} selected={selected} today={selected} />));
    await act(async () => setLocale("bn"));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("অক্টোবর");
    expect(host.querySelector('button[data-day="2026-10-07"]')?.textContent).toBe("৭");
    expect(host.querySelector('button[aria-label="পরের মাস"]')).not.toBeNull();
    expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe("ক্যালেন্ডার নেভিগেশন");
  });
});
