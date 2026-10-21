// The marketplace splitter over the SDK harness: splits per seller from
// `orders.get`, then moves units from line facts only; redeliveries change
// nothing, a voided fulfilment puts units back and a partial refund is held
// for review instead of guessed.
import { describe, expect, it } from "vitest";
import { createPluginTestHarness, fixtures } from "@scalius/plugin-sdk/testing";
import marketplace, { payableMinor, type Split } from "./index";

const order = {
  id: "ord_1",
  currency: "BDT",
  lines: [
    { id: "item_lamp", productId: "p_lamp", quantity: 2, subtotalMinor: 300000, discountMinor: 0 },
    { id: "item_rug", productId: "p_rug", quantity: 1, subtotalMinor: 90000, discountMinor: 10000 },
  ],
};
const api = async (operationId: string) => operationId === "orders.get"
  ? { ok: true, status: 200, data: { order }, error: null }
  : { ok: false, status: 404, data: null, error: { code: "not_found", message: "unknown" } };

function harnessWithListings() {
  const harness = createPluginTestHarness(marketplace, { api });
  harness.records.get("listings")!.set("p_lamp", { seller_id: "seller_a" });
  harness.records.get("listings")!.set("p_rug", { seller_id: "seller_b" });
  return harness;
}
const split = (harness: ReturnType<typeof harnessWithListings>, seller: string) =>
  harness.records.get("splits")!.get(`ord_1:${seller}`) as Split;

describe("acme.marketplace", () => {
  it("splits per seller and moves units from fulfilment and refund line facts, once per event", async () => {
    const harness = harnessWithListings();
    const created = fixtures.event("order.created", { id: "evt_1", resource: { type: "order", id: "ord_1" } });
    expect(await harness.deliver(created)).toMatchObject({ ok: true });
    expect(await harness.deliver(created)).toMatchObject({ ok: true });
    expect(split(harness, "seller_a").lines).toEqual({ item_lamp: { ordered: 2, fulfilled: 0, refunded: 0, unitMinor: 150000 } });
    expect(split(harness, "seller_b").lines).toEqual({ item_rug: { ordered: 1, fulfilled: 0, refunded: 0, unitMinor: 80000 } });

    const shipped = fixtures.event("fulfillment.created", {
      id: "evt_2",
      facts: { fulfillmentId: "ful_1", orderId: "ord_1", kind: "ship", locationId: null, lines: [{ orderItemId: "item_lamp", variantId: "v_lamp", quantity: 2 }] },
    });
    expect(await harness.deliver(shipped)).toMatchObject({ ok: true });
    expect(await harness.deliver(shipped)).toMatchObject({ ok: true });
    expect(split(harness, "seller_a").lines.item_lamp).toMatchObject({ fulfilled: 2 });
    expect(payableMinor(split(harness, "seller_a"))).toBe(300000);

    expect(await harness.deliver(fixtures.event("fulfillment.voided", {
      id: "evt_3",
      facts: { fulfillmentId: "ful_1", orderId: "ord_1", kind: "ship", locationId: null, lines: [{ orderItemId: "item_lamp", variantId: "v_lamp", quantity: 1 }] },
    }))).toMatchObject({ ok: true });
    expect(split(harness, "seller_a").lines.item_lamp).toMatchObject({ fulfilled: 1 });

    expect(await harness.deliver(fixtures.event("refund.updated", {
      id: "evt_4",
      facts: { refundId: "ref_1", orderId: "ord_1", previousStatus: "pending", status: "refunded", lines: [{ orderItemId: "item_rug", variantId: "v_rug", quantity: 1 }] },
    }))).toMatchObject({ ok: true });
    expect(split(harness, "seller_b").lines.item_rug).toMatchObject({ refunded: 1 });
    expect(split(harness, "seller_a").lines.item_lamp).toMatchObject({ fulfilled: 1, refunded: 0 });

    // A refund some of whose payments failed: held for review, units unchanged.
    expect(await harness.deliver(fixtures.event("refund.updated", {
      id: "evt_5",
      facts: { refundId: "ref_2", orderId: "ord_1", previousStatus: "pending", status: "partial", lines: [{ orderItemId: "item_lamp", variantId: "v_lamp", quantity: 1 }] },
    }))).toMatchObject({ ok: true });
    expect(split(harness, "seller_a")).toMatchObject({ review: true, lines: { item_lamp: { fulfilled: 1, refunded: 0 } } });
    expect(split(harness, "seller_b").review).toBe(false);
  });
});
