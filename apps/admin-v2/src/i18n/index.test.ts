import { afterEach, describe, expect, it } from "vitest";
import { setStoreRegion } from "~/lib/store-time-zone";
import { formatWeight } from "~/components/admin/product-form/variants/weight-format";
import { formatList } from "@scalius/shared/locale-words";
import { defineMessages, formatNumber, getLocale, setLocale, translate } from "./index";

const messages = defineMessages({
  en: { saved: "Order saved", items: "{count} items" },
  bn: { saved: "অর্ডার সেভ হয়েছে", items: "{count}টি পণ্য" },
});

afterEach(() => {
  setLocale("en");
  setStoreRegion("BD");
});

describe("dashboard messages", () => {
  it("translates the active locale and formats numeric variables for it", () => {
    expect(translate(messages, "items", { count: 1200 })).toBe("1,200 items");
    expect(formatNumber(1234567.5, { minimumFractionDigits: 2 })).toBe("12,34,567.50");
    setLocale("bn");
    expect(translate(messages, "saved")).toBe("অর্ডার সেভ হয়েছে");
    expect(translate(messages, "items", { count: 12 })).toBe("১২টি পণ্য");
    expect(formatNumber(1234567)).toBe("১২,৩৪,৫৬৭");
  });

  it("writes numbers as the store's country does (CLDR), Bangla digits unchanged", () => {
    setStoreRegion("US");
    expect(formatNumber(1234567.5)).toBe("1,234,567.5");
    setStoreRegion("DE");
    expect(formatNumber(1234567.5)).toBe("1.234.567,5");
    setLocale("bn");
    setStoreRegion("BD");
    expect(formatNumber(1234567.5)).toBe("১২,৩৪,৫৬৭.৫");
  });

  it("lists in the dashboard language and states weights in the store's unit", () => {
    expect(formatList(["bKash", "Nagad", "card"], getLocale())).toBe("bKash, Nagad, and card");
    expect(formatWeight(1_000_000, "g")).toBe("10,00,000 g");
    expect(formatWeight(1_000_000, "kg")).toBe("1,000 kg");
    setStoreRegion("US");
    expect(formatWeight(1_000_000, "lb")).toBe("2,204.62 lb");
  });
});
