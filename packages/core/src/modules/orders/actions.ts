// The actions an order is read with (detail, list row, the status command's
// own check): the facts every read builds the same way, then the shared rule
// (@scalius/shared/order-admin-actions). Browser-safe: no database.
import { orderAdminActions, type OrderAdminActions } from "@scalius/shared/order-admin-actions";

/** Units of one kind of line: still to hand over, and handed over so far. */
export interface HandOverUnitRow {
    fulfillmentType: string;
    left: number;
    handedOver: number;
}

/** What is left to hand over and what went, summed from the order's lines by kind. */
export function summarizeHandOverUnits(rows: readonly HandOverUnitRow[]) {
    const left = { ship: 0, pickup: 0, service: 0 };
    let shipUnitsSent = 0;
    let unitsHandedOver = 0;
    for (const row of rows) {
        const type = row.fulfillmentType as keyof typeof left;
        if (type in left) left[type] += Math.max(0, Number(row.left) || 0);
        const out = Math.max(0, Number(row.handedOver) || 0);
        unitsHandedOver += out;
        if (type === "ship") shipUnitsSent += out;
    }
    return { unitsLeft: left, shipUnitsSent, unitsHandedOver };
}

const CLOSED_SHIPMENT_STATUSES = new Set(["cancelled", "failed", "returned"]);

/** The order row's facts, as the list and detail reads select them (money in minor units). */
export interface OrderActionRow {
    status: string;
    onHold: number | boolean;
    openRequestType: string | null;
    codStatus: string | null;
    requiresShipping: boolean;
    pickupReadyAt: unknown;
    disputedMinor: number;
    paymentStatus: string | null;
    paymentMethod: string | null;
    fulfillmentStatus: string | null;
    paidAmountMinor: number;
    totalAmountMinor: number;
    balanceDueMinor: number;
    paymentTermsDays: number | null;
}

/** What the reads beside the row say: the lines, the latest parcel, work in progress and the cancel's money checks. */
export interface OrderActionReads {
    units: ReturnType<typeof summarizeHandOverUnits>;
    latestShipment: { status: string } | null;
    refundInProgress: boolean;
    shipmentRecovery: { activeLock: boolean };
    paymentRecovery: { activeProcessing: boolean };
    cancelMoney: { paymentRecordsSettled: boolean; giftCardOnly: boolean };
}

/**
 * What staff may do to the order now, for the list row, the order page and
 * the status command alike (the same facts, so the same answer).
 */
export function presentOrderActions(order: OrderActionRow, reads: OrderActionReads): OrderAdminActions {
    return orderAdminActions({
        status: order.status,
        onHold: Boolean(Number(order.onHold)),
        refundInProgress: reads.refundInProgress,
        courierCheck: reads.shipmentRecovery.activeLock,
        paymentInProgress: reads.paymentRecovery.activeProcessing,
        requiresShipping: order.requiresShipping !== false,
        fulfillmentStatus: order.fulfillmentStatus,
        ...reads.units,
        pickupReady: order.pickupReadyAt !== null && order.pickupReadyAt !== undefined,
        courierBooked: reads.latestShipment !== null && !CLOSED_SHIPMENT_STATUSES.has(reads.latestShipment.status.toLowerCase()),
        cancellationRequested: order.openRequestType === "cancel_pre_shipment",
        codStatus: order.codStatus,
        paymentRecordsSettled: reads.cancelMoney.paymentRecordsSettled,
        giftCardOnly: reads.cancelMoney.giftCardOnly,
        paymentStatus: order.paymentStatus,
        paymentMethod: order.paymentMethod,
        paid: order.paidAmountMinor,
        disputed: Number(order.disputedMinor) || 0,
        total: order.totalAmountMinor,
        balanceDue: order.balanceDueMinor,
        paymentTermsDays: order.paymentTermsDays,
    });
}
