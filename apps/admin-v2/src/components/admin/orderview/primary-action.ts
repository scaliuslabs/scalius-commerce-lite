import { canProcessOrderCodAction } from "@scalius/shared/order-state";
import { getAdminOrderStatusTransitions } from "~/lib/admin-order-status-policy";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { canSendWithOwnCourier, remainingToSend } from "./ManualFulfillmentDialog";
import { canHandOver, fulfilledUnits, isReadyForPickup, lineFulfillmentType, unitsLeft } from "./fulfilment-groups";
import type { Order, OrderSupportRequest } from "./types";

export type OrderPrimaryAction =
  | "confirm"
  | "bookCourier"
  | "sendOwnCourier"
  | "markReadyForPickup"
  | "markPickedUp"
  | "markServiceDone"
  | "collectCod"
  | "markDelivered"
  | "reviewCancellation";
/** The next step asked of a card; a new `id` repeats the request. */
export type OrderActionRequest = { action: OrderPrimaryAction | "refund"; id: number };

const CLOSED_SHIPMENT_STATUSES = new Set(["cancelled", "failed", "returned"]);

/** The customer's open request to cancel, if any. */
export function openCancellationRequest(order: Pick<Order, "supportRequests">): OrderSupportRequest | null {
  return order.supportRequests?.find((request) => request.active && request.type === "cancel_pre_shipment") ?? null;
}

/** Ship units not handed to a courier yet, once part of them has gone out; 0 otherwise. */
export function unitsLeftToSend(order: Pick<Order, "items">): number {
  const shipLines = order.items.filter((item) => lineFulfillmentType(item) === "ship");
  if (!shipLines.some((item) => fulfilledUnits(item) > 0)) return 0;
  return shipLines.reduce((sum, item) => sum + remainingToSend(item), 0);
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
  const shipLines = order.items.filter((item) => lineFulfillmentType(item) === "ship");
  return order.status.toLowerCase() === "shipped"
    && order.paymentMethod !== "cod"
    && ["paid", "partially_refunded"].includes(order.paymentStatus ?? "")
    && !(Number(order.balanceDue ?? 0) > 0)
    && shipLines.length > 0
    && shipLines.every((item) => fulfilledUnits(item) >= item.quantity)
    && !order.archivedAt
    && !order.activeRefundOperation?.active
    && order.shipmentRecovery?.activeLock !== true;
}

/**
 * The one next step of an order (header on desktop, bottom bar on phones):
 * confirm → hand over (book a courier or your own rider for ship lines; mark
 * a pickup order ready, then picked up; mark a service done) → collect the
 * cash, or mark a paid order delivered. An open cancellation request comes
 * first. Every card still applies its own guards; this only picks which card
 * flow to start.
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

  if (status === "confirmed" && unitsLeft(order, "ship") > 0) {
    const reads = order.operationalReads;
    const known = (reads?.shipments.status ?? "ready") === "ready"
      && (reads?.deliveryProviders.status ?? "ready") === "ready";
    const hasActiveShipment = (order.shipments ?? []).some(
      (shipment) => !CLOSED_SHIPMENT_STATUSES.has(shipment.status.toLowerCase()),
    );
    if (!actions.canManageOrderShipments || !known || hasActiveShipment || order.fulfillmentStatus === "complete") {
      return null;
    }
    return (order.deliveryProviders ?? []).length > 0 ? "bookCourier" : "sendOwnCourier";
  }

  if (actions.canManageOrderShipments && canHandOver(order)) {
    if (unitsLeft(order, "pickup") > 0) return isReadyForPickup(order) ? "markPickedUp" : "markReadyForPickup";
    if (unitsLeft(order, "service") > 0) return "markServiceDone";
  }

  if (
    ["shipped", "delivered", "confirmed"].includes(status)
    && order.paymentMethod === "cod"
    && Number(order.balanceDue ?? 0) > 0
    && actions.canUpdateOrderCod
    && canProcessOrderCodAction(status, "collected", { requiresShipping: order.requiresShipping })
  ) {
    return "collectCod";
  }

  if (actions.canChangeOrderStatus && canMarkDelivered(order)) return "markDelivered";

  return null;
}
