import { describe, expect, it } from "vitest";
import type { PriceListVariant } from "~/lib/api-query-options/price-lists";
import { EMPTY_PRICE_LIST_FORM, samePriceListForm, rebasePriceListForm, canAddBreak, gridChanges, gridRow, gridRowProblem, newGridRow, nextBreak, type GridRow } from "./price-list-form";

const saved: PriceListVariant = {
  variantId: "var_a",
  productId: "prod_a",
  productName: "Tee",
  variantLabel: "M",
  sku: "TEE-M",
  basePrice: 500,
  prices: [
    { currencyCode: "BDT", amount: 380, compareAt: null, minQuantity: 10 },
    { currencyCode: "BDT", amount: 450, compareAt: 520, minQuantity: 1 },
  ],
};

describe("price grid rows", () => {
  it("reads a SKU's price, compare-at price and breaks, and saves only what changed", () => {
    const row = gridRow(saved);
    expect(row).toMatchObject({ amount: 450, compareAt: 520, breaks: [{ minQuantity: 10, amount: 380 }] });
    expect(gridRowProblem(row)).toBeNull();
    const added = newGridRow({ id: "var_b", productName: "Cap", optionLabel: null, sku: "CAP", price: 300 });
    expect(gridChanges([row], [row, added], [], 4)).toEqual({
      expectedRevision: 4,
      set: [{ variantId: "var_b", prices: [{ amount: 300, compareAt: null, minQuantity: 1 }] }],
      remove: [],
    });
    const cheaper: GridRow = { ...row, amount: 440 };
    expect(gridChanges([row], [cheaper], ["var_a", "var_unknown"], 4)).toEqual({
      expectedRevision: 4,
      set: [{ variantId: "var_a", prices: [{ amount: 440, compareAt: 520, minQuantity: 1 }, { amount: 380, minQuantity: 10 }] }],
      remove: ["var_a"],
    });
  });

  it("names the first problem of a row", () => {
    const row = gridRow(saved);
    expect(gridRowProblem({ ...row, amount: null })).toBe("priceRequired");
    expect(gridRowProblem({ ...row, amount: Number.NaN })).toBe("priceRequired");
    expect(gridRowProblem({ ...row, compareAt: 450 })).toBe("compareAtAbove");
    expect(gridRowProblem({ ...row, breaks: [{ key: "x", minQuantity: 1, amount: 100 }] })).toBe("breakQuantity");
    expect(gridRowProblem({ ...row, breaks: [...row.breaks, { key: "y", minQuantity: 10, amount: 300 }] })).toBe("breakDuplicate");
    expect(gridRowProblem({ ...row, breaks: [nextBreak(row)] })).toBe("breakPriceRequired");
  });

  it("offers at most four breaks, each from twice the largest so far", () => {
    const row = gridRow(saved);
    expect(nextBreak(row).minQuantity).toBe(20);
    const full = { ...row, breaks: [2, 5, 10, 20].map((minQuantity) => ({ key: String(minQuantity), minQuantity, amount: 100 })) };
    expect(canAddBreak(row)).toBe(true);
    expect(canAddBreak(full)).toBe(false);
  });
});

describe("price list draft acknowledgement", () => {
  it("compares save normalization and keeps invalid dates distinct", () => {
    const base = { ...EMPTY_PRICE_LIST_FORM, name: "Sale", priority: "5", startDate: "2026-10-13", startTime: "00:00" };
    expect(samePriceListForm(base, { ...base, name: " Sale ", priority: "৫", startTime: "" })).toBe(true);
    expect(samePriceListForm({ ...base, priority: "0" }, { ...base, priority: "" })).toBe(false);
    expect(samePriceListForm({ ...base, startDate: "" }, { ...base, startDate: "2026-02-30" })).toBe(false);
  });
  it("keeps an in-flight date edit together with its original time", () => {
    const base = { ...EMPTY_PRICE_LIST_FORM, startDate: "2026-10-13", startTime: "10:00" };
    const current = { ...base, startDate: "2026-10-14" };
    const ack = { ...base, name: "Saved", startTime: "12:00" };
    expect(rebasePriceListForm(current, base, ack)).toMatchObject({ name: "Saved", startDate: "2026-10-14", startTime: "10:00" });
  });
});
