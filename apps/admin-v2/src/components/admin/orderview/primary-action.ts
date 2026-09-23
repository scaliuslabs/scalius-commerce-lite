import { canProcessOrderCodAction } from "@scalius/shared/order-state";
import { getAdminOrderStatusTransitions } from "~/lib/admin-order-status-policy";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import type { Order } from "./types";

export type OrderPrimaryAction = "confirm" | "bookCourier" | "collectCod";

const CLOSED_SHIPMENT_STATUSES = new Set(["cancelled", "failed", "returned"]);

/**
 * The one next step shown in the phone action bar. Every card still applies
 * its own guards; this only picks which card flow to start.
 */
export function resolveOrderPrimaryAction(
  order: Order,
  actions: Pick<OrderActionPermissions, "canChangeOrderStatus" | "canManageOrderShipments" | "canUpdateOrderCod">,
): OrderPrimaryAction | null {
  if (order.activeRefundOperation?.active || order.shipmentRecovery?.activeLock) return null;
  const status = order.status.toLowerCase();

  if (status === "pending" || status === "processing") {
    return actions.canChangeOrderStatus && getAdminOrderStatusTransitions(status, order).includes("confirmed")
      ? "confirm"
      : null;
  }

  if (status === "confirmed") {
    const shipmentsKnown = (order.operationalReads?.shipments.status ?? "ready") === "ready";
    const hasActiveShipment = (order.shipments ?? []).some(
      (shipment) => !CLOSED_SHIPMENT_STATUSES.has(shipment.status.toLowerCase()),
    );
    return actions.canManageOrderShipments
      && shipmentsKnown
      && !hasActiveShipment
      && order.items.length > 0
      && order.fulfillmentStatus !== "complete"
      ? "bookCourier"
      : null;
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
