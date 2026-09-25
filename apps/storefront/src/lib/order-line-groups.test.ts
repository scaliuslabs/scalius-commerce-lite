import { describe, expect, it } from "vitest";
import {
  BANGLA_CHECKOUT_LANGUAGE_DATA,
  ENGLISH_CHECKOUT_LANGUAGE_DATA,
} from "@scalius/shared/checkout-language";
import type { FulfillmentType } from "@scalius/shared/fulfilment";
import type { CustomerOrderProgress } from "./api/customer-auth";
import type { OrderLineProperty } from "./api/types";
import {
  groupOrderLines,
  orderCompletionWording,
  orderLineGroupStatusText,
  orderLinePropertyRows,
  relabelOrderProgress,
  relabelOrderTimeline,
  resolveOrderDeliveryBlock,
  showsOrderLineGroupHeadings,
  withOrderCompletionWording,
  type OrderFulfilmentView,
} from "./order-line-groups";

const copy = { ...ENGLISH_CHECKOUT_LANGUAGE_DATA };

function line(fulfillmentType: FulfillmentType | undefined, quantity = 1, fulfilledQuantity = 0, name = "x") {
  return { name, quantity, fulfilledQuantity, ...(fulfillmentType ? { fulfillmentType } : {}) };
}

const shipOrder: OrderFulfilmentView = {
  status: "confirmed",
  requiresShipping: true,
  shippingMethodKind: "delivery",
  pickup: null,
  shippingAddress: "House 1, Road 2",
};
const pickupOrder: OrderFulfilmentView = {
  status: "confirmed",
  requiresShipping: false,
  shippingMethodKind: "pickup",
  pickup: { address: "Gulshan store, Road 11", hours: "10am–8pm", readyAt: null },
  shippingAddress: null,
};
const serviceOrder: OrderFulfilmentView = {
  status: "confirmed",
  requiresShipping: false,
  shippingMethodKind: null,
  pickup: null,
  shippingAddress: null,
};

function property(overrides: Partial<OrderLineProperty> = {}): OrderLineProperty {
  return { key: "engraving", type: "text", label: "Engraving", value: "Anika", displayValue: "Anika", price: 0, priceMinor: 0, ...overrides };
}

describe("groupOrderLines", () => {
  it("groups in the stable ship, pickup, service, digital, gift card order and keeps line order inside a group", () => {
    const groups = groupOrderLines([
      line("gift_card", 1, 0, "card"),
      line("service", 1, 0, "fitting"),
      line("digital", 1, 0, "ebook"),
      line("ship", 1, 0, "tee"),
      line("ship", 2, 0, "cap"),
    ], shipOrder, copy);
    expect(groups.map((group) => group.type)).toEqual(["ship", "service", "digital", "gift_card"]);
    expect(groups.map((group) => group.heading)).toEqual(["Delivery", "Services", "Digital items", "Gift cards"]);
    expect(groups[0]!.items.map((item) => item.name)).toEqual(["tee", "cap"]);
    expect(showsOrderLineGroupHeadings(groups)).toBe(true);
  });

  it("counts lines without a fulfilment type as shipped and keeps today's look for one shipping group", () => {
    const groups = groupOrderLines([line(undefined, 2), line("ship", 1)], shipOrder, copy);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe("ship");
    expect(groups[0]!.items).toHaveLength(2);
    expect(showsOrderLineGroupHeadings(groups)).toBe(false);
    expect(showsOrderLineGroupHeadings(groupOrderLines([line("pickup")], pickupOrder, copy))).toBe(true);
    expect(groupOrderLines([], shipOrder, copy)).toEqual([]);
  });

  it("says where shipped lines are: preparing, partly sent, sent, delivered", () => {
    const status = (items: ReturnType<typeof line>[], order = shipOrder) =>
      orderLineGroupStatusText(groupOrderLines(items, order, copy)[0]!);
    expect(status([line("ship", 3, 0)])).toBe("Preparing");
    expect(status([line("ship", 2, 1), line("ship", 1, 0)])).toBe("Preparing · 1 of 3");
    expect(status([line("ship", 2, 2), line("ship", 1, 1)])).toBe("Sent");
    // Pre-ledger shipped order: no fulfilled units recorded.
    expect(status([line("ship", 1, 0)], { ...shipOrder, status: "shipped" })).toBe("Sent");
    expect(status([line("ship", 1, 1)], { ...shipOrder, status: "delivered" })).toBe("Delivered");
    expect(status([line("ship", 1, 0)], { ...shipOrder, status: "completed" })).toBe("Delivered");
  });

  it("says where pickup lines are: preparing, ready once readyAt is set, picked up when every unit is handed over", () => {
    const status = (items: ReturnType<typeof line>[], order = pickupOrder) =>
      orderLineGroupStatusText(groupOrderLines(items, order, copy)[0]!);
    expect(status([line("pickup", 2, 0)])).toBe("Preparing");
    const ready = { ...pickupOrder, pickup: { ...pickupOrder.pickup!, readyAt: "2026-09-25T04:00:00.000Z" } };
    expect(status([line("pickup", 2, 0)], ready)).toBe("Ready for pickup");
    expect(status([line("pickup", 2, 1)], ready)).toBe("Ready for pickup · 1 of 2");
    expect(status([line("pickup", 2, 2)], ready)).toBe("Picked up");
    expect(status([line("pickup", 2, 0)], { ...ready, status: "delivered" })).toBe("Picked up");
  });

  it("says services are preparing until performed, and gives digital items and gift cards a heading only", () => {
    const groups = groupOrderLines([line("service", 2, 1), line("digital"), line("gift_card")], serviceOrder, copy);
    expect(groups.map(orderLineGroupStatusText)).toEqual(["Preparing · 1 of 2", "", ""]);
    const done = groupOrderLines([line("service", 2, 2)], serviceOrder, copy);
    expect(orderLineGroupStatusText(done[0]!)).toBe("Service done");
  });

  it("shows no line status on an order that is not going anywhere", () => {
    for (const status of ["cancelled", "refunded", "returned", "failed", "incomplete"]) {
      const [group] = groupOrderLines([line("ship", 2, 1)], { ...shipOrder, status }, copy);
      expect(group!.statusLabel).toBeNull();
      expect(group!.progressLabel).toBeNull();
    }
  });

  it("uses the store's language", () => {
    const [group] = groupOrderLines([line("pickup", 3, 1)], pickupOrder, { ...BANGLA_CHECKOUT_LANGUAGE_DATA });
    expect(group!.heading).toBe("সংগ্রহ");
    expect(orderLineGroupStatusText(group!)).toBe("প্রস্তুত হচ্ছে · 3টির মধ্যে 1টি");
  });
});

describe("orderLinePropertyRows", () => {
  const money = (value: OrderLineProperty) => `৳${value.price}`;

  it("renders one Label: value row per input, with the surcharge only when priceMinor > 0", () => {
    const rows = orderLinePropertyRows([
      property({ priceMinor: 20_000, price: 200 }),
      property({ key: "gift_wrap", type: "checkbox", label: "Gift wrap", value: "true", displayValue: "Yes" }),
      property({ key: "size_note", type: "select", label: "Fit", value: "slim", displayValue: "Slim fit", price: 50, priceMinor: 0 }),
    ], money, copy);
    expect(rows.map((row) => row.text)).toEqual([
      "Engraving: Anika (+৳200)",
      "Gift wrap: Yes",
      "Fit: Slim fit",
    ]);
    expect(rows[0]!.surcharge).toBe("+৳200");
    expect(rows[1]!.surcharge).toBeNull();
  });

  it("skips blank inputs and tolerates missing properties", () => {
    expect(orderLinePropertyRows(undefined, money, copy)).toEqual([]);
    expect(orderLinePropertyRows(null, money, copy)).toEqual([]);
    expect(orderLinePropertyRows([property({ displayValue: "  ", value: "" })], money, copy)).toEqual([]);
    expect(orderLinePropertyRows([property({ label: "" })], money, copy)).toEqual([]);
  });

  it("keeps markup-looking text as plain text for the caller to escape", () => {
    const [row] = orderLinePropertyRows([property({ displayValue: "<b>Anika</b>" })], money, copy);
    expect(row!.value).toBe("<b>Anika</b>");
  });
});

describe("resolveOrderDeliveryBlock", () => {
  it("keeps the address for shipping orders", () => {
    expect(resolveOrderDeliveryBlock(shipOrder, copy)).toEqual({ mode: "ship", address: "House 1, Road 2" });
    // Pre-Wave-A orders carry no delivery facts: they shipped.
    expect(resolveOrderDeliveryBlock({ status: "confirmed", shippingAddress: "House 9" }, copy)).toEqual({ mode: "ship", address: "House 9" });
  });

  it("replaces a null address with the pickup facts on a pickup receipt", () => {
    expect(resolveOrderDeliveryBlock(pickupOrder, copy)).toEqual({
      mode: "pickup",
      heading: "Pickup",
      location: "Pick up at Gulshan store, Road 11",
      hoursLabel: "Hours",
      hours: "10am–8pm",
      notReady: "We'll let you know when your order is ready to collect.",
    });
    const ready = resolveOrderDeliveryBlock({ ...pickupOrder, pickup: { ...pickupOrder.pickup!, readyAt: "2026-09-25T04:00:00.000Z" } }, copy);
    expect(ready).toMatchObject({ location: "Ready for pickup at Gulshan store, Road 11", notReady: null });
    const collected = resolveOrderDeliveryBlock({ ...pickupOrder, status: "delivered" }, copy);
    expect(collected).toMatchObject({ location: "Pick up at Gulshan store, Road 11", notReady: null });
    const bare = resolveOrderDeliveryBlock({ ...pickupOrder, pickup: null }, copy);
    expect(bare).toMatchObject({ location: null, hours: null });
    for (const block of [ready, collected, bare]) {
      expect(Object.values(block).filter((value) => typeof value === "string").join(" ")).not.toMatch(/null|undefined/);
    }
  });

  it("says no delivery is needed for a service-only receipt", () => {
    expect(resolveOrderDeliveryBlock(serviceOrder, copy)).toEqual({ mode: "none", text: "No delivery needed" });
  });
});

describe("finished-order wording", () => {
  const progress: CustomerOrderProgress = {
    steps: [
      { key: "placed", label: "Order placed", done: true, happenedAt: "2026-09-24T00:00:00.000Z" },
      { key: "confirmed", label: "Confirmed", done: true, happenedAt: "2026-09-24T01:00:00.000Z" },
      { key: "shipped", label: "On its way", done: false, happenedAt: null },
      { key: "delivered", label: "Delivered", done: false, happenedAt: null },
    ],
    outcome: null,
  };

  it("says Picked up or Completed instead of Delivered only for non-shipping orders", () => {
    expect(orderCompletionWording({ ...shipOrder, status: "delivered" }, copy)).toBeNull();
    expect(orderCompletionWording({ ...pickupOrder, status: "confirmed" }, copy)).toBeNull();
    expect(orderCompletionWording({ ...pickupOrder, status: "delivered" }, copy)).toEqual({
      statusLabel: "Picked up",
      title: "Order picked up",
      messageTemplate: "Order #{orderId} has been picked up.",
    });
    expect(orderCompletionWording({ ...serviceOrder, status: "completed" }, copy)).toMatchObject({
      statusLabel: "Completed",
      messageTemplate: "Order #{orderId} is complete.",
    });
  });

  it("rewrites the receipt view for a picked-up order and leaves refund wording alone", () => {
    const view = { kind: "order_updated", title: "Order delivered", message: "Order #1001 has been delivered.", orderStatusLabel: "Delivered" };
    const order = { ...pickupOrder, status: "delivered", id: "ord_1", orderNumber: 1001, paymentStatus: "paid" };
    expect(withOrderCompletionWording(view, order, copy)).toEqual({
      kind: "order_updated",
      title: "Order picked up",
      message: "Order #1001 has been picked up.",
      orderStatusLabel: "Picked up",
    });
    const refunded = withOrderCompletionWording({ ...view, title: "Refunded" }, { ...order, paymentStatus: "refunded" }, copy);
    expect(refunded).toMatchObject({ title: "Refunded", orderStatusLabel: "Picked up" });
    const serviceView = withOrderCompletionWording(view, { ...serviceOrder, status: "delivered", id: "ord_2", orderNumber: 1002, paymentStatus: "paid" }, copy);
    expect(serviceView).toMatchObject({ title: "Order completed", message: "Order #1002 is complete.", orderStatusLabel: "Completed" });
    expect(withOrderCompletionWording(view, { ...shipOrder, status: "delivered", id: "ord_3", paymentStatus: "paid" }, copy)).toBe(view);
  });

  it("tracks a pickup order as ready for pickup, then picked up", () => {
    const readyAt = "2026-09-25T04:00:00.000Z";
    const relabelled = relabelOrderProgress(progress, { ...pickupOrder, pickup: { ...pickupOrder.pickup!, readyAt } }, copy);
    expect(relabelled.steps.map((step) => [step.label, step.done])).toEqual([
      ["Order placed", true], ["Confirmed", true], ["Ready for pickup", true], ["Picked up", false],
    ]);
    expect(relabelled.steps[2]!.happenedAt).toBe(readyAt);
    expect(relabelOrderProgress(progress, pickupOrder, copy).steps[2]).toMatchObject({ label: "Ready for pickup", done: false });
  });

  it("tracks a no-delivery order as preparing, then completed, and leaves shipping orders alone", () => {
    expect(relabelOrderProgress(progress, serviceOrder, copy).steps.map((step) => [step.label, step.done])).toEqual([
      ["Order placed", true], ["Confirmed", true], ["Preparing", true], ["Completed", false],
    ]);
    expect(relabelOrderProgress(progress, shipOrder, copy)).toBe(progress);
    const timeline = [
      { id: "d", type: "order" as const, status: "delivered", label: "Delivered", happenedAt: null },
      { id: "p", type: "payment" as const, status: "delivered", label: "Payment received", happenedAt: null },
    ];
    expect(relabelOrderTimeline(timeline, pickupOrder, copy).map((event) => event.label)).toEqual(["Picked up", "Payment received"]);
    expect(relabelOrderTimeline(timeline, serviceOrder, copy)[0]!.label).toBe("Completed");
    expect(relabelOrderTimeline(timeline, shipOrder, copy)[0]!.label).toBe("Delivered");
  });
});
