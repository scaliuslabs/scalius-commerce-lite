import { describe, expect, it } from "vitest";
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import { translate } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";
import { orderMessages } from "~/i18n/orders";
import { shipmentStatusMessages } from "~/i18n/shipment-status";
import { codToCollect, deliveryMethod, deliveryStatus, fulfilmentShown, orderAttention, orderNextStep, paymentShown } from "./order-row-facts";

const t = (key: string, vars?: Record<string, string | number>) => translate(orderListMessages, key as never, vars);
const o = (key: string, vars?: Record<string, string | number>) => translate(orderMessages, key as never, vars);
const s = (key: string, vars?: Record<string, string | number>) => translate(shipmentStatusMessages, key as never, vars);
const order = (overrides: Partial<OrderListItem>) => ({
  status: "confirmed", paymentStatus: "unpaid", paymentMethod: "cod", fulfillmentStatus: "pending", totalAmount: 680, paidAmount: 0,
  latestShipment: null, shipmentRecovery: { state: "none", severity: "info", activeLock: false },
  paymentRecovery: { state: "none" }, activeRefundOperation: null, openRequestType: null, onHold: false, refundDue: 0, cod: null,
  requiresShipping: true, shippingMethodKind: "delivery", pickupReadyAt: null,
  ...overrides,
}) as unknown as OrderListItem;

describe("orders list row facts", () => {
  it("lists what holds an order up, the critical first, in the merchant's words", () => {
    expect(orderAttention(order({}), t, o)).toEqual([]);
    const items = orderAttention(order({
      openRequestType: "cancel_pre_shipment",
      refundDue: 120,
      shipmentRecovery: { state: "needs_attention", severity: "danger", activeLock: true } as OrderListItem["shipmentRecovery"],
      paymentRecovery: { state: "awaiting_payment" } as OrderListItem["paymentRecovery"],
    }), t, o);
    expect(items.map((item) => item.text)).toEqual([
      t("courierCheck"), t("recovery.awaiting_payment"), o("request.cancel_pre_shipment"), o("refundOwed"),
    ]);
    expect(items[0]!.tone).toBe("critical");

    // An app's hold leads: nothing moves on until staff release it.
    const held = orderAttention(order({ onHold: true, refundDue: 120 }), t, o);
    expect(held).toEqual([{ tone: "critical", text: t("onHold") }, { tone: "warning", text: o("refundOwed") }]);
  });

  it("says where the parcel is, never a stale In transit for a returned order or a failed cash attempt", () => {
    const parcel = { id: "s1", status: "in_transit", providerName: "Pathao" } as OrderListItem["latestShipment"];
    expect(deliveryStatus(order({}), t, s)).toBeNull();
    expect(deliveryStatus(order({ latestShipment: parcel }), t, s)).toEqual({ text: s("shipment.in_transit"), tone: "neutral" });
    expect(deliveryStatus(order({ latestShipment: parcel, status: "returned" }), t, s)?.text).toBe(s("shipment.returned"));
    expect(deliveryStatus(order({ latestShipment: parcel, cod: { status: "failed", deliveryAttempts: 2 } }), t, s))
      .toEqual({ text: t("deliveryFailed", { count: 2 }), tone: "critical" });
    expect(deliveryStatus(order({ shipmentRecovery: { state: "creating", severity: "info", activeLock: true } as OrderListItem["shipmentRecovery"] }), t, s))
      .toEqual({ text: t("courierCheck"), tone: "warning" });
  });

  it("names the delivery method: pickup, no delivery, the parcel's courier, else Delivery", () => {
    expect(deliveryMethod(order({ shippingMethodKind: "pickup", requiresShipping: false }), o)).toBe(o("delivery.pickup"));
    expect(deliveryMethod(order({ shippingMethodKind: null, requiresShipping: false }), o)).toBe(o("delivery.none"));
    expect(deliveryMethod(order({ latestShipment: { providerName: null, providerType: "steadfast" } as OrderListItem["latestShipment"] }), o)).toBe("Steadfast");
    expect(deliveryMethod(order({}), o)).toBe(o("delivery.delivery"));
  });

  it("shows payment and fulfilment only while the order is open, and Ready for pickup once staff said so", () => {
    expect(paymentShown(order({ status: "cancelled" }))).toBeNull();
    expect(fulfilmentShown(order({ status: "refunded" }))).toBeNull();
    expect(paymentShown(order({ paymentStatus: "partially_refunded", status: "delivered" }))).toBe("partially_refunded");
    expect(fulfilmentShown(order({ shippingMethodKind: "pickup", pickupReadyAt: new Date() as never }))).toBe("readyForPickup");
    expect(codToCollect(order({ paidAmount: 180 }))).toBe(500);
    expect(codToCollect(order({ status: "cancelled" }))).toBe(0);
  });

  it("names the one next step of each order, so a confirmed order is never a dead end", () => {
    expect(orderNextStep(order({ status: "pending" }))).toBe("confirm");
    expect(orderNextStep(order({ status: "processing" }))).toBe("confirm");
    expect(orderNextStep(order({ status: "confirmed", paymentMethod: "stripe", paymentStatus: "paid", paidAmount: 680 }))).toBe("fulfil");
    // Cash on its way is collected, whatever else is open.
    expect(orderNextStep(order({ status: "shipped", fulfillmentStatus: "complete" }))).toBe("collect");
    expect(orderNextStep(order({ status: "shipped", fulfillmentStatus: "complete", paymentMethod: "stripe", paymentStatus: "paid", paidAmount: 680 }))).toBe("deliver");
    expect(orderNextStep(order({ status: "completed" }))).toBeNull();
    expect(orderNextStep(order({ status: "cancelled" }))).toBeNull();
    expect(orderNextStep(order({ status: "pending", onHold: true }))).toBeNull();
    expect(orderNextStep(order({ status: "pending", archivedAt: new Date() }))).toBeNull();
  });
});
