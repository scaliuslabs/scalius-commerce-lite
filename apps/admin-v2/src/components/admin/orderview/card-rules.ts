// Which of the order page's cards apply to an order. Each card shows only
// what applies, decided from facts the order itself carries, so no card pops
// in (and moves the page) once its own read arrives.
import type { Order } from "./types";

/**
 * Delivery (courier parcels, tracking, Mark delivered): once something was
 * sent, a parcel exists from before, or a courier booking needs checking.
 * Before anything is sent the Unfulfilled card books the courier; an empty
 * Delivery card would only say "No shipments yet".
 */
export function hasDeliveryCard(order: Pick<Order, "fulfillments" | "shipments" | "shipmentRecovery">): boolean {
  return (order.fulfillments ?? []).some((fulfillment) => fulfillment.kind === "ship")
    || (order.shipments ?? []).length > 0
    || (order.shipmentRecovery?.state ?? "none") !== "none";
}

/** Hold for review: while an app's hold is open (nothing ships or moves on until staff release it). */
export function hasHoldCard(order: Pick<Order, "holds">): boolean {
  return (order.holds ?? []).some((hold) => hold.releasedAt === null);
}

/** Orders a return can be started on, or whose return is already the story. */
const RETURN_STATUSES = new Set(["delivered", "completed", "returned", "refunded"]);

/** Returns: once the order was delivered, money is owed back, or a return exists. */
export function hasReturnsCard(order: Pick<Order, "status" | "refundDue">, returnsCount: number): boolean {
  return RETURN_STATUSES.has(order.status.trim().toLowerCase()) || order.refundDue > 0 || returnsCount > 0;
}
