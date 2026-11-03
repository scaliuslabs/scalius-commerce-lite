// Bulk shipping and bulk fulfilment actions.
import type { Database } from "@scalius/database/client";
import {
    orders,
    deliveryShipments,
    OrderStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import {
  type CourierProvidersSource,
  createShipment,
  getDeliveryProviderActionReadiness,
  markShipmentReconciliationRequired,
  PROVIDER_OUTCOME_UNKNOWN,
} from "../delivery";
import {
  assertNoActivePaymentSessionAttempt,
  assertNoActiveRefundAttempt,
  expiredShipmentClaimCondition,
  isShipmentClaimLeaseLive,
  noActivePaymentSessionAttemptForOrderIdCondition,
  noActiveRefundAttemptForOrderIdCondition,
  noActiveShipmentClaimCondition,
  SHIPMENT_CLAIM_CONFLICT_MESSAGE,
  SHIPMENT_CLAIM_LEASE_SECONDS,
  validateTransition,
} from "../order-kernel";
import { sql, eq, and, asc } from "drizzle-orm";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import {
  assertOrderNotOnHold,
  type BulkOrderActionResult,
  bulkShipOrderSchema,
  noOpenOrderHoldCondition,
  reconcileInventoryForStatus,
  type ShipmentCreationOptionsInput,
} from "../orders";
import {
    clearShipmentClaim,
    findShipmentByRequestKey,
    SENDABLE_ORDER_STATUSES,
} from "./shared";
import { recordCourierBookingFulfilment, recordOrderFulfilment } from "./ledger";

function createShipmentClaimId(): string {
    return `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function holdShipmentClaimForReconciliation(db: Database, orderId: string, claimId: string): Promise<void> {
    await db
        .update(orders)
        .set({
            shipmentClaimExpiresAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orders.id, orderId),
            eq(orders.shipmentClaimId, claimId),
        ));
}

/**
 * Settles a claim whose lease ran out: an attempt that left no row, or a
 * failed or cancelled one, releases the order; anything else (a `creating`
 * row whose invocation died, or a booked row the order never caught up with)
 * becomes a reconciliation the dashboard resolves, held without expiry.
 */
export async function resolveExpiredShipmentClaim(
    db: Database,
    orderId: string,
    claimId: string,
): Promise<{ blocked: true; result: Record<string, unknown> } | { blocked: false }> {
    const shipment = await db
        .select({
            id: deliveryShipments.id,
            status: deliveryShipments.status,
            externalId: deliveryShipments.externalId,
            trackingId: deliveryShipments.trackingId,
            metadata: deliveryShipments.metadata,
        })
        .from(deliveryShipments)
        .where(eq(deliveryShipments.id, claimId))
        .get();

    if (!shipment || shipment.status === ShipmentStatus.FAILED || shipment.status === ShipmentStatus.CANCELLED) {
        await clearShipmentClaim(db, orderId, claimId);
        return { blocked: false };
    }

    if (shipment.status !== ShipmentStatus.RECONCILE_REQUIRED) {
        const outcomeUnknown = shipment.status === "creating" && !shipment.externalId && !shipment.trackingId;
        await markShipmentReconciliationRequired(
            db,
            claimId,
            outcomeUnknown ? PROVIDER_OUTCOME_UNKNOWN : "expired_order_shipment_claim",
            outcomeUnknown ? undefined : {
                externalId: shipment.externalId ?? undefined,
                trackingId: shipment.trackingId ?? undefined,
                status: shipment.status,
            },
        );
    }
    await holdShipmentClaimForReconciliation(db, orderId, claimId);
    return {
        blocked: true,
        result: {
            orderId,
            success: false,
            reconciliationRequired: true,
            shipmentId: claimId,
            error: "Previous shipment creation attempt requires reconciliation before retry.",
        },
    };
}

export const EXPIRED_SHIPMENT_CLAIM_SWEEP_LIMIT = 25;

export interface ExpiredShipmentClaimSweepResult {
    scanned: number;
    released: number;
    held: number;
    failed: number;
    hasMore: boolean;
}

/**
 * The maintenance backstop for dead courier bookings: every order whose
 * shipment claim lease ran out is resolved (`resolveExpiredShipmentClaim`),
 * oldest lease first. Held claims lose their expiry, so they leave this range.
 */
export async function sweepExpiredShipmentClaims(
    db: Database,
    options: { limit?: number } = {},
): Promise<ExpiredShipmentClaimSweepResult> {
    const limit = Math.max(1, Math.min(EXPIRED_SHIPMENT_CLAIM_SWEEP_LIMIT * 4, Math.floor(options.limit ?? EXPIRED_SHIPMENT_CLAIM_SWEEP_LIMIT)));
    const rows = await db
        .select({ id: orders.id, shipmentClaimId: orders.shipmentClaimId })
        .from(orders)
        .where(expiredShipmentClaimCondition())
        .orderBy(asc(orders.shipmentClaimExpiresAt), asc(orders.id))
        .limit(limit + 1)
        .all();
    const result: ExpiredShipmentClaimSweepResult = {
        scanned: Math.min(rows.length, limit),
        released: 0,
        held: 0,
        failed: 0,
        hasMore: rows.length > limit,
    };
    for (const row of rows.slice(0, limit)) {
        if (!row.shipmentClaimId) continue;
        try {
            const outcome = await resolveExpiredShipmentClaim(db, row.id, row.shipmentClaimId);
            if (outcome.blocked) result.held += 1;
            else result.released += 1;
        } catch (error) {
            result.failed += 1;
            console.error(`[fulfilment] Expired shipment claim ${row.shipmentClaimId} of order ${row.id} could not be resolved:`, error);
        }
    }
    return result;
}

export async function bulkShipOrders(
    db: Database,
    orderIds: string[],
    providerId: string,
    options: ShipmentCreationOptionsInput | undefined,
    encryptionKey?: string,
    /** The request's couriers (the active courier apps'); absent: none. */
    couriers?: CourierProvidersSource,
) {
    const parsedInput = bulkShipOrderSchema.safeParse({
        orderIds,
        providerId,
        options,
    });
    if (!parsedInput.success) {
        throw new ValidationError(
            parsedInput.error.issues[0]?.message ?? "Invalid bulk shipment request",
        );
    }
    const validatedOrderIds = parsedInput.data.orderIds;
    const validatedProviderId = parsedInput.data.providerId;
    const validatedOptions = parsedInput.data.options ?? {};
    const results = [];
    const providerReadiness = await getDeliveryProviderActionReadiness(
        db,
        validatedProviderId,
        encryptionKey,
        couriers,
    );
    if (!providerReadiness.ready) {
        return validatedOrderIds.map((orderId) => ({
            orderId,
            success: false,
            error: providerReadiness.message,
        }));
    }

    for (const orderId of validatedOrderIds) {
        try {
            const order = await db.select({
                status: orders.status,
                version: orders.version,
                shipmentClaimId: orders.shipmentClaimId,
                shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            }).from(orders).where(eq(orders.id, orderId)).get();
            if (!order) throw new NotFoundError(`Order ${orderId} not found`);
            await assertNoActiveRefundAttempt(db, orderId, {
                message: "Order has an active refund operation. Complete or reconcile the refund before shipping this order.",
            });
            await assertNoActivePaymentSessionAttempt(db, orderId);
            if (order.status === OrderStatus.SHIPPED) {
                await recordCourierBookingFulfilment(db, orderId, order.shipmentClaimId ?? null);
                const availabilityTransitionVariantIds = await reconcileInventoryForStatus(
                    db,
                    orderId,
                    OrderStatus.SHIPPED,
                );
                if (order.shipmentClaimId) {
                    await clearShipmentClaim(db, orderId, order.shipmentClaimId);
                }
                results.push({
                    orderId,
                    success: true,
                    message: "Order already shipped; inventory reconciled",
                    availabilityTransitionVariantIds,
                });
                continue;
            }
            if (isShipmentClaimLeaseLive(order)) {
                results.push({ orderId, success: false, error: SHIPMENT_CLAIM_CONFLICT_MESSAGE });
                continue;
            }
            if (order.shipmentClaimId) {
                const expiredClaim = await resolveExpiredShipmentClaim(db, orderId, order.shipmentClaimId);
                if (expiredClaim.blocked) {
                    results.push(expiredClaim.result);
                    continue;
                }
            }
            validateTransition("order", order.status, OrderStatus.SHIPPED);
            await assertOrderNotOnHold(db, orderId);

            const claimId = createShipmentClaimId();
            const claimResult = await db.update(orders).set({
                shipmentClaimId: claimId,
                shipmentClaimExpiresAt: sql`unixepoch() + ${SHIPMENT_CLAIM_LEASE_SECONDS}`,
                version: order.version + 1,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orders.id, orderId),
                eq(orders.version, order.version),
                eq(orders.status, order.status),
                noActiveShipmentClaimCondition(),
                noOpenOrderHoldCondition(orderId),
                noActiveRefundAttemptForOrderIdCondition(orderId),
                noActivePaymentSessionAttemptForOrderIdCondition(orderId),
            )).returning({ id: orders.id });

            if (claimResult.length === 0) {
                results.push({ orderId, success: false, error: "Order was modified concurrently" });
                continue;
            }

            const shipment = await createShipment(
                db,
                orderId,
                validatedProviderId,
                validatedOptions,
                encryptionKey,
                { shipmentId: claimId, couriers },
            );
            if (shipment.reconciliationRequired) {
                await holdShipmentClaimForReconciliation(db, orderId, claimId);
                results.push({
                    orderId,
                    success: false,
                    shipmentId: claimId,
                    reconciliationRequired: true,
                    error: shipment.message,
                });
                continue;
            }
            let availabilityTransitionVariantIds: string[] = [];
            if (shipment.success) {
                // CAS update first — only apply inventory if we win the version check
                const casResult = await db.update(orders).set({
                    status: OrderStatus.SHIPPED,
                    version: order.version + 2,
                    updatedAt: sql`unixepoch()`,
                }).where(and(
                    eq(orders.id, orderId),
                    eq(orders.version, order.version + 1),
                    eq(orders.shipmentClaimId, claimId),
                )).returning({ id: orders.id });

                if (casResult.length === 0) {
                    await markShipmentReconciliationRequired(
                        db,
                        claimId,
                        "order_final_cas_conflict",
                        shipment.data,
                        "Order was modified concurrently after provider shipment creation",
                    );
                    await holdShipmentClaimForReconciliation(db, orderId, claimId);
                    results.push({
                        orderId,
                        success: false,
                        shipmentId: claimId,
                        reconciliationRequired: true,
                        error: "Shipment was created but order finalization requires reconciliation",
                    });
                    continue;
                }

                try {
                    await recordCourierBookingFulfilment(db, orderId, claimId);
                    availabilityTransitionVariantIds = await reconcileInventoryForStatus(
                        db,
                        orderId,
                        OrderStatus.SHIPPED,
                    );
                    await clearShipmentClaim(db, orderId, claimId);
                } catch (error: unknown) {
                    await markShipmentReconciliationRequired(
                        db,
                        claimId,
                        "order_status_inventory_reconcile_failed",
                        {
                            externalId: shipment.data?.externalId,
                            trackingId: shipment.data?.trackingId,
                            status: shipment.data?.status ?? ShipmentStatus.PENDING,
                            metadata: {
                                ...(shipment.data?.metadata ?? {}),
                                orderStatusSync: {
                                    shipmentStatus: shipment.data?.status ?? ShipmentStatus.PENDING,
                                    orderStatus: OrderStatus.SHIPPED,
                                    failedStep: "inventory_reconciliation",
                                },
                            },
                        },
                        error,
                    );
                    await holdShipmentClaimForReconciliation(db, orderId, claimId);
                    results.push({
                        orderId,
                        success: false,
                        shipmentId: claimId,
                        reconciliationRequired: true,
                        error: "Shipment was created but inventory reconciliation requires repair",
                    });
                    continue;
                }
            } else {
                await clearShipmentClaim(db, orderId, claimId);
            }
            results.push({
                orderId,
                success: shipment.success,
                shipment: shipment.success ? shipment : undefined,
                error: shipment.success ? undefined : shipment.message,
                availabilityTransitionVariantIds,
            });
        } catch (error: unknown) {
            results.push({ orderId, success: false, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return results;
}

/** One order's own-rider parcel from a bulk "Mark as sent". */
export interface BulkFulfilledParcel {
    shipmentId: string;
    /** What the parcel holds, for the timeline. */
    lines: Array<{ itemId: string; quantity: number }>;
    statusChange?: { orderId: string; previousStatus: string; newStatus: string; version: number };
    /** Internal cache signal; API responses must not expose it. */
    availabilityTransitionVariantIds: string[];
}

/**
 * Own-courier "Mark as sent" for whole confirmed orders. With a request key,
 * running the same selection again reports the orders it already sent as done.
 */
export async function bulkFulfillOrders(
    db: Database,
    orderIds: readonly string[],
    options: { courierName?: string; note?: string; requestKey?: string },
) {
    const results: Array<BulkOrderActionResult & { shipment?: BulkFulfilledParcel }> = [];
    const shipmentKey = options.requestKey ? `bulk:${options.requestKey}` : null;
    for (const orderId of orderIds) {
        try {
            const order = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).get();
            if (!order) throw new NotFoundError("Order not found");
            if (shipmentKey && await findShipmentByRequestKey(db, orderId, shipmentKey)) {
                results.push({ orderId, success: true });
                continue;
            }
            if (order.status !== OrderStatus.CONFIRMED) {
                results.push({
                    orderId,
                    success: false,
                    error: SENDABLE_ORDER_STATUSES.has(order.status)
                        ? "This order was already sent."
                        : "Confirm the order before sending it.",
                });
                continue;
            }
            const sent = await recordOrderFulfilment(db, orderId, {
                requestKey: shipmentKey ?? `bulk:${crypto.randomUUID()}`,
                kind: "ship",
                parcel: { courierName: options.courierName, note: options.note },
            }, { type: "admin", id: null });
            results.push({
                orderId,
                success: true,
                shipment: {
                    shipmentId: sent.shipmentId ?? sent.fulfillmentId,
                    lines: sent.lines.map((line) => ({ itemId: line.orderItemId, quantity: line.quantity })),
                    statusChange: sent.statusChange,
                    availabilityTransitionVariantIds: sent.availabilityTransitionVariantIds,
                },
            });
        } catch (error: unknown) {
            results.push({ orderId, success: false, error: error instanceof Error ? error.message : "Couldn't send this order." });
        }
    }
    return results;
}
