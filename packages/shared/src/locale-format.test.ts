import { describe, expect, it } from "vitest";
import {
  RTL_PSEUDO_LOCALE,
  dateLocale,
  formatDateTime,
  formatNumber,
  numberLocale,
  textDirection,
} from "./locale-format";
import { currencySymbol, formatAmount, moneyLocale } from "./money-format";
import { formatList, formatRelativeTime, formatUnit, pluralCategory } from "./locale-words";
import { weekStartDay } from "./week-start";

const space = (text: string) => text.replace(/\s/g, " ");

describe("locale-format", () => {
  it("writes Bangladesh's numbers in lakhs in both languages, Bangla with Bangla digits", () => {
    expect(formatNumber(1_234_567.5, numberLocale("en", "BD"))).toBe("12,34,567.5");
    expect(formatNumber(1_234_567.5, numberLocale("bn", "BD"))).toBe("১২,৩৪,৫৬৭.৫");
    expect(formatNumber(1_234_567.5, numberLocale("bn"))).toBe("১২,৩৪,৫৬৭.৫");
  });

  it("writes other countries' numbers by CLDR", () => {
    expect(formatNumber(1_234_567.5, numberLocale("en", "US"))).toBe("1,234,567.5");
    expect(formatNumber(1_234_567.5, numberLocale("en", "DE"))).toBe("1.234.567,5");
    expect(formatNumber(1_234_567.5, numberLocale("ar", "EG"))).toBe("١٬٢٣٤٬٥٦٧٫٥");
  });

  it("dates instants in the given zone", () => {
    const at = Date.UTC(2026, 9, 7, 9, 42);
    const options = { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" } as const;
    expect(space(formatDateTime(at, dateLocale("en", "BD"), options))).toBe("Oct 7, 2026, 3:42 PM");
    expect(space(formatDateTime(at, dateLocale("bn", "BD"), { ...options, hourCycle: "h23" }))).toBe("৭ অক্টো, ২০২৬, ১৫:৪২");
    expect(space(formatDateTime(at, dateLocale("en", "GB"), { ...options, timeZone: "Europe/London" }))).toBe("7 Oct 2026, 10:42");
  });

  it("formats relative times, lists, plurals and units", () => {
    expect(formatRelativeTime(-41, "minute", "en")).toBe("41 minutes ago");
    expect(formatRelativeTime(-1, "day", "en", { numeric: "auto" })).toBe("yesterday");
    expect(formatList(["bKash", "Nagad", "card"], "en")).toBe("bKash, Nagad, and card");
    expect(formatList(["USD", "EUR"], "en", "disjunction")).toBe("USD or EUR");
    expect(pluralCategory(1, "en")).toBe("one");
    expect(pluralCategory(2, "en")).toBe("other");
    expect(formatUnit(2.5, "kilogram", "en")).toBe("2.5 kg");
    expect(formatUnit(12, "ounce", "en", { unitDisplay: "long" })).toBe("12 ounces");
  });

  it("gives money amounts their decimals, and none for a whole amount on request", () => {
    expect(formatAmount(1822.5, numberLocale("en", "BD"), 2)).toBe("1,822.50");
    expect(formatAmount(230690, numberLocale("en", "BD"), 2, true)).toBe("2,30,690");
    expect(formatAmount(230690, numberLocale("bn", "BD"), 2)).toBe("২,৩০,৬৯০.০০");
    expect(currencySymbol("BDT")).toBe("৳");
    expect(currencySymbol("EUR")).toBe("€");
    expect(moneyLocale("BDT")).toBe("en-IN");
    expect(moneyLocale("USD")).toBe("en");
    expect(moneyLocale("USD", "bn")).toBe("bn-BD");
  });

  it("falls back inside Intl for a language the runtime lacks", () => {
    expect(formatNumber(1000, numberLocale("zz", "ZZ"))).toBe("1,000");
  });

  it("starts the week on the country's CLDR first day", () => {
    expect(weekStartDay("BD")).toBe(0);
    expect(weekStartDay("US")).toBe(0);
    expect(weekStartDay("GB")).toBe(1);
    expect(weekStartDay("DE")).toBe(1);
    expect(weekStartDay("AE")).toBe(1);
    expect(weekStartDay("EG")).toBe(6);
    expect(weekStartDay("MV")).toBe(5);
    expect(weekStartDay(null, "bn")).toBe(0);
    expect(weekStartDay(null, "en")).toBe(0);
  });

  it("matches the runtime's CLDR week data where the runtime has it", () => {
    const locale = Intl.Locale.prototype as { getWeekInfo?: () => { firstDay: number } };
    if (!locale.getWeekInfo) return;
    for (const region of ["BD", "IN", "US", "GB", "FR", "SA", "EG", "IR", "MV", "BR", "JP", "AU", "NG", "PK"]) {
      const info = (new Intl.Locale(`und-${region}`) as unknown as { getWeekInfo: () => { firstDay: number } }).getWeekInfo();
      expect(weekStartDay(region), region).toBe(info.firstDay % 7);
    }
  });

  it("knows which languages run right to left, the test pseudo-locale included", () => {
    for (const language of ["ar", "ur-PK", "he", "fa_IR", RTL_PSEUDO_LOCALE]) expect(textDirection(language), language).toBe("rtl");
    for (const language of ["en", "bn", "", null]) expect(textDirection(language)).toBe("ltr");
  });
});
