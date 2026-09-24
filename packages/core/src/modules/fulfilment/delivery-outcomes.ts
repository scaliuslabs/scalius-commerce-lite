// Delivery outcomes: delivered, and COD collected, failed or returned.
import { toStoreMinor } from "../settings/store-money";
import type { Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    deliveryShipments,
    OrderStatus,
    FulfillmentStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import {
    markCODReturned,
    recordCODCollection,
    recordCODFailure,
    validateCODCollectionDetails,
} from "../payments/cod";
import {
    assertNoActiveRefundAttempt,
    noActiveRefundAttemptForOrderIdCondition,
} from "../payments/refund-attempt-guard";
import {
    assertNoActivePaymentSessionAttempt,
    noActivePaymentSessionAttemptForOrderIdCondition,
} from "../payments/payment-session-attempts";
import { sql, eq, and, inArray, notInArray } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { resolveOrderCurrencySnapshot } from "../payments/order-currency";
import { fromMinor } from "@scalius/shared/money";
import { validateTransition } from "../orders/status/state-machine";
import type { StatusUpdateResult } from "../orders/types";
import { assertNoActiveShipmentClaim } from "../orders/shipment-claim";
import { rollbackOrderStatusIfInventoryUnchanged } from "../orders/status/claim";
import {
    approveOrderReturn,
    createOrderReturn,
    getOrderReturn,
    listOrderReturns,
} from "../orders/returns/returns";
import {
    assertOrderCodActionAllowed,
    getRecordedCodCollection,
    reconcileInventoryForStatus,
    markManualDeliveryEvidence,
    applyOrderStatusChange,
} from "../orders/status/lifecycle";

export async function processCodAction(db: Database, orderId: string, body: Record<string, unknown>) {
    const order = await db.select({
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        version: orders.version,
        totalAmountMinor: orders.totalAmountMinor,
        paidAmountMinor: orders.paidAmountMinor,
        balanceDueMinor: orders.balanceDueMinor,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        inventoryAction: orders.inventoryAction,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    const currency = resolveOrderCurrencySnapshot(order);
    assertNoActiveShipmentClaim(order);
    await assertNoActiveRefundAttempt(db, orderId);
    await assertNoActivePaymentSessionAttempt(db, orderId);

    switch (body.action) {
        case "collected": {
            assertOrderCodActionAllowed(order.status, "collected");
            const requestedAmount = body.collectedAmount;
            if (typeof requestedAmount !== "number" || !Number.isFinite(requestedAmount) || requestedAmount <= 0) {
                throw new ValidationError("COD collected amount must be a positive finite number.");
            }
            const requestedAmountMinor = toStoreMinor(requestedAmount, currency);
            const existingCodCollection = await getRecordedCodCollection(db, orderId, currency);
            const collection = existingCodCollection
                ? null
                : validateCODCollectionDetails(order, {
                    collectedBy: body.collectedBy as string,
                    collectedAmountMinor: requestedAmountMinor,
                });

            if (existingCodCollection && (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COMPLETED)) {
                // Another tab (or person) already did this: say so, record nothing (R3-ORD-10).
                throw new ConflictError(
                    `Cash for this order was already recorded as collected by ${existingCodCollection.collectedBy}.`,
                );
            }
            if (existingCodCollection) {
                if (existingCodCollection.amountMinor !== requestedAmountMinor) {
                    throw new ValidationError("COD collection was already recorded with a different amount.", {
                        recordedAmount: fromMinor(existingCodCollection.amountMinor, currency.decimalPlaces),
                        collectedAmount: fromMinor(requestedAmountMinor, currency.decimalPlaces),
                    });
                }
                const requestedCollector = typeof body.collectedBy === "string"
                    ? body.collectedBy.trim()
                    : "";
                if (!requestedCollector || existingCodCollection.collectedBy !== requestedCollector) {
                    throw new ValidationError(
                        "Cash collection was already recorded by a different collector.",
                    );
                }
            }

            // Cash is handed over at the door, so a shipped order becomes
            // delivered. Collection never skips the shipment (ORD-01).
            const currentVersion = order.version;
            const currentStatus = order.status;
            let statusClaim: { claimedStatus: string; claimedVersion: number } | null = null;
            const rollbackStatusClaim = async () => {
                if (!statusClaim) return;
                await rollbackOrderStatusIfInventoryUnchanged(db, {
                    orderId,
                    previousStatus: order.status,
                    claimedStatus: statusClaim.claimedStatus,
                    claimedVersion: statusClaim.claimedVersion,
                    previousInventoryAction: order.inventoryAction as string,
                });
            };
            if (currentStatus !== OrderStatus.DELIVERED) {
                validateTransition("order", currentStatus, OrderStatus.DELIVERED);
                const deliveredVersion = currentVersion + 1;
                const delResult = await db.update(orders).set({ status: OrderStatus.DELIVERED, version: currentVersion + 1, updatedAt: sql`unixepoch()` }).where(and(
                    eq(orders.id, orderId),
                    eq(orders.version, currentVersion),
                    noActiveRefundAttemptForOrderIdCondition(orderId),
                    noActivePaymentSessionAttemptForOrderIdCondition(orderId),
                )).returning({ id: orders.id });
                if (delResult.length === 0) {
                    await rollbackStatusClaim();
                    throw new ConflictError("This order changed. Reload to see the latest.");
                }
                statusClaim = {
                    claimedStatus: OrderStatus.DELIVERED,
                    claimedVersion: deliveredVersion,
                };
            }
            try {
                const colResult = await recordCODCollection(db, {
                    orderId,
                    collectedBy: collection?.collectedBy ?? existingCodCollection!.collectedBy,
                    collectedAmountMinor: collection?.collectedAmountMinor ?? existingCodCollection!.amountMinor,
                    receiptUrl: body.receiptUrl as string | undefined,
                });
                if (!colResult.success) throw new ValidationError(colResult.error || "COD collection failed");
            } catch (error: unknown) {
                await rollbackStatusClaim();
                throw error;
            }
            try {
                const availabilityTransitionVariantIds = await reconcileInventoryForStatus(
                    db,
                    orderId,
                    OrderStatus.DELIVERED,
                );
                await markManualDeliveryEvidence(db, orderId);
                return {
                    message: "COD collection recorded",
                    availabilityTransitionVariantIds,
                };
            } catch (error: unknown) {
                await rollbackStatusClaim();
                throw error;
            }
        }
        case "failed": {
            // A part-sent order has a parcel out too: its failed attempt is recorded the same way.
            const partSent = order.status === OrderStatus.CONFIRMED && order.fulfillmentStatus === FulfillmentStatus.PARTIAL;
            if (!partSent) assertOrderCodActionAllowed(order.status, "failed");
            const failResult = await recordCODFailure(db, { orderId, reason: body.reason as "other" | "not_home" | "refused" | "no_cash" | "wrong_address", notes: body.notes as string | undefined });
            if (!failResult.success) throw new ValidationError(failResult.error || "COD failure recording failed");
            await setOpenOwnCourierParcels(db, orderId, ShipmentStatus.DELIVERY_FAILED);
            return {
                message: "COD failure recorded",
                availabilityTransitionVariantIds: [],
            };
        }
        case "returned": {
            assertOrderCodActionAllowed(order.status, "returned");

            const sourceReferenceId = `cod-rts:${orderId}`;
            let returnRecord = (await listOrderReturns(db, orderId)).find(
                (candidate) => candidate.source === "cod_return_to_sender"
                    && candidate.sourceReferenceId === sourceReferenceId,
            );
            if (!returnRecord) {
                const sentItems = await db.select({
                    id: orderItems.id,
                    shippedQuantity: orderItems.shippedQuantity,
                }).from(orderItems).where(and(
                    eq(orderItems.orderId, orderId),
                    sql`${orderItems.shippedQuantity} > 0`,
                )).all();
                if (sentItems.length === 0) {
                    throw new ValidationError("Nothing from this order was sent, so nothing can come back.");
                }
                const createdReturn = await createOrderReturn(db, orderId, {
                    commandKey: `cod-rts-create:${orderId}`,
                    expectedOrderVersion: order.version,
                    reason: COURIER_RETURN_REASON,
                    notes: typeof body.notes === "string" ? body.notes : null,
                    lines: sentItems.map((item) => ({
                        orderItemId: item.id,
                        quantity: item.shippedQuantity,
                        reason: COURIER_RETURN_REASON,
                    })),
                }, { type: "system", id: "cod" }, {
                    source: "cod_return_to_sender",
                    sourceReferenceId,
                });
                returnRecord = await getOrderReturn(db, orderId, createdReturn.returnId);
            }
            if (returnRecord.status === "requested") {
                await approveOrderReturn(db, orderId, returnRecord.id, {
                    commandKey: `cod-rts-approve:${orderId}`,
                    expectedVersion: returnRecord.version,
                    notes: null,
                    lines: returnRecord.lines.map((line) => ({
                        lineId: line.id,
                        approvedQuantity: line.requestedQuantity,
                        rejectedQuantity: 0,
                    })),
                }, { type: "system", id: "cod" });
            }
            const retResult = await markCODReturned(db, orderId);
            if (!retResult.success) throw new ValidationError(retResult.error || "COD return failed");
            // Returned to sender is a closing state right away: no cash is
            // owed and the order leaves the courier views. Stock comes back
            // only when the parcel is received on the return (ORD-02).
            await markOrderReturnedToSender(db, orderId);
            return {
                message: "Order returned. Receive the items when they arrive.",
                returnId: returnRecord.id,
                availabilityTransitionVariantIds: [],
            };
        }
        default:
            throw new ValidationError("Invalid action");
    }
}

const COURIER_RETURN_REASON = "Returned by the courier";

/**
 * Own-courier parcels follow what the merchant records for the order, so the
 * list, the detail page and the export agree: a failed attempt fails every
 * parcel still out, and a return to sender returns every parcel not delivered
 * (R2-ORD-05). Courier-booked parcels keep the courier's own status.
 */
async function setOpenOwnCourierParcels(
    db: Database,
    orderId: string,
    status: typeof ShipmentStatus.DELIVERY_FAILED | typeof ShipmentStatus.RETURNED,
): Promise<void> {
    const settled = status === ShipmentStatus.RETURNED
        ? [ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED, ShipmentStatus.CANCELLED, ShipmentStatus.FAILED]
        : [ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED, ShipmentStatus.CANCELLED, ShipmentStatus.FAILED, ShipmentStatus.DELIVERY_FAILED];
    await db.update(deliveryShipments).set({
        status,
        rawStatus: status,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(deliveryShipments.orderId, orderId),
        eq(deliveryShipments.providerType, "manual"),
        sql`${deliveryShipments.providerId} IS NULL`,
        notInArray(deliveryShipments.status, settled),
    ));
}

async function markOrderReturnedToSender(db: Database, orderId: string): Promise<void> {
    const current = await db.select({ status: orders.status, version: orders.version })
        .from(orders).where(eq(orders.id, orderId)).get();
    if (!current || current.status === OrderStatus.RETURNED) return;
    validateTransition("order", current.status, OrderStatus.RETURNED);
    const updated = await db.update(orders).set({
        status: OrderStatus.RETURNED,
        version: current.version + 1,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, current.version),
        inArray(orders.status, [OrderStatus.SHIPPED, OrderStatus.DELIVERED]),
    )).returning({ id: orders.id });
    if (updated.length === 0) {
        throw new ConflictError("This order changed. Reload to see the latest.");
    }
    await setOpenOwnCourierParcels(db, orderId, ShipmentStatus.RETURNED);
}

/**
 * Delivered for an order paid online and sent in full by the merchant's own
 * rider. (Cash-on-delivery orders are delivered by recording the cash.)
 */
export async function markOrderDelivered(db: Database, orderId: string): Promise<StatusUpdateResult> {
    const order = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COMPLETED) {
        return { message: "Already delivered", availabilityTransitionVariantIds: [] };
    }
    const left = await db.select({
        unsent: sql<number>`coalesce(sum(${orderItems.quantity} - ${orderItems.shippedQuantity}), 0)`,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).get();
    const unsent = Number(left?.unsent ?? 0);
    if (order.status !== OrderStatus.SHIPPED || unsent > 0) {
        throw new ValidationError(unsent === 1
            ? "1 item hasn't been sent yet. Send it first."
            : unsent > 1
                ? `${unsent} items haven't been sent yet. Send them first.`
                : "Send the order first.");
    }
    return applyOrderStatusChange(db, orderId, OrderStatus.DELIVERED, undefined, { generic: false });
}
