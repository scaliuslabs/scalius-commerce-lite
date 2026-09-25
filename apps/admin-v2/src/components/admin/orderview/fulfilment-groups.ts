import { isAutoFulfillmentType, type FulfillmentType } from "@scalius/shared/fulfilment";
import type { Order, OrderFulfillment, OrderItem } from "./types";

/** Card order on the page, as on Shopify: what ships, what is collected, what is performed, then the automatic ones. */
export const FULFILMENT_GROUP_ORDER: readonly FulfillmentType[] = ["ship", "pickup", "service", "digital", "gift_card"];

/** Order statuses where units can be handed over. */
const HANDOVER_ORDER_STATUSES = new Set(["confirmed", "shipped", "delivered"]);

/**
 * How a line reaches the buyer. Lines placed before Wave A carry no type:
 * they shipped (every order used to).
 */
export function lineFulfillmentType(item: Pick<OrderItem, "fulfillmentType">): FulfillmentType {
  return item.fulfillmentType ?? "ship";
}

/** Units of a line handed over so far (the ledger projection; the courier count before it). */
export function fulfilledUnits(item: Pick<OrderItem, "fulfilledQuantity" | "shippedQuantity">): number {
  return Math.max(0, item.fulfilledQuantity ?? item.shippedQuantity ?? 0);
}

/** Units of a line not handed over yet. */
export function unfulfilledUnits(item: Pick<OrderItem, "quantity" | "fulfilledQuantity" | "shippedQuantity">): number {
  return Math.max(0, item.quantity - fulfilledUnits(item));
}

export interface GroupLine {
  item: OrderItem;
  /** Units of this line in the group. */
  quantity: number;
}

export interface UnfulfilledGroup {
  type: FulfillmentType;
  lines: GroupLine[];
  units: number;
}

/** One card per line type that still has units to hand over. */
export function unfulfilledGroups(order: Pick<Order, "items">): UnfulfilledGroup[] {
  const byType = new Map<FulfillmentType, GroupLine[]>();
  for (const item of order.items) {
    const quantity = unfulfilledUnits(item);
    if (quantity === 0) continue;
    const type = lineFulfillmentType(item);
    byType.set(type, [...(byType.get(type) ?? []), { item, quantity }]);
  }
  return FULFILMENT_GROUP_ORDER.flatMap((type) => {
    const lines = byType.get(type);
    return lines ? [{ type, lines, units: lines.reduce((sum, line) => sum + line.quantity, 0) }] : [];
  });
}

export interface FulfilledGroup {
  /** The ledger row; null for units handed over before the ledger (no record to show). */
  fulfillment: OrderFulfillment | null;
  type: FulfillmentType;
  lines: GroupLine[];
  units: number;
}

/**
 * One card per active fulfilment, oldest first (Shopify numbers them in
 * order). Units the projection counts but no active row explains, as on
 * orders fulfilled before the ledger, go in one card per type at the end.
 */
export function fulfilledGroups(order: Pick<Order, "items" | "fulfillments">): FulfilledGroup[] {
  const items = new Map(order.items.map((item) => [item.id, item]));
  const covered = new Map<string, number>();
  const groups: FulfilledGroup[] = [];
  const active = (order.fulfillments ?? [])
    .filter((fulfillment) => fulfillment.status === "active")
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
  for (const fulfillment of active) {
    const lines = fulfillment.lines.flatMap((line): GroupLine[] => {
      const item = items.get(line.orderItemId);
      if (!item || line.quantity <= 0) return [];
      covered.set(item.id, (covered.get(item.id) ?? 0) + line.quantity);
      return [{ item, quantity: line.quantity }];
    });
    if (lines.length === 0) continue;
    groups.push({ fulfillment, type: fulfillment.kind, lines, units: lines.reduce((sum, line) => sum + line.quantity, 0) });
  }
  const unexplained = new Map<FulfillmentType, GroupLine[]>();
  for (const item of order.items) {
    const quantity = Math.min(item.quantity, fulfilledUnits(item)) - (covered.get(item.id) ?? 0);
    if (quantity <= 0) continue;
    const type = lineFulfillmentType(item);
    unexplained.set(type, [...(unexplained.get(type) ?? []), { item, quantity }]);
  }
  for (const type of FULFILMENT_GROUP_ORDER) {
    const lines = unexplained.get(type);
    if (lines) groups.push({ fulfillment: null, type, lines, units: lines.reduce((sum, line) => sum + line.quantity, 0) });
  }
  return groups;
}

type HandoverOrder = Pick<Order, "status" | "archivedAt" | "activeRefundOperation" | "shipmentRecovery">;

/** Nothing on the order blocks staff from handing units over (status, archive, refund, courier check). */
export function canHandOver(order: HandoverOrder): boolean {
  return HANDOVER_ORDER_STATUSES.has(order.status.toLowerCase())
    && !order.archivedAt
    && !order.activeRefundOperation?.active
    && order.shipmentRecovery?.activeLock !== true;
}

/** Staff hand these over by a real action; digital lines and gift cards fulfil themselves. */
export function isManualGroup(type: FulfillmentType): type is "ship" | "pickup" | "service" {
  return !isAutoFulfillmentType(type);
}

/** Units of `type` still to hand over. */
export function unitsLeft(order: Pick<Order, "items">, type: FulfillmentType): number {
  return order.items
    .filter((item) => lineFulfillmentType(item) === type)
    .reduce((sum, item) => sum + unfulfilledUnits(item), 0);
}

/** Ready-for-pickup is a notification fact on the order: set once, until everything is collected. */
export function isReadyForPickup(order: Pick<Order, "pickupReadyAt" | "pickup">): boolean {
  return Boolean(order.pickupReadyAt ?? order.pickup?.readyAt);
}

/**
 * Cash the buyer hands over with this action: a cash-on-delivery balance on an
 * order that doesn't ship (pickup counter, service visit). Null when there is none.
 */
export function counterCashDue(order: Pick<Order, "paymentMethod" | "balanceDue" | "requiresShipping">): number | null {
  const due = Number(order.balanceDue ?? 0);
  return order.paymentMethod === "cod" && order.requiresShipping === false && due > 0 ? due : null;
}
