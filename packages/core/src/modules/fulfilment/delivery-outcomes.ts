// Delivery outcomes: delivered, and COD collected, failed or returned.
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
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
  prepareCODCollection,
  recordCODFailure,
  resolveOrderCurrencySnapshot,
  toCashOnDeliveryMinor,
  validateCODCollectionDetails,
} from "../payments";
import {
  assertNoActivePaymentSessionAttempt,
  assertNoActiveRefundAttempt,
  assertNoActiveShipmentClaim,
  validateTransition,
} from "../order-kernel";
import { sql, eq, and, inArray, notInArray } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { fromMinor } from "@scalius/shared/money";
import {
  applyOrderStatusChange,
  approveOrderReturn,
  assertOrderCodActionAllowed,
  buildOrderEventInsert,
  createOrderReturn,
  getOrderReturn,
  getRecordedCodCollection,
  listOrderReturns,
  orderEventIdForRequest,
  type OrderStatusChangeOptions,
  type StatusUpdateResult,
} from "../orders";
import { buildOrderNotificationOutboxInsert } from "../notifications";

/**
 * Records a cash on delivery outcome. Collected and returned write their
 * timeline line and customer message (`outboxIds`, for the caller's sender)
 * in the same batch as the change.
 */
export async function processCodAction(
    db: Database,
    orderId: string,
    body: Record<string, unknown>,
    context: { actorId?: string | null } = {},
): Promise<{ message: string; availabilityTransitionVariantIds: string[]; outboxIds: string[]; returnId?: string }> {
    const order = await db.select({
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        requiresShipping: orders.requiresShipping,
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
            assertOrderCodActionAllowed(order.status, "collected", { requiresShipping: order.requiresShipping });
            const requestedAmount = body.collectedAmount;
            if (typeof requestedAmount !== "number" || !Number.isFinite(requestedAmount) || requestedAmount <= 0) {
                throw new ValidationError("COD collected amount must be a positive finite number.");
            }
            const requestedAmountMinor = toCashOnDeliveryMinor(requestedAmount, currency);
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
            // delivered. Collection never skips the shipment (ORD-01). The
            // cash record, the delivered status, its stock, the timeline line
            // and the customer message are one batch: a death between them
            // cannot leave a delivered order without its cash or its stock.
            const collected = {
                orderId,
                collectedBy: collection?.collectedBy ?? existingCodCollection!.collectedBy,
                collectedAmountMinor: collection?.collectedAmountMinor ?? existingCodCollection!.amountMinor,
                receiptUrl: body.receiptUrl as string | undefined,
            };
            const result = await applyOrderStatusChange(db, orderId, OrderStatus.DELIVERED, undefined, {
                generic: false,
                before: async () => {
                    const prepared = await prepareCODCollection(db, collected);
                    return prepared.alreadyRecorded ? null : prepared;
                },
                announceUnchanged: true,
                event: {
                    kind: "cod_collected",
                    actorId: context.actorId ?? null,
                    // One collection per order: a repeat writes no second line.
                    requestKey: "cod-collected",
                    data: { amount: fromMinor(collected.collectedAmountMinor, currency.decimalPlaces), collectedBy: collected.collectedBy },
                },
                notify: {
                    source: "orders-cod-action",
                    notificationType: "order_delivered",
                    dedupeKey: `cod:${orderId}:collected`,
                },
            });
            return {
                message: "COD collection recorded",
                availabilityTransitionVariantIds: result.availabilityTransitionVariantIds,
                outboxIds: result.outboxIds ?? [],
            };
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
                outboxIds: [],
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
                // What was handed over, by the ledger, is what can come back.
                const sentItems = await db.select({
                    id: orderItems.id,
                    fulfilledQuantity: orderItems.fulfilledQuantity,
                }).from(orderItems).where(and(
                    eq(orderItems.orderId, orderId),
                    inArray(orderItems.fulfillmentType, ["ship", "pickup"]),
                    sql`${orderItems.fulfilledQuantity} > 0`,
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
                        quantity: item.fulfilledQuantity,
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
            const outboxIds = await markOrderReturnedToSender(db, orderId, context.actorId ?? null);
            return {
                message: "Order returned. Receive the items when they arrive.",
                returnId: returnRecord.id,
                availabilityTransitionVariantIds: [],
                outboxIds,
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
    await openOwnCourierParcelsUpdate(db, orderId, status);
}

function openOwnCourierParcelsUpdate(
    db: Database,
    orderId: string,
    status: typeof ShipmentStatus.DELIVERY_FAILED | typeof ShipmentStatus.RETURNED,
) {
    const settled = status === ShipmentStatus.RETURNED
        ? [ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED, ShipmentStatus.CANCELLED, ShipmentStatus.FAILED]
        : [ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED, ShipmentStatus.CANCELLED, ShipmentStatus.FAILED, ShipmentStatus.DELIVERY_FAILED];
    return db.update(deliveryShipments).set({
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

/** Returned to sender, with its parcels, timeline line and customer message in one batch. */
async function markOrderReturnedToSender(db: Database, orderId: string, actorId: string | null): Promise<string[]> {
    const current = await db.select({ status: orders.status, version: orders.version })
        .from(orders).where(eq(orders.id, orderId)).get();
    if (!current || current.status === OrderStatus.RETURNED) return [];
    validateTransition("order", current.status, OrderStatus.RETURNED);
    const version = current.version + 1;
    const landed = sql`EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${orderId} AND ${orders.version} = ${version} AND ${orders.status} = ${OrderStatus.RETURNED}
    )`;
    const outbox = buildOrderNotificationOutboxInsert(db, {
        orderId,
        notificationType: "order_returned",
        dedupeKey: `cod:${orderId}:returned`,
        source: "orders-cod-action",
    }, landed);
    const returnable = and(
        eq(orders.id, orderId),
        eq(orders.version, current.version),
        inArray(orders.status, [OrderStatus.SHIPPED, OrderStatus.DELIVERED]),
    )!;
    try {
        await safeBatch(db, [
            // The CAS's own precondition first: a lost CAS writes nothing,
            // even when another writer reached the same version and status.
            buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${returnable})`, RETURNED_TO_SENDER_CONFLICT),
            db.update(orders).set({
                status: OrderStatus.RETURNED,
                version,
                updatedAt: sql`unixepoch()`,
            }).where(returnable),
            openOwnCourierParcelsUpdate(db, orderId, ShipmentStatus.RETURNED),
            buildOrderEventInsert(db, {
                id: await orderEventIdForRequest(orderId, "cod_returned", "cod-returned"),
                orderId,
                kind: "cod_returned",
                actorId,
            }, landed),
            outbox.statement,
        ] as never);
    } catch (error: unknown) {
        if (isBatchGuardError(error, RETURNED_TO_SENDER_CONFLICT)) {
            // A repeat (double click) that lost to the first: it is returned, as asked.
            const now = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).get();
            if (now?.status === OrderStatus.RETURNED) return [];
            throw new ConflictError("This order changed. Reload to see the latest.");
        }
        throw error;
    }
    return [outbox.outboxId];
}

const RETURNED_TO_SENDER_CONFLICT = "returned_to_sender_conflict";

/**
 * Delivered for an order paid online and sent in full by the merchant's own
 * rider. (Cash-on-delivery orders are delivered by recording the cash.)
 */
export async function markOrderDelivered(
    db: Database,
    orderId: string,
    /** The order version the caller read; a change since refuses (exact under the status write's version CAS). */
    options: { expectedVersion?: number } = {},
    /** The timeline line and customer message, written with the change. */
    record: Pick<OrderStatusChangeOptions, "event" | "notify"> = {},
): Promise<StatusUpdateResult> {
    const order = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COMPLETED) {
        return { message: "Already delivered", availabilityTransitionVariantIds: [] };
    }
    const left = await db.select({
        unsent: sql<number>`coalesce(sum(${orderItems.quantity} - ${orderItems.fulfilledQuantity}), 0)`,
    }).from(orderItems).where(and(
        eq(orderItems.orderId, orderId),
        eq(orderItems.fulfillmentType, "ship"),
    )).get();
    const unsent = Number(left?.unsent ?? 0);
    if (order.status !== OrderStatus.SHIPPED || unsent > 0) {
        throw new ValidationError(unsent === 1
            ? "1 item hasn't been sent yet. Send it first."
            : unsent > 1
                ? `${unsent} items haven't been sent yet. Send them first.`
                : "Send the order first.");
    }
    // A cash on delivery order may be delivered before its cash is remitted;
    // Collect cash records the money later (allowed on a delivered order).
    return applyOrderStatusChange(db, orderId, OrderStatus.DELIVERED, { expectedVersion: options.expectedVersion }, { generic: false, codCashPending: true, ...record });
}
