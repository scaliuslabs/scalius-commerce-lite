// Test fixture: the actions the server sends with an order fixture, made by
// the server's own derivation (`presentOrderActions`, `summarizeHandOverUnits`
// in @scalius/core/modules/orders). The fixture only states the read's facts:
// each field the server selects, taken from the fixture as it is.
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import {
  presentOrderActions,
  summarizeHandOverUnits,
  type HandOverUnitRow,
  type OrderActionReads,
} from "@scalius/core/modules/orders/browser";
import type { OrderAdminActions } from "@scalius/shared/order-admin-actions";
import type { Order } from "./types";

/** What the fixture can't say itself: the cash record and the money facts read beside the row. */
export interface ExtraFacts {
  /** The cash record's state (`cod_tracking.cod_status`); default: pending for a cash order, else none. */
  codStatus?: string | null;
  money?: Partial<OrderActionReads["money"]>;
}

const SETTLED: OrderActionReads["money"] = { paymentRecordsSettled: true, giftCardOnly: false, paymentPlanStatus: null };
const isOpen = (shipment: { status?: string | null } | null | undefined) => (shipment?.status ? { status: shipment.status } : null);

/** The order page fixture's actions, as the detail read would send them. */
export function pageOrderActions(order: Order, extra: ExtraFacts = {}): OrderAdminActions {
  return presentOrderActions({
    status: order.status,
    onHold: (order.holds ?? []).some((hold) => hold.releasedAt === null),
    openRequestType: order.supportRequests?.find((request) => request.active)?.type ?? null,
    codStatus: extra.codStatus !== undefined ? extra.codStatus : order.paymentMethod === "cod" ? "pending" : null,
    requiresShipping: order.requiresShipping !== false,
    pickupReadyAt: order.pickupReadyAt ?? order.pickup?.readyAt ?? null,
    shippingMethodKind: order.shippingMethodKind ?? null,
    disputedMinor: order.disputedAmount ?? 0,
    paymentStatus: order.paymentStatus ?? null,
    paymentMethod: order.paymentMethod ?? null,
    fulfillmentStatus: order.fulfillmentStatus ?? null,
    paidAmountMinor: order.paidAmount ?? 0,
    totalAmountMinor: order.totalAmount,
    balanceDueMinor: order.balanceDue ?? 0,
    paymentTermsDays: order.paymentTerms?.days ?? null,
  }, {
    units: summarizeHandOverUnits(order.items.map((item) => ({
      fulfillmentType: item.fulfillmentType,
      left: item.quantity - item.fulfilledQuantity,
      handedOver: item.fulfilledQuantity,
    }))),
    latestShipment: isOpen(order.shipments?.[0]),
    refundLocksOrder: Boolean(order.activeRefundOperation?.active) && order.activeRefundOperation?.locksOrder !== false,
    refundInFlight: Boolean(order.activeRefundOperation?.active),
    shipmentRecovery: { activeLock: order.shipmentRecovery?.activeLock === true },
    paymentRecovery: { activeProcessing: order.paymentRecovery?.activeProcessing === true },
    money: { ...SETTLED, ...extra.money },
  });
}

/** The order with the actions the server would send with it. */
export function withPageActions<T extends Order>(order: T, extra: ExtraFacts = {}): T {
  return { ...order, actions: pageOrderActions(order, extra) };
}

/** Two ship units, none sent: what a list row fixture has to hand over unless it says otherwise. */
export const TWO_TO_SHIP: readonly HandOverUnitRow[] = [{ fulfillmentType: "ship", left: 2, handedOver: 0 }];

/**
 * A list row fixture's actions, as the list read would send them. The list
 * row carries no lines: `units` is what the read sums from them.
 */
export function listRowActions(
  row: Partial<Omit<OrderListItem, "status">> & { status: string },
  units: readonly HandOverUnitRow[] = TWO_TO_SHIP,
  extra: ExtraFacts = {},
): OrderAdminActions {
  return presentOrderActions({
    status: row.status,
    onHold: row.onHold === true,
    openRequestType: row.openRequestType ?? null,
    codStatus: extra.codStatus !== undefined ? extra.codStatus : row.cod?.status ?? (row.paymentMethod === "cod" ? "pending" : null),
    requiresShipping: row.requiresShipping !== false,
    pickupReadyAt: row.pickupReadyAt ?? null,
    shippingMethodKind: row.shippingMethodKind ?? null,
    disputedMinor: row.disputedAmount ?? 0,
    paymentStatus: row.paymentStatus ?? null,
    paymentMethod: row.paymentMethod ?? null,
    fulfillmentStatus: row.fulfillmentStatus ?? null,
    paidAmountMinor: row.paidAmount ?? 0,
    totalAmountMinor: row.totalAmount ?? 0,
    balanceDueMinor: Math.max(0, (row.totalAmount ?? 0) - (row.paidAmount ?? 0)),
    paymentTermsDays: null,
  }, {
    units: summarizeHandOverUnits(units),
    latestShipment: isOpen(row.latestShipment),
    refundLocksOrder: row.activeRefundOperation?.active === true && (row.activeRefundOperation as { locksOrder?: boolean }).locksOrder !== false,
    refundInFlight: row.activeRefundOperation?.active === true,
    shipmentRecovery: { activeLock: row.shipmentRecovery?.activeLock === true },
    paymentRecovery: { activeProcessing: row.paymentRecovery?.activeProcessing === true },
    money: { ...SETTLED, ...extra.money },
  });
}
