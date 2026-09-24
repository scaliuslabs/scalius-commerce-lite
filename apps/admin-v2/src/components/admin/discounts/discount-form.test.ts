import { describe, expect, it } from "vitest";

import {
  combinationPreview,
  describeValue,
  discountStatus,
  draftFromDiscount,
  draftToInput,
  emptyDraft,
  epochToStoreTime,
  exceedsEveryPrice,
  generateDiscountCode,
  latinDigits,
  limitReached,
  storeTimeToEpoch,
  summarizeDraft,
  validateDraft,
  type DiscountDraft,
  type SummaryFormat,
} from "./discount-form";
import type { DiscountRecord } from "~/lib/api-query-options/discounts";

const NOW = Date.UTC(2026, 8, 24, 6, 0); // 12:00 in Dhaka
const NOW_SECONDS = NOW / 1_000;
const FORMAT: SummaryFormat = {
  money: (value) => `৳${Number(value).toLocaleString("en-IN")}`,
  number: (value) => value,
  date: () => "24 Sept 2026",
  scope: ({ kind, ids }) => (kind === "products" ? ids.map((id) => id.replace("prod_", "")).join(", ") : `${ids.length} collections`),
};

function draft(type: DiscountDraft["type"], patch: Partial<DiscountDraft> = {}): DiscountDraft {
  return { ...emptyDraft(type, NOW), code: "SUMMER20", ...patch };
}

function record(input: ReturnType<typeof draftToInput>): DiscountRecord {
  return {
    ...input,
    id: "promo_1",
    revision: 3,
    status: "active",
    priority: 100,
    conflictPolicy: "best",
    combinesWith: input.combinesWith!,
    title: null,
    startsAtEpochSeconds: input.startsAtEpochSeconds ?? null,
    endsAtEpochSeconds: input.endsAtEpochSeconds ?? null,
    timezone: "Asia/Dhaka",
    maxRedemptions: input.maxRedemptions ?? null,
    maxRedemptionsPerCustomer: input.maxRedemptionsPerCustomer ?? null,
    maxDiscountSpendMinor: input.maxDiscountSpendMinor ?? null,
    budgetCurrencyCode: input.budgetCurrencyCode ?? null,
    redemptionCount: 0,
    customerRedemptionCount: 0,
    discountSpendMinor: 0,
    createdAtEpochSeconds: 0,
    updatedAtEpochSeconds: 0,
    deletedAtEpochSeconds: null,
    codes: (input.codes ?? []).map(({ code }) => ({ code, isActive: true })),
    conditions: (input.conditions ?? []).map((condition, index) => ({ id: `c${index}`, ...condition })),
    effects: input.effects.map((effect, index) => ({ id: `e${index}`, ...effect })),
  } as DiscountRecord;
}

describe("discount form model", () => {
  it("uses Bangladesh store time for schedules", () => {
    expect(emptyDraft("order", NOW)).toMatchObject({ startDate: "2026-09-24", startTime: "12:00" });
    expect(storeTimeToEpoch("2026-09-24", "12:00")).toBe(NOW_SECONDS);
    expect(epochToStoreTime(NOW_SECONDS)).toEqual({ date: "2026-09-24", time: "12:00" });
    expect(storeTimeToEpoch("2026-02-30", "10:00")).toBeNull();
  });

  it("builds a scoped product discount whose minimum counts only the chosen items", () => {
    const input = draftToInput(draft("products", {
      value: "15",
      appliesTo: { kind: "collections", ids: ["col_summer"] },
      minimum: "quantity",
      minimumValue: "2",
      combines: { product: true, order: true, shipping: false },
      limitTotal: true,
      totalUses: "100",
      oncePerCustomer: true,
    }), "BDT");
    expect(input).toMatchObject({
      name: "SUMMER20",
      method: "code",
      codes: [{ code: "SUMMER20", isActive: true }],
      combinesWith: { product: false, order: true, shipping: false },
      maxRedemptions: 100,
      maxRedemptionsPerCustomer: 1,
      conditions: [{ kind: "minimum_item_quantity", config: { quantity: 2, collectionIds: ["col_summer"] } }],
      effects: [{ kind: "percentage_off", target: "line", allocation: "across", config: { basisPoints: 1_500, collectionIds: ["col_summer"] } }],
    });
  });

  it("round-trips every discount type through the API rule", () => {
    const drafts: DiscountDraft[] = [
      draft("products", { valueKind: "fixed", value: "50.5", appliesTo: { kind: "products", ids: ["prod_1"] } }),
      draft("products", { valueKind: "fixed", value: "50", oncePerOrder: true, appliesTo: { kind: "products", ids: ["prod_1"] } }),
      draft("order", { value: "10", minimum: "amount", minimumValue: "1000", hasEnd: true, endDate: "2026-10-01", endTime: "23:59" }),
      draft("products", {
        value: "20", appliesTo: { kind: "collections", ids: ["col_eid"] }, freeShipping: true, freeShippingMinimum: "1500",
        minimum: "quantity", minimumValue: "2", combines: { product: false, order: true, shipping: true },
      }),
      draft("shipping", { method: "automatic", code: "", title: "Free delivery weekend" }),
      draft("buy_get", {
        buyKind: "amount", buyValue: "1500", buyScope: { kind: "products", ids: ["prod_phone"] },
        getQuantity: "2", getScope: { kind: "collections", ids: ["col_cases"] },
        getValueKind: "percentage", getValue: "50", limitUsesPerOrder: true, usesPerOrder: "1",
      }),
    ];
    for (const original of drafts) {
      expect(validateDraft(original, "BDT", NOW_SECONDS)).toEqual({});
      const restored = draftFromDiscount(record(draftToInput(original, "BDT")), "BDT");
      expect(draftToInput(restored, "BDT")).toEqual(draftToInput(original, "BDT"));
    }
  });

  it("drops usage limits from automatic discounts", () => {
    const input = draftToInput(draft("order", {
      method: "automatic", title: "Eid 10%", value: "10", limitTotal: true, totalUses: "5", oncePerCustomer: true,
    }), "BDT");
    expect(input).toMatchObject({ name: "Eid 10%", codes: [], maxRedemptions: null, maxRedemptionsPerCustomer: null });
  });

  it("flags every missing fact with a catalog message", () => {
    expect(validateDraft(draft("products", { code: "", value: "0", endDate: "" }), "BDT", NOW_SECONDS)).toEqual({
      code: "errorCodeRequired",
      value: "errorPercent",
      appliesTo: "errorPickItems",
    });
    expect(validateDraft(draft("buy_get", { buyValue: "x", getQuantity: "0", getValueKind: "percentage", getValue: "101" }), "BDT", NOW_SECONDS))
      .toMatchObject({ buyValue: "errorQuantity", buyScope: "errorPickItems", getQuantity: "errorQuantity", getScope: "errorPickItems", getValue: "errorPercent" });
    expect(validateDraft(draft("order", {
      value: "5", startDate: "2026-10-02", hasEnd: true, endDate: "2026-10-01", endTime: "11:00",
    }), "BDT", NOW_SECONDS)).toEqual({ endDate: "errorEndBeforeStart" });
    expect(validateDraft(draft("order", { value: "5", valueKind: "fixed" }), "JPY", NOW_SECONDS)).toEqual({});
    expect(validateDraft(draft("order", { value: "5.5", valueKind: "fixed" }), "JPY", NOW_SECONDS)).toEqual({ value: "errorWholeAmount" });
  });

  it("explains amount problems in the merchant's words and accepts Bangla digits", () => {
    const order = (patch: Partial<DiscountDraft>) => validateDraft(draft("order", { valueKind: "fixed", ...patch }), "BDT", NOW_SECONDS);
    expect(latinDigits("১০.৫০")).toBe("10.50");
    expect(order({ value: "১০" })).toEqual({});
    expect(draftToInput(draft("order", { valueKind: "fixed", value: "১৫০০" }), "BDT").effects[0]!.config)
      .toMatchObject({ amountMinor: 150_000 });
    expect(order({ value: "10.555" })).toEqual({ value: "errorDecimals" });
    expect(order({ value: "0" })).toEqual({ value: "errorAmount" });
    expect(order({ value: "abc" })).toEqual({ value: "errorAmount" });
    expect(order({ value: "1000000" })).toEqual({});
    expect(order({ value: "99999999999" })).toEqual({ value: "errorAmountMax" });
    expect(order({ value: "5", minimum: "quantity", minimumValue: "২" })).toEqual({});
    expect(order({ value: "5", minimum: "quantity", minimumValue: "20000" })).toEqual({ minimumValue: "errorQuantityMax" });
    expect(validateDraft(draft("order", { value: "১২.৫" }), "BDT", NOW_SECONDS)).toEqual({});
  });

  it("refuses an end date that has already passed", () => {
    const past = draft("order", { value: "5", startDate: "2026-09-01", startTime: "10:00", hasEnd: true, endDate: "2026-09-10", endTime: "10:00" });
    expect(validateDraft(past, "BDT", NOW_SECONDS)).toEqual({ endDate: "errorEndPassed" });
    // Before today's start too: "it has passed" is the useful reason.
    expect(validateDraft({ ...past, startDate: "2026-09-24" }, "BDT", NOW_SECONDS)).toEqual({ endDate: "errorEndPassed" });
    expect(validateDraft({ ...past, endDate: "2026-10-10" }, "BDT", NOW_SECONDS)).toEqual({});
  });

  it("shows ended drafts and live discounts as expired, and spots a spent usage limit", () => {
    const ended = { startsAtEpochSeconds: NOW_SECONDS - 1_000, endsAtEpochSeconds: NOW_SECONDS - 10 };
    expect(discountStatus({ ...ended, status: "draft" }, NOW_SECONDS)).toBe("expired");
    expect(discountStatus({ ...ended, status: "active" }, NOW_SECONDS)).toBe("expired");
    expect(discountStatus({ ...ended, status: "paused" }, NOW_SECONDS)).toBe("inactive");
    expect(discountStatus({ ...ended, status: "draft", endsAtEpochSeconds: null }, NOW_SECONDS)).toBe("draft");
    expect(discountStatus({ status: "active", startsAtEpochSeconds: NOW_SECONDS + 60, endsAtEpochSeconds: null }, NOW_SECONDS)).toBe("scheduled");
    expect(limitReached({ maxRedemptions: 1, redemptionCount: 1 })).toBe(true);
    expect(limitReached({ maxRedemptions: 5, redemptionCount: 1 })).toBe(false);
    expect(limitReached({ maxRedemptions: null, redemptionCount: 99 })).toBe(false);
  });

  it("summarizes only complete facts, naming the picked items", () => {
    const keys = (value: DiscountDraft) => summarizeDraft(value, "BDT", FORMAT).map(({ key }) => key);
    // Nothing typed yet: no "Minimum purchase of ৳0" and no "Gets 1 item at 0% off".
    expect(keys(draft("order", { minimum: "amount" }))).toEqual(["summaryNoLimits", "summaryNoCombine", "summaryActiveFrom"]);
    expect(keys(draft("buy_get", { getValueKind: "percentage" }))).toEqual(["summaryNoLimits", "summaryNoCombine", "summaryActiveFrom"]);

    const lines = summarizeDraft(draft("buy_get", {
      buyValue: "2", buyScope: { kind: "products", ids: ["prod_Panjabi"] },
      getQuantity: "1", getScope: { kind: "products", ids: ["prod_Attar"] },
      getValueKind: "percentage", getValue: "50", combines: { product: false, order: true, shipping: true },
    }), "BDT", FORMAT);
    expect(lines).toEqual([
      { key: "summaryBuyQuantity", vars: { count: "2", names: "Panjabi" } },
      { key: "summaryGetPercentOne", vars: { count: "1", names: "Attar", value: "50%" } },
      // A percentage gift is not "free": the line names what to add.
      { key: "summaryCustomerAdds", vars: { names: "Attar" } },
      { key: "summaryNoLimits" },
      { key: "summaryCombinesBoth" },
      { key: "summaryActiveFrom", vars: { start: "24 Sept 2026" } },
    ]);

    const product = summarizeDraft(draft("products", {
      valueKind: "fixed", value: "2000", appliesTo: { kind: "products", ids: ["prod_Panjabi", "prod_Attar"] },
      minimum: "amount", minimumValue: "2000",
    }), "BDT", FORMAT);
    expect(product).toContainEqual({ key: "summaryOffEachItem", vars: { value: "৳2,000" } });
    expect(product).toContainEqual({ key: "summaryAppliesTo", vars: { names: "Panjabi, Attar" } });
    expect(product).toContainEqual({ key: "summaryMinimumAmount", vars: { value: "৳2,000" } });
  });

  it("describes each discount's value for the list", () => {
    expect(describeValue(draft("products", { value: "10", appliesTo: { kind: "collections", ids: ["a", "b"] } }), "BDT", FORMAT))
      .toEqual({ key: "listValueProducts", vars: { value: "10%", scope: "2 collections" } });
    expect(describeValue(draft("order", { valueKind: "fixed", value: "300" }), "BDT", FORMAT))
      .toEqual({ key: "listValueOrder", vars: { value: "৳300" } });
    expect(describeValue(draft("shipping"), "BDT", FORMAT)).toEqual({ key: "type_shipping" });
    expect(describeValue(draft("buy_get", { buyValue: "2", getQuantity: "1" }), "BDT", FORMAT))
      .toEqual({ key: "listValueBuyGet", vars: { buy: "2", get: "1" } });
  });

  it("warns when a fixed amount off each item is more than every selected product's price", () => {
    const fixed = draft("products", { valueKind: "fixed", value: "2000", appliesTo: { kind: "products", ids: ["a", "b"] } });
    expect(exceedsEveryPrice(fixed, [250, 1500], "BDT")).toBe(true);
    expect(exceedsEveryPrice(fixed, [250, 2500], "BDT")).toBe(false);
    expect(exceedsEveryPrice(fixed, null, "BDT")).toBe(false);
    expect(exceedsEveryPrice({ ...fixed, oncePerOrder: true }, [250], "BDT")).toBe(false);
    expect(exceedsEveryPrice({ ...fixed, valueKind: "percentage", value: "50" }, [250], "BDT")).toBe(false);
  });

  it("bundles free shipping with a minimum checked after the discount", () => {
    const bundle = draft("products", {
      value: "20", appliesTo: { kind: "products", ids: ["prod_1"] }, freeShipping: true, freeShippingMinimum: "1500",
      combines: { product: false, order: true, shipping: true },
    });
    const input = draftToInput(bundle, "BDT");
    expect(input.effects).toEqual([
      expect.objectContaining({ target: "line" }),
      { kind: "free", target: "shipping", allocation: "once", config: {} },
    ]);
    expect(input.conditions).toEqual([
      { kind: "minimum_merchandise_subtotal", config: { amountMinor: 150_000, currencyCode: "BDT", shippingOnly: true } },
    ]);
    // Bundling takes the shipping slot, so "combine with shipping" is off.
    expect(input.combinesWith).toEqual({ product: false, order: true, shipping: false });
    expect(summarizeDraft(bundle, "BDT", FORMAT)).toContainEqual({ key: "summaryPlusFreeShippingOver", vars: { value: "৳1,500" } });
  });

  it("previews stacking with live discounts symmetrically", () => {
    const order = record(draftToInput(draft("order", { method: "automatic", code: "", title: "Eid 10%", value: "10" }), "BDT"));
    const shipping = record(draftToInput(draft("shipping", {
      method: "automatic", code: "", title: "Free delivery", combines: { product: true, order: false, shipping: false },
    }), "BDT"));
    const paused = { ...record(draftToInput(draft("order", { code: "OLD", value: "5" }), "BDT")), id: "promo_old", status: "paused" as const };
    const product = draft("products", { value: "15", appliesTo: { kind: "products", ids: ["p"] }, combines: { product: false, order: true, shipping: false } });
    expect(combinationPreview(product, [
      { ...order, id: "promo_order" }, { ...shipping, id: "promo_ship" }, paused,
    ], undefined)).toEqual([
      { name: "Eid 10%", stacks: true },
      // Set on the other discount only: still stacks.
      { name: "Free delivery", stacks: true },
    ]);
    expect(combinationPreview({ ...product, combines: { product: false, order: false, shipping: false } }, [
      { ...order, id: "promo_order" },
    ], undefined)).toEqual([{ name: "Eid 10%", stacks: false }]);
  });

  it("generates unambiguous codes", () => {
    expect(generateDiscountCode(() => 0)).toBe("AAAAAAAAAA");
    expect(generateDiscountCode()).toMatch(/^[A-HJ-NP-Z2-9]{10}$/u);
  });
});
