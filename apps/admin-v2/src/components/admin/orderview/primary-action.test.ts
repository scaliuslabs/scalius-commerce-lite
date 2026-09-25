import { describe, expect, it } from "vitest";
import { resolveOrderPrimaryAction, unitsLeftToSend } from "./primary-action";
import type { Order } from "./types";

const all = { canChangeOrderStatus: true, canManageOrderShipments: true, canUpdateOrderCod: true };
const item = {
  id: "item_1", productId: "p1", variantId: null, quantity: 1, price: 500,
  productName: "Shirt", productImage: null, variantLabel: null,
  fulfillmentType: "ship" as const, fulfilledQuantity: 0,
};
const base = {
  id: "ord_1", version: 1, status: "pending", paymentMethod: "cod", paymentStatus: "unpaid",
  paidAmount: 0, balanceDue: 500, items: [item], shipments: [], fulfillmentStatus: "pending",
} as unknown as Order;
const order = (overrides: Partial<Order>): Order => ({ ...base, ...overrides });
const courier = { id: "prov_1", name: "Pathao", type: "pathao", isActive: true } as NonNullable<Order["deliveryProviders"]>[number];

describe("order primary phone action", () => {
  it("confirms pending and processing orders", () => {
    expect(resolveOrderPrimaryAction(order({ status: "pending" }), all)).toBe("confirm");
    expect(resolveOrderPrimaryAction(order({ status: "processing" }), all)).toBe("confirm");
    expect(resolveOrderPrimaryAction(order({ status: "pending" }), { ...all, canChangeOrderStatus: false })).toBeNull();
  });

  it("sends with your own rider when no courier is connected", () => {
    expect(resolveOrderPrimaryAction(order({ status: "confirmed" }), all)).toBe("sendOwnCourier");
  });

  it("waits for the courier list before choosing how to send", () => {
    const loading = order({
      status: "confirmed",
      operationalReads: {
        shipments: { status: "ready", refreshing: false },
        deliveryProviders: { status: "loading", refreshing: false },
      },
    });
    expect(resolveOrderPrimaryAction(loading, all)).toBeNull();
  });

  it("keeps sending the rest of a partly sent order as the next step", () => {
    const partlySent = order({
      status: "shipped",
      items: [{ ...item, quantity: 4, fulfilledQuantity: 2 }],
      shipments: [{ id: "s1", orderId: "ord_1", providerId: null, providerType: "manual", externalId: null, trackingId: null, status: "in_transit", rawStatus: null, createdAt: 1 }],
    });
    expect(resolveOrderPrimaryAction(partlySent, all)).toBe("sendOwnCourier");
    expect(unitsLeftToSend(partlySent)).toBe(2);
    // Nothing sent yet, or everything sent: the usual steps.
    expect(unitsLeftToSend(order({ status: "confirmed" }))).toBe(0);
    expect(resolveOrderPrimaryAction(order({ ...partlySent, items: [{ ...item, quantity: 4, fulfilledQuantity: 4 }] }), all)).toBe("collectCod");
  });

  it("puts an open cancellation request first", () => {
    const requested = order({
      status: "pending",
      supportRequests: [{ id: "req_1", type: "cancel_pre_shipment", active: true, status: "submitted" }] as Order["supportRequests"],
    });
    expect(resolveOrderPrimaryAction(requested, { ...all, canResolveOrderSupportRequests: true })).toBe("reviewCancellation");
    // Without the right to answer it, the order's own next step stays.
    expect(resolveOrderPrimaryAction(requested, all)).toBe("confirm");
    const answered = order({ ...requested, supportRequests: [{ ...requested.supportRequests![0]!, active: false }] });
    expect(resolveOrderPrimaryAction(answered, { ...all, canResolveOrderSupportRequests: true })).toBe("confirm");
  });

  it("offers nothing on an archived order", () => {
    expect(resolveOrderPrimaryAction(order({ archivedAt: 1 }), all)).toBeNull();
  });

  it("books a courier only for confirmed orders without an active shipment", () => {
    expect(resolveOrderPrimaryAction(order({ status: "confirmed", deliveryProviders: [courier] }), all)).toBe("bookCourier");
    const booked = order({
      status: "confirmed",
      shipments: [{ id: "s1", orderId: "ord_1", providerId: "p", providerType: "pathao", externalId: null, trackingId: null, status: "pending", rawStatus: null, createdAt: 1 }],
    });
    expect(resolveOrderPrimaryAction(booked, all)).toBeNull();
    const unknownShipments = order({
      status: "confirmed",
      operationalReads: {
        shipments: { status: "unavailable", refreshing: false },
        deliveryProviders: { status: "ready", refreshing: false },
      },
    });
    expect(resolveOrderPrimaryAction(unknownShipments, all)).toBeNull();
    expect(resolveOrderPrimaryAction(order({ status: "confirmed", deliveryProviders: [courier] }), { ...all, canManageOrderShipments: false })).toBeNull();
  });

  it("collects COD on shipped or delivered orders with a balance", () => {
    expect(resolveOrderPrimaryAction(order({ status: "shipped" }), all)).toBe("collectCod");
    expect(resolveOrderPrimaryAction(order({ status: "delivered" }), all)).toBe("collectCod");
    expect(resolveOrderPrimaryAction(order({ status: "delivered", balanceDue: 0 }), all)).toBeNull();
    expect(resolveOrderPrimaryAction(order({ status: "delivered", paymentMethod: "stripe" }), all)).toBeNull();
    expect(resolveOrderPrimaryAction(order({ status: "delivered" }), { ...all, canUpdateOrderCod: false })).toBeNull();
  });

  it("offers nothing while a refund or courier check blocks the order", () => {
    const refund = { active: true } as Order["activeRefundOperation"];
    expect(resolveOrderPrimaryAction(order({ activeRefundOperation: refund }), all)).toBeNull();
    const recovery = { activeLock: true } as Order["shipmentRecovery"];
    expect(resolveOrderPrimaryAction(order({ status: "confirmed", shipmentRecovery: recovery }), all)).toBeNull();
  });

  it("marks a shipped, fully sent order paid online delivered; a cash order collects instead", () => {
    const sent = { ...item, quantity: 2, fulfilledQuantity: 2 };
    const paidOnline = order({ status: "shipped", paymentMethod: "stripe", paymentStatus: "paid", paidAmount: 1000, balanceDue: 0, items: [sent] });
    expect(resolveOrderPrimaryAction(paidOnline, all)).toBe("markDelivered");
    expect(resolveOrderPrimaryAction(paidOnline, { ...all, canChangeOrderStatus: false })).toBeNull();
    expect(resolveOrderPrimaryAction(order({ status: "shipped", items: [sent] }), all)).toBe("collectCod");
    const partly = order({ status: "shipped", paymentMethod: "stripe", paymentStatus: "paid", balanceDue: 0, items: [{ ...sent, fulfilledQuantity: 1 }] });
    expect(resolveOrderPrimaryAction(partly, all)).not.toBe("markDelivered");
  });

  it("offers nothing for finished orders", () => {
    for (const status of ["completed", "cancelled", "refunded", "returned"]) {
      expect(resolveOrderPrimaryAction(order({ status }), all)).toBeNull();
    }
  });

  describe("orders that don't ship", () => {
    const pickupLine = { ...item, id: "pickup_1", quantity: 2, fulfillmentType: "pickup" as const, fulfilledQuantity: 0 };
    const serviceLine = { ...item, id: "service_1", fulfillmentType: "service" as const, fulfilledQuantity: 0 };
    const pickup = order({
      status: "confirmed", requiresShipping: false, shippingMethodKind: "pickup", balanceDue: 1000, items: [pickupLine],
    });

    it("marks a pickup order ready first, then picked up", () => {
      expect(resolveOrderPrimaryAction(pickup, all)).toBe("markReadyForPickup");
      expect(resolveOrderPrimaryAction({ ...pickup, pickupReadyAt: "2026-09-25T09:00:00Z" }, all)).toBe("markPickedUp");
      expect(resolveOrderPrimaryAction(pickup, { ...all, canManageOrderShipments: false })).toBe("collectCod");
    });

    it("never offers a courier or own rider for pickup or service lines", () => {
      expect(resolveOrderPrimaryAction(pickup, all)).not.toBe("sendOwnCourier");
      expect(unitsLeftToSend(pickup)).toBe(0);
    });

    it("marks a service done once nothing is left to collect", () => {
      const service = order({ status: "confirmed", requiresShipping: false, shippingMethodKind: null, items: [serviceLine] });
      expect(resolveOrderPrimaryAction(service, all)).toBe("markServiceDone");
      const both = order({ status: "confirmed", requiresShipping: false, items: [pickupLine, serviceLine], pickupReadyAt: "2026-09-25T09:00:00Z" });
      expect(resolveOrderPrimaryAction(both, all)).toBe("markPickedUp");
    });

    it("collects the counter cash on a handed-over order that is still confirmed", () => {
      const collected = order({ status: "confirmed", requiresShipping: false, items: [{ ...pickupLine, fulfilledQuantity: 2 }] });
      expect(resolveOrderPrimaryAction(collected, all)).toBe("collectCod");
    });

    it("sends the ship lines of a mixed order before the service", () => {
      const mixed = order({ status: "confirmed", requiresShipping: true, items: [{ ...item, fulfillmentType: "ship" as const }, serviceLine] });
      expect(resolveOrderPrimaryAction(mixed, all)).toBe("sendOwnCourier");
      const shipped = order({
        status: "shipped", requiresShipping: true,
        items: [{ ...item, fulfillmentType: "ship" as const, fulfilledQuantity: 1 }, serviceLine],
      });
      expect(resolveOrderPrimaryAction(shipped, all)).toBe("markServiceDone");
    });
  });
});
