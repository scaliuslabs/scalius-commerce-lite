import { describe, expect, it } from "vitest";
import { resolveOrderPrimaryAction } from "./primary-action";
import type { Order } from "./types";

const all = { canChangeOrderStatus: true, canManageOrderShipments: true, canUpdateOrderCod: true };
const item = {
  id: "item_1", productId: "p1", variantId: null, quantity: 1, price: 500,
  productName: "Shirt", productImage: null, variantLabel: null,
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

  it("offers nothing for finished orders", () => {
    for (const status of ["completed", "cancelled", "refunded", "returned"]) {
      expect(resolveOrderPrimaryAction(order({ status }), all)).toBeNull();
    }
  });
});
