import { canProcessOrderCodAction } from "@scalius/shared/order-state";
import { getAdminOrderStatusTransitions } from "~/lib/admin-order-status-policy";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import type { Order } from "./types";

export type OrderPrimaryAction = "confirm" | "bookCourier" | "sendOwnCourier" | "collectCod";
/** The next step asked of a card; a new `id` repeats the request. */
export type OrderActionRequest = { action: OrderPrimaryAction | "refund"; id: number };

const CLOSED_SHIPMENT_STATUSES = new Set(["cancelled", "failed", "returned"]);

/**
 * The one next step of an order (header on desktop, bottom bar on phones):
 * confirm → send (book a courier, or your own rider when none is connected)
 * → collect the cash. Every card still applies its own guards; this only
 * picks which card flow to start.
 */
export function resolveOrderPrimaryAction(
  order: Order,
  actions: Pick<OrderActionPermissions, "canChangeOrderStatus" | "canManageOrderShipments" | "canUpdateOrderCod">,
): OrderPrimaryAction | null {
  if (order.archivedAt || order.activeRefundOperation?.active || order.shipmentRecovery?.activeLock) return null;
  const status = order.status.toLowerCase();

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

  return null;
}
