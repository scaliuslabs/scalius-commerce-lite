import { couriersForCountry } from "~/lib/courier-countries";
import { cashCollectionPoint } from "@scalius/shared/order-payment-methods";
import type { OrderNextStep } from "@scalius/shared/order-admin-actions";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { fulfilledUnits, lineFulfillmentType, remainingToSend } from "./fulfilment-groups";
import { listedActions } from "./order-actions";
import type { Order, OrderHold, OrderSupportRequest } from "./types";

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
export type OrderActionRequest = { action: OrderPrimaryAction | "refund" | "cancel"; id: number };

/** The customer's open request to cancel, if any. */
export function openCancellationRequest(order: Pick<Order, "supportRequests">): OrderSupportRequest | null {
  return order.supportRequests?.find((request) => request.active && request.type === "cancel_pre_shipment") ?? null;
}

/** Apps' holds staff haven't released, for the hold card (the server's actions already wait for them). */
export function openOrderHolds(order: Pick<Order, "holds">): OrderHold[] {
  return (order.holds ?? []).filter((hold) => hold.releasedAt === null);
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
 * Goods staff pick and hand over, delivered or at a pickup point: the packing
 * slip goes with them (it names the pickup point). Only an order with nothing
 * to hand over (a service, digital goods) has none. Read from where the order is
 * handed over, the fact its payment words read.
 */
export function offersPackingSlip(order: { shippingMethodKind?: string | null; requiresShipping?: boolean | null }): boolean {
  return cashCollectionPoint(order) !== "service";
}

const STEP_PERMISSION: Record<OrderNextStep, keyof OrderActionPermissions> = {
  review_cancellation: "canResolveOrderSupportRequests",
  confirm: "canChangeOrderStatus",
  send_rest: "canManageOrderShipments",
  ship: "canManageOrderShipments",
  mark_ready_for_pickup: "canManageOrderShipments",
  mark_picked_up: "canManageOrderShipments",
  mark_service_done: "canManageOrderShipments",
  collect_cash: "canUpdateOrderCod",
  mark_delivered: "canChangeOrderStatus",
};

/**
 * The page's one primary button (header on desktop, bottom bar on phones):
 * the order's next step as the server lists it, when this staff member may
 * take it. Shipping picks the card flow: book a courier that serves the
 * address, else your own rider. Every card still applies its own guards.
 */
export function resolveOrderPrimaryAction(
  order: Order,
  permissions: Partial<OrderActionPermissions>,
): OrderPrimaryAction | null {
  const step = listedActions(order).next;
  if (!step || !permissions[STEP_PERMISSION[step]]) return null;
  switch (step) {
    case "review_cancellation": return "reviewCancellation";
    case "confirm": return "confirm";
    case "send_rest": return "sendOwnCourier";
    case "ship":
      // Which flow waits for the couriers read; the step itself is the server's.
      if ((order.operationalReads?.deliveryProviders.status ?? "ready") !== "ready") return null;
      return couriersForCountry(order.deliveryProviders ?? [], order.shippingCountryCode).served.length > 0 ? "bookCourier" : "sendOwnCourier";
    case "mark_ready_for_pickup": return "markReadyForPickup";
    case "mark_picked_up": return "markPickedUp";
    case "mark_service_done": return "markServiceDone";
    case "collect_cash": return "collectCod";
    case "mark_delivered": return "markDelivered";
  }
}
