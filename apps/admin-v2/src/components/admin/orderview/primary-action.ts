import { canProcessOrderCodAction } from "@scalius/shared/order-state";
import { getAdminOrderStatusTransitions } from "~/lib/admin-order-status-policy";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { canSendWithOwnCourier, remainingToSend } from "./ManualFulfillmentDialog";
import type { Order, OrderSupportRequest } from "./types";

export type OrderPrimaryAction = "confirm" | "bookCourier" | "sendOwnCourier" | "collectCod" | "markDelivered" | "reviewCancellation";
/** The next step asked of a card; a new `id` repeats the request. */
export type OrderActionRequest = { action: OrderPrimaryAction | "refund"; id: number };

const CLOSED_SHIPMENT_STATUSES = new Set(["cancelled", "failed", "returned"]);

/** The customer's open request to cancel, if any. */
export function openCancellationRequest(order: Pick<Order, "supportRequests">): OrderSupportRequest | null {
  return order.supportRequests?.find((request) => request.active && request.type === "cancel_pre_shipment") ?? null;
}

/** Units not handed to a courier yet, once part of the order has gone out; 0 otherwise. */
export function unitsLeftToSend(order: Pick<Order, "items">): number {
  if (!order.items.some((item) => (item.shippedQuantity ?? 0) > 0)) return 0;
  return order.items.reduce((sum, item) => sum + remainingToSend(item), 0);
}

/** Part of the order is with the courier and the rest isn't sent yet. */
export function isPartSent(order: Pick<Order, "status" | "items">): boolean {
  return order.status.toLowerCase() === "confirmed" && unitsLeftToSend(order) > 0;
}

/**
 * A shipped, fully sent order that is already paid online can be marked
 * delivered; a cash order is delivered by recording the cash instead.
 */
export function canMarkDelivered(
  order: Pick<Order, "status" | "items" | "paymentMethod" | "paymentStatus" | "balanceDue" | "archivedAt" | "activeRefundOperation" | "shipmentRecovery">,
): boolean {
  return order.status.toLowerCase() === "shipped"
    && order.paymentMethod !== "cod"
    && ["paid", "partially_refunded"].includes(order.paymentStatus ?? "")
    && !(Number(order.balanceDue ?? 0) > 0)
    && order.items.length > 0
    && order.items.every((item) => (item.shippedQuantity ?? 0) >= item.quantity)
    && !order.archivedAt
    && !order.activeRefundOperation?.active
    && order.shipmentRecovery?.activeLock !== true;
}

/**
 * The one next step of an order (header on desktop, bottom bar on phones):
 * confirm → send (book a courier, or your own rider when none is connected;
 * then the rest of a partly sent order) → collect the cash, or mark a paid
 * order delivered. An open
 * cancellation request comes first. Every card still applies its own guards;
 * this only picks which card flow to start.
 */
export function resolveOrderPrimaryAction(
  order: Order,
  actions: Pick<OrderActionPermissions, "canChangeOrderStatus" | "canManageOrderShipments" | "canUpdateOrderCod">
    & Partial<Pick<OrderActionPermissions, "canResolveOrderSupportRequests">>,
): OrderPrimaryAction | null {
  if (order.archivedAt || order.activeRefundOperation?.active || order.shipmentRecovery?.activeLock) return null;
  const status = order.status.toLowerCase();
  if (actions.canResolveOrderSupportRequests && openCancellationRequest(order)) return "reviewCancellation";

  const shipmentsKnown = (order.operationalReads?.shipments.status ?? "ready") === "ready";
  if (actions.canManageOrderShipments && shipmentsKnown && unitsLeftToSend(order) > 0 && canSendWithOwnCourier(order)) {
    return "sendOwnCourier";
  }

  if (status === "pending" || status === "processing") {
    return actions.canChangeOrderStatus && getAdminOrderStatusTransitions(status, order).includes("confirmed")
      ? "confirm"
      : null;
  }

  if (status === "confirmed") {
    const reads = order.operationalReads;
    const known = (reads?.shipments.status ?? "ready") === "ready"
      && (reads?.deliveryProviders.status ?? "ready") === "ready";
    const hasActiveShipment = (order.shipments ?? []).some(
      (shipment) => !CLOSED_SHIPMENT_STATUSES.has(shipment.status.toLowerCase()),
    );
    if (!actions.canManageOrderShipments || !known || hasActiveShipment
      || order.items.length === 0 || order.fulfillmentStatus === "complete") {
      return null;
    }
    return (order.deliveryProviders ?? []).length > 0 ? "bookCourier" : "sendOwnCourier";
  }

  if (
    (status === "shipped" || status === "delivered")
    && order.paymentMethod === "cod"
    && Number(order.balanceDue ?? 0) > 0
    && actions.canUpdateOrderCod
    && canProcessOrderCodAction(status, "collected")
  ) {
    return "collectCod";
  }

  if (actions.canChangeOrderStatus && canMarkDelivered(order)) return "markDelivered";

  return null;
}
