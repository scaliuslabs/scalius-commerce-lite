// Unit tests for acme.bulk-discount with the SDK's harness: the same
// runtime as the platform over an in-memory bridge.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import bulk, { tiersFrom } from "./index";

function line(lineId: string, quantity: number, unitPriceMinor = 10_000) {
  return {
    lineId, productId: `p_${lineId}`, variantId: `v_${lineId}`, sku: null, title: lineId, quantity,
    unitPriceMinor, lineTotalMinor: unitPriceMinor * quantity, categoryIds: [], collectionIds: [], brandId: null, properties: {},
  };
}

function cart(lines: ReturnType<typeof line>[], discountCodes: string[] = []) {
  return {
    currency: "BDT",
    decimalPlaces: 2,
    channel: "online_store" as const,
    lines,
    subtotalMinor: lines.reduce((total, entry) => total + entry.lineTotalMinor, 0),
    customer: null,
    destination: null,
    discountCodes,
    market: { id: "mkt_backup", country: null },
    attributes: {},
  };
}

describe("acme.bulk-discount", () => {
  it("reads its tiers from settings, highest quantity first, skipping 0% tiers", () => {
    expect(tiersFrom({ tier1_quantity: 3, tier1_percent: 5, tier2_quantity: 6, tier2_percent: 10, tier3_quantity: 12, tier3_percent: 0 }))
      .toEqual([{ quantity: 6, percent: 10 }, { quantity: 3, percent: 5 }]);
  });

  it("per item: each line gets the tier its own quantity reached, one discount per tier", async () => {
    const harness = createPluginTestHarness(bulk);
    const result = await harness.fn("checkout.discounts", { cart: cart([line("a", 2), line("b", 3), line("c", 7), line("d", 4)]) });
    expect(result.value).toEqual({
      discounts: [
        { title: "Bulk savings (10% off)", target: { kind: "lines", lineIds: ["c"] }, value: { type: "percentage", percent: 10 } },
        { title: "Bulk savings (5% off)", target: { kind: "lines", lineIds: ["b", "d"] }, value: { type: "percentage", percent: 5 } },
      ],
    });
  });

  it("across the cart: one order discount from the total quantity, capped in minor units", async () => {
    const harness = createPluginTestHarness(bulk, { settings: { count_by: "cart", max_discount: 250, title: "Wholesale" } });
    expect((await harness.fn("checkout.discounts", { cart: cart([line("a", 2), line("b", 2)]) })).value).toEqual({
      discounts: [{ title: "Wholesale (5% off)", target: { kind: "order" }, value: { type: "percentage", percent: 5 }, maxAmountMinor: 25_000 }],
    });
    expect((await harness.fn("checkout.discounts", { cart: cart([line("a", 1), line("b", 1)]) })).value).toEqual({ discounts: [] });
  });

  it("with a code: only when the buyer entered it, and the discount answers to it", async () => {
    const harness = createPluginTestHarness(bulk, { settings: { code: "bulk10", count_by: "cart" } });
    expect((await harness.fn("checkout.discounts", { cart: cart([line("a", 3)]) })).value).toEqual({ discounts: [] });
    expect((await harness.fn("checkout.discounts", { cart: cart([line("a", 3)], ["BULK10"]) })).value).toEqual({
      discounts: [{ title: "Bulk savings (5% off)", code: "BULK10", target: { kind: "order" }, value: { type: "percentage", percent: 5 } }],
    });
  });

  it("blocks a line over the per-item limit, on that line, with the merchant's message", async () => {
    const off = createPluginTestHarness(bulk);
    expect((await off.fn("cart.validate", { cart: cart([line("a", 50)]) })).value).toEqual({ errors: [] });
    const harness = createPluginTestHarness(bulk, { settings: { max_quantity_per_line: 10 } });
    expect((await harness.fn("cart.validate", { cart: cart([line("a", 10), line("b", 11)]) })).value).toEqual({
      errors: [{ code: "max_quantity", message: "You can buy at most 10 of this item in one order.", lineId: "b" }],
    });
  });
});
