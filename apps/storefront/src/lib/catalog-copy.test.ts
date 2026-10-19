// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatMoney } from "@scalius/shared/currency";
import { catalogCopy } from "./catalog-copy";
import { buildDeliveryFacts } from "./delivery-facts";
import { catalogApplyButton } from "./catalog-filters";
import { catalogProgressLabel } from "./catalog-paging";

/** The same shape, leaf by leaf, with every word filled in (functions answer a word, never nothing). */
function shape(value: unknown, name = "copy"): string[] {
  if (typeof value === "function") {
    const answer = (value as (...args: unknown[]) => unknown)("12", "3", "40", false);
    return typeof answer === "string" && answer.trim() ? [`${name}()`] : [`${name}() EMPTY`];
  }
  if (typeof value === "string") return value.trim() ? [name] : [`${name} EMPTY`];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => shape(child, `${name}.${key}`));
}

describe("the catalog pages' words", () => {
  it("has every key in English and Bangla, none empty, and no English word in Bangla", () => {
    const english = shape(catalogCopy("en"));
    expect(english.some((entry) => entry.endsWith("EMPTY"))).toBe(false);
    expect(shape(catalogCopy("bn"))).toEqual(english);
    const words = (value: unknown): string[] => typeof value === "function"
      ? [(value as (...args: string[]) => string)("৳১", "২", "৩")]
      : typeof value === "string" ? [value] : Object.values(value as object).flatMap(words);
    expect(words(catalogCopy("bn")).filter((word) => /[A-Za-z]{2,}/.test(word))).toEqual([]);
  });

  it("speaks Bangla for a Bangla store, English otherwise", () => {
    expect(catalogCopy("bn-BD").breadcrumb.home).toBe("হোম");
    expect(catalogCopy("fr").breadcrumb.home).toBe("Home");
  });

  it("writes the delivery facts, the live apply button and the progress line in the store's words", () => {
    const money = (amount: number) => formatMoney(amount, { code: "BDT", language: "bn" });
    const facts = buildDeliveryFacts({
      shippingMethods: [
        { id: "dhaka", name: "ঢাকা", fee: 60, freeOver: null, sortOrder: 0, isActive: true, kind: "delivery", countries: [{ code: "BD", entire: false }] },
      ] as never,
      checkoutConfig: { gateways: [{ id: "cod", name: "ক্যাশ অন ডেলিভারি", flow: "cod", countries: ["BD"] }] },
      returnPolicy: null,
      formatMoney: money,
      countries: ["BD"],
      copy: catalogCopy("bn").delivery,
    });
    expect(facts.map(({ title, detail }) => [title, detail])).toEqual([
      ["ডেলিভারি ৳৬০ থেকে", "চার্জ আপনার এলাকার ওপর নির্ভর করে"],
      ["ক্যাশ অন ডেলিভারি", "অর্ডার হাতে পেয়ে দাম দিন।"],
    ]);
    const words = catalogCopy("bn").filters;
    expect(catalogApplyButton(0, false, { one: words.showProducts("{count}", true), many: words.showProducts("{count}", false), none: words.noMatchingProducts }))
      .toEqual({ label: "কোনো পণ্য মেলেনি", disabled: true });
    const paging = catalogCopy("bn");
    expect(catalogProgressLabel(21, 40, 52, false, {
      progressOne: paging.paging.progress("{from}", "{to}", "{total}", true),
      progressMany: paging.paging.progress("{from}", "{to}", "{total}", false),
      countOne: paging.listing.products("{total}", true),
      countMany: paging.listing.products("{total}", false),
    })).toBe("52টির মধ্যে 21–40 দেখানো হচ্ছে");
  });
});
