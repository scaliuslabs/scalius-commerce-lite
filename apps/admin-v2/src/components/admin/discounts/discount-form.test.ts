import { describe, expect, it } from "vitest";

import {
  combinationPreview,
  draftFromDiscount,
  draftToInput,
  emptyDraft,
  epochToStoreTime,
  generateDiscountCode,
  storeTimeToEpoch,
  summarizeDraft,
  validateDraft,
  type DiscountDraft,
} from "./discount-form";
import type { DiscountRecord } from "~/lib/api-query-options/discounts";

const NOW = Date.UTC(2026, 8, 24, 6, 0); // 12:00 in Dhaka

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
    expect(storeTimeToEpoch("2026-09-24", "12:00")).toBe(NOW / 1_000);
    expect(epochToStoreTime(NOW / 1_000)).toEqual({ date: "2026-09-24", time: "12:00" });
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
      expect(validateDraft(original, "BDT")).toEqual({});
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
    expect(validateDraft(draft("products", { code: "", value: "0", endDate: "" }), "BDT")).toEqual({
      code: "errorCodeRequired",
      value: "errorPercent",
      appliesTo: "errorPickItems",
    });
    expect(validateDraft(draft("buy_get", { buyValue: "x", getQuantity: "0", getValueKind: "percentage", getValue: "101" }), "BDT"))
      .toMatchObject({ buyValue: "errorQuantity", buyScope: "errorPickItems", getQuantity: "errorQuantity", getScope: "errorPickItems", getValue: "errorPercent" });
    expect(validateDraft(draft("order", { value: "5", hasEnd: true, endDate: "2026-09-24", endTime: "11:00" }), "BDT"))
      .toEqual({ endDate: "errorEndBeforeStart" });
    expect(validateDraft(draft("order", { value: "5", valueKind: "fixed" }), "JPY")).toEqual({});
    expect(validateDraft(draft("order", { value: "5.5", valueKind: "fixed" }), "JPY")).toEqual({ value: "errorAmount" });
  });

  it("summarizes the consequence in the merchant's words", () => {
    const lines = summarizeDraft(draft("buy_get", {
      buyValue: "2", getQuantity: "1", getScope: { kind: "collections", ids: ["col"] }, combines: { product: false, order: true, shipping: true },
    }), { money: (value) => `৳${value}`, date: () => "24 Sept 2026" });
    expect(lines.map(({ key }) => key)).toEqual([
      "summaryBuyQuantity", "summaryGetFreeOne", "summaryCustomerAdds", "summaryNoLimits", "summaryCombinesBoth", "summaryActiveFrom",
    ]);
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
    const lines = summarizeDraft(bundle, { money: (value) => `৳${value}`, date: () => "today" });
    expect(lines).toContainEqual({ key: "summaryPlusFreeShippingOver", vars: { value: "৳1500" } });
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
