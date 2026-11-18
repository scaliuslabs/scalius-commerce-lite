// Test fixture: the actions the server would list with an order fixture
// (`presentOrderActions` in packages/core), from the facts the fixture holds.
// Tests attach them as the API does; the dashboard itself never computes them.
import { orderAdminActions, type OrderActionFacts, type OrderAdminActions } from "@scalius/shared/order-admin-actions";
import type { Order } from "./types";

type Units = Pick<OrderActionFacts, "unitsLeft" | "shipUnitsSent" | "unitsHandedOver">;

/** What the order page's fixture says, read the way the server reads its rows. */
export function pageOrderActions(order: Order, overrides: Partial<OrderActionFacts> = {}): OrderAdminActions {
  const units: Units = { unitsLeft: { ship: 0, pickup: 0, service: 0 }, shipUnitsSent: 0, unitsHandedOver: 0 };
  for (const item of order.items) {
    const out = Math.max(0, item.fulfilledQuantity);
    const type = item.fulfillmentType as keyof Units["unitsLeft"];
    if (type in units.unitsLeft) units.unitsLeft[type] += Math.max(0, item.quantity - out);
    units.unitsHandedOver += out;
    if (type === "ship") units.shipUnitsSent += out;
  }
  const latest = order.shipments?.[0] ?? null;
  return orderAdminActions({
    status: order.status,
    archived: Boolean(order.archivedAt),
    onHold: (order.holds ?? []).some((hold) => hold.releasedAt === null),
    refundInProgress: Boolean(order.activeRefundOperation?.active),
    courierCheck: order.shipmentRecovery?.activeLock === true,
    paymentInProgress: order.paymentRecovery?.activeProcessing === true,
    requiresShipping: order.requiresShipping !== false,
    fulfillmentStatus: order.fulfillmentStatus,
    ...units,
    pickupReady: Boolean(order.pickupReadyAt ?? order.pickup?.readyAt),
    courierBooked: latest !== null && !["cancelled", "failed", "returned"].includes(latest.status.toLowerCase()),
    cancellationRequested: (order.supportRequests ?? []).some((request) => request.active && request.type === "cancel_pre_shipment"),
    codStatus: null,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    paid: order.paidAmount ?? 0,
    disputed: order.disputedAmount ?? 0,
    total: order.totalAmount,
    balanceDue: order.balanceDue ?? 0,
    paymentTermsDays: order.paymentTerms?.days ?? null,
    ...overrides,
  });
}

/** The order with the actions the server would list for it. */
export function withPageActions<T extends Order>(order: T, overrides: Partial<OrderActionFacts> = {}): T {
  return { ...order, actions: pageOrderActions(order, overrides) };
}

/** A list row's actions: the list read sums the same lines, here given by the fixture's fulfilment state. */
export function listRowActions(row: {
  status: string;
  paymentStatus?: string | null;
  paymentMethod?: string | null;
  fulfillmentStatus?: string | null;
  totalAmount?: number;
  paidAmount?: number;
  archivedAt?: unknown;
  onHold?: boolean;
  openRequestType?: string | null;
  requiresShipping?: boolean;
  shippingMethodKind?: string | null;
  pickupReadyAt?: unknown;
  cod?: { status: string } | null;
  latestShipment?: { status?: string | null } | null;
  activeRefundOperation?: { active: boolean } | null;
  shipmentRecovery?: { activeLock?: boolean } | null;
  paymentRecovery?: { activeProcessing?: boolean } | null;
  disputedAmount?: number;
}, overrides: Partial<OrderActionFacts> = {}): OrderAdminActions {
  const kind = row.requiresShipping === false ? (row.shippingMethodKind === "pickup" ? "pickup" : "service") : "ship";
  const sent = row.fulfillmentStatus === "complete" ? 2 : row.fulfillmentStatus === "partial" ? 1 : 0;
  const total = row.totalAmount ?? 0;
  const paid = row.paidAmount ?? 0;
  return orderAdminActions({
    status: row.status,
    archived: row.archivedAt !== null && row.archivedAt !== undefined,
    onHold: row.onHold === true,
    refundInProgress: row.activeRefundOperation?.active === true,
    courierCheck: row.shipmentRecovery?.activeLock === true,
    paymentInProgress: row.paymentRecovery?.activeProcessing === true,
    requiresShipping: row.requiresShipping !== false,
    fulfillmentStatus: row.fulfillmentStatus,
    unitsLeft: { ship: kind === "ship" ? 2 - sent : 0, pickup: kind === "pickup" ? 2 - sent : 0, service: kind === "service" ? 2 - sent : 0 },
    shipUnitsSent: kind === "ship" ? sent : 0,
    unitsHandedOver: sent,
    pickupReady: row.pickupReadyAt !== null && row.pickupReadyAt !== undefined,
    courierBooked: row.latestShipment != null && !["cancelled", "failed", "returned"].includes((row.latestShipment.status ?? "").toLowerCase()),
    cancellationRequested: row.openRequestType === "cancel_pre_shipment",
    codStatus: row.cod?.status ?? null,
    paymentStatus: row.paymentStatus ?? null,
    paymentMethod: row.paymentMethod ?? null,
    paid,
    disputed: row.disputedAmount ?? 0,
    total,
    balanceDue: Math.max(0, total - paid),
    ...overrides,
  });
}
