// Unit tests for acme.loyalty with the SDK's harness (the same runtime as
// the platform over an in-memory bridge): redemption from the declared read
// of the buyer's balance with the balance committed with the order, and earning once per paid order even
// when events are redelivered or race.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import loyalty, { pointsEarned, pointValueMinor } from "./index";

function cart(options: { codes?: string[]; signedIn?: boolean; itemsMinor?: number } = {}) {
  const itemsMinor = options.itemsMinor ?? 120_000;
  return {
    currency: "BDT",
    decimalPlaces: 2,
    channel: "online_store" as const,
    lines: [{
      lineId: "l1", productId: "p1", variantId: "v1", sku: null, title: "Tea", quantity: 1,
      unitPriceMinor: itemsMinor, lineTotalMinor: itemsMinor, categoryIds: [], collectionIds: [], brandId: null, properties: {},
    }],
    subtotalMinor: itemsMinor,
    customer: options.signedIn === false ? null : { id: "cust_1", tags: [], orderCount: 2, totalSpentMinor: 0 },
    destination: null,
    discountCodes: options.codes ?? ["points"],
    market: { id: "mkt_backup", country: null },
    attributes: {},
  };
}

const balance = (points: number, revision = 4) => ({ balance: { revision, data: { points, earned: points, spent: 0 } } });
const noBalance = { balance: null };

describe("acme.loyalty", () => {
  const buyer = {
    target: "checkout.actions.before" as const, language: "en", locale: "en-BD", currency: "BDT",
    cart: cart({ codes: [] }), attributes: {}, order: null, customer: { id: "cust_1" }, reads: balance(300),
  };

  it("shows the read balance and redeems through the existing checkout discount code", async () => {
    const harness = createPluginTestHarness(loyalty);
    expect((await harness.fn("buyer.ui", buyer)).value).toEqual({ ui: { version: 1, root: { type: "stack", children: [
      { type: "key-value", items: [{ label: "Loyalty points", value: "300" }] },
      { type: "button", label: "Redeem points", action: { kind: "cart", op: "apply_code", code: "POINTS" } },
    ] } } });
    const result = await harness.fn("checkout.discounts", { cart: cart({ codes: ["POINTS"] }), reads: buyer.reads });
    expect(result.value).toMatchObject({ commit: [{ as: "balance", record: { points: 0, spent: 300 } }] });
    expect(harness.records.get("balances")!.size).toBe(0);
  });

  it("omits redemption for guests, account pages, missing balances, and an already-applied code", async () => {
    const harness = createPluginTestHarness(loyalty);
    expect((await harness.fn("buyer.ui", { ...buyer, customer: null, reads: noBalance })).value).toEqual({ ui: null });
    for (const input of [
      { ...buyer, target: "account.overview" as const, cart: null },
      { ...buyer, reads: noBalance },
      { ...buyer, reads: balance(49) },
      { ...buyer, cart: cart({ codes: ["points"] }) },
    ]) {
      const result = await harness.fn("buyer.ui", input);
      expect(result.ok).toBe(true);
      expect(result.value).toMatchObject({ ui: { root: { type: "stack", children: [{ type: "key-value" }] } } });
      expect((result.value as { ui: { root: { children: unknown[] } } }).ui.root.children).toHaveLength(1);
    }
  });

  it("prices points in minor units and earns per 100 spent", () => {
    expect(pointValueMinor({ point_value: 1 }, 2)).toBe(100);
    expect(pointValueMinor({ point_value: 0.5 }, 0)).toBe(1);
    expect(pointsEarned(250_000, { points_per_100: 2 }, 2)).toBe(50);
    expect(pointsEarned(9_999, { points_per_100: 1 }, 2)).toBe(0);
  });

  it("redeems with the code: a discount worth the points spent and the reduced balance to commit", async () => {
    const harness = createPluginTestHarness(loyalty);
    const result = await harness.fn("checkout.discounts", { cart: cart(), reads: balance(300) });
    expect(result.value).toEqual({
      discounts: [{
        title: "Loyalty points (300 points)",
        code: "POINTS",
        target: { kind: "order" },
        value: { type: "fixed_amount", amountMinor: 30_000 },
        maxAmountMinor: 30_000,
      }],
      commit: [{ as: "balance", record: { points: 0, earned: 300, spent: 300 } }],
    });
  });

  it("spends no more than the items are worth", async () => {
    const harness = createPluginTestHarness(loyalty);
    const result = await harness.fn("checkout.discounts", { cart: cart({ itemsMinor: 8_050 }), reads: balance(500) });
    expect(result.value).toMatchObject({
      discounts: [{ value: { type: "fixed_amount", amountMinor: 8_000 } }],
      commit: [{ as: "balance", record: { points: 420, spent: 80 } }],
    });
  });

  it("offers nothing without the code, to a guest, without a balance, or below the minimum", async () => {
    const harness = createPluginTestHarness(loyalty);
    for (const input of [
      { cart: cart({ codes: [] }), reads: balance(300) },
      { cart: cart({ signedIn: false }), reads: balance(300) },
      { cart: cart(), reads: noBalance },
      { cart: cart(), reads: balance(49) },
    ]) {
      expect((await harness.fn("checkout.discounts", input)).value).toEqual({ discounts: [] });
    }
  });

  it("earns once per paid order for an account, however often the event arrives", async () => {
    // The orders as dashboard.resources.orders.get returns them (minor units).
    const orders: Record<string, { id: string; currency: string; totalMinor: number; customerId: string; accountCustomerId: string | null }> = {
      o1: { id: "o1", currency: "BDT", totalMinor: 125_000, customerId: "cust_1", accountCustomerId: "cust_1" },
      o2: { id: "o2", currency: "BDT", totalMinor: 50_000, customerId: "cust_1", accountCustomerId: "cust_1" },
      o3: { id: "o3", currency: "BDT", totalMinor: 90_000, customerId: "guest_1", accountCustomerId: null },
    };
    const harness = createPluginTestHarness(loyalty, {
      api: async (operationId, input) => {
        expect(operationId).toBe("dashboard.resources.orders.get");
        const order = orders[String(input?.path?.id)];
        return order ? { ok: true, status: 200, data: order, error: null } : { ok: false, status: 404, data: null, error: { code: "NOT_FOUND", message: "Not found" } };
      },
    });
    const paid = (orderId: string) => harness.event("order.paid", { type: "order", id: orderId }, { orderId }, { id: `evt_${orderId}` });
    // Two different orders race; the first is redelivered.
    const results = await Promise.all([paid("o1"), paid("o2"), paid("o1")]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await paid("o3")).ok).toBe(true);
    expect(harness.records.get("balances")!.get("cust_1")).toEqual({ points: 17, earned: 17, spent: 0 });
    expect([...harness.records.get("ledger")!.keys()].sort()).toEqual(["earn:o1", "earn:o2"]);
    expect(harness.records.get("balances")!.has("guest_1")).toBe(false);
  });
});
