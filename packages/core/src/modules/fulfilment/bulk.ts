// Bulk shipping and bulk fulfilment actions.
import type { Database } from "@scalius/database/client";
import {
    orders,
    deliveryShipments,
    OrderStatus,
    FulfillmentStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import {
    createShipment,
    getDeliveryProviderActionReadiness,
    markShipmentReconciliationRequired,
} from "../delivery/delivery.service";
import { PROVIDER_OUTCOME_UNKNOWN } from "../delivery/types";
import {
    assertNoActiveRefundAttempt,
    noActiveRefundAttemptForOrderIdCondition,
} from "../payments/refund-attempt-guard";
import {
    assertNoActivePaymentSessionAttempt,
    noActivePaymentSessionAttemptForOrderIdCondition,
} from "../payments/payment-session-attempts";
import { sql, eq, and } from "drizzle-orm";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { validateTransition } from "../orders/status/state-machine";
import {
    hasActiveShipmentClaim,
    noActiveShipmentClaimCondition,
    SHIPMENT_CLAIM_CONFLICT_MESSAGE,
    SHIPMENT_CLAIM_LEASE_SECONDS,
} from "../orders/shipment-claim";
import { bulkShipOrderSchema, type ShipmentCreationOptionsInput } from "../orders/validation";
import {
    clearShipmentClaim,
    findShipmentByRequestKey,
    SENDABLE_ORDER_STATUSES,
} from "./shared";
import { reconcileInventoryForStatus, type BulkOrderActionResult } from "../orders/status/lifecycle";
import { createFulfillmentShipment } from "./shipments";
import { recordCourierBookingFulfilment } from "./ledger";

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

async function resolveExpiredShipmentClaim(
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

export async function bulkShipOrders(
    db: Database,
    orderIds: string[],
    providerId: string,
    options: ShipmentCreationOptionsInput | undefined,
    encryptionKey?: string,
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
            if (hasActiveShipmentClaim(order)) {
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
                { shipmentId: claimId },
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
                    fulfillmentStatus: FulfillmentStatus.COMPLETE,
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

/**
 * Own-courier "Mark as sent" for whole confirmed orders. With a request key,
 * running the same selection again reports the orders it already sent as done.
 */
export async function bulkFulfillOrders(
    db: Database,
    orderIds: readonly string[],
    options: { courierName?: string; note?: string; requestKey?: string },
) {
    const results: Array<BulkOrderActionResult & { shipment?: Awaited<ReturnType<typeof createFulfillmentShipment>> }> = [];
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
            const shipment = await createFulfillmentShipment(db, orderId, {
                courierName: options.courierName,
                note: options.note,
                ...(shipmentKey ? { requestKey: shipmentKey } : {}),
            });
            results.push({ orderId, success: true, shipment });
        } catch (error: unknown) {
            results.push({ orderId, success: false, error: error instanceof Error ? error.message : "Couldn't send this order." });
        }
    }
    return results;
}
