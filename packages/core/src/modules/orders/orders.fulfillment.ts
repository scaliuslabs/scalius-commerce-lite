// src/modules/orders/orders.fulfillment.ts
// Fulfillment and status update functions for orders.

import type { Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    codTracking,
    deliveryShipments,
    CodStatus,
    OrderStatus,
    FulfillmentStatus,
    ItemFulfillmentStatus,
    PaymentMethod,
    PaymentRecordStatus,
    PaymentStatus,
    ShipmentStatus,
    orderPayments,
} from "@scalius/database/schema";
import { applyInventoryForStatusChangeWithImpact } from "../inventory/inventory-transitions";
import { markCODReturned, recordCODCollection, recordCODFailure, validateCODCollectionDetails } from "../payments/cod";
import { createShipment, getDeliveryProviderActionReadiness, markShipmentReconciliationRequired } from "../delivery/delivery.service";
import {
    assertNoActiveRefundAttempt,
    noActiveRefundAttemptForOrderIdCondition,
} from "../payments/refund-attempt-guard";
import {
    assertNoActivePaymentSessionAttempt,
    noActivePaymentSessionAttemptForOrderIdCondition,
} from "../payments/payment-session-attempts";

import { sql, eq, and } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import {
    canProcessOrderCodAction,
    normalizeOrderStatus,
    type OrderCodAction,
} from "@scalius/shared/order-state";
import {
    assertOrderPaymentCurrency,
    orderMoneyEqual,
    resolveOrderCurrencySnapshot,
    roundOrderMoney,
    type OrderCurrencySnapshot,
} from "../payments/order-currency";
import { validateTransition } from "./order-state-machine";
import type { OrderShipmentReconciliationResult, StatusUpdateResult } from "./orders.types";
import type { OrderNotificationType } from "../notifications/notification-types";
import { buildOrderStatusNotificationDedupeKey } from "../notifications/order-notification-outbox";
import {
    assertNoActiveShipmentClaim,
    hasActiveShipmentClaim,
    noActiveShipmentClaimCondition,
    SHIPMENT_CLAIM_CONFLICT_MESSAGE,
    SHIPMENT_CLAIM_LEASE_SECONDS,
} from "./shipment-claim";
import { rollbackOrderStatusIfInventoryUnchanged } from "./order-status-claim";
import { assertGenericAdminOrderStatusTransition } from "./admin-status-policy";
import {
    approveOrderReturn,
    createOrderReturn,
    getOrderReturn,
    listOrderReturns,
} from "./order-returns";
import {
    bulkShipOrderSchema,
    type ShipmentCreationOptionsInput,
} from "./orders.validation";

async function reconcileInventoryForStatus(
    db: Database,
    orderId: string,
    status: string,
): Promise<string[]> {
    const impact = await applyInventoryForStatusChangeWithImpact(db, orderId, status);
    await db.update(orders).set({ inventoryAction: impact.inventoryAction }).where(eq(orders.id, orderId));
    return impact.availabilityTransitionVariantIds;
}

function assertOrderCodActionAllowed(status: string, action: OrderCodAction): void {
    if (canProcessOrderCodAction(status, action)) return;
    const actionLabel = action === "collected"
        ? "collection"
        : action === "failed"
            ? "failure"
            : "return";
    throw new ValidationError(
        `COD ${actionLabel} cannot be recorded while the order is ${status}.`,
    );
}

/**
 * A provider-less fulfillment is operated entirely by the merchant, so a
 * merchant-confirmed delivered order is also its delivery authority. Keep
 * provider shipments untouched: their status remains owned by provider sync.
 *
 * The batch is intentionally idempotent. COD/status retries can repair legacy
 * rows that reached delivered order state while their manual shipment still
 * said processing and their line items still said shipped.
 */
async function markManualDeliveryEvidence(
    db: Database,
    orderId: string,
): Promise<void> {
    const writes = [
        db.update(orderItems).set({
            fulfillmentStatus: ItemFulfillmentStatus.DELIVERED,
        }).where(and(
            eq(orderItems.orderId, orderId),
            eq(orderItems.fulfillmentStatus, ItemFulfillmentStatus.SHIPPED),
        )),
        db.update(deliveryShipments).set({
            status: ShipmentStatus.DELIVERED,
            rawStatus: ShipmentStatus.DELIVERED,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(deliveryShipments.orderId, orderId),
            eq(deliveryShipments.providerType, "manual"),
            sql`${deliveryShipments.providerId} IS NULL`,
            sql`${deliveryShipments.status} NOT IN (
                ${ShipmentStatus.DELIVERED},
                ${ShipmentStatus.RETURNED},
                ${ShipmentStatus.CANCELLED},
                ${ShipmentStatus.FAILED},
                ${ShipmentStatus.DELIVERY_FAILED}
            )`,
        )),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(writes as any);
}

function parseShipmentMetadata(metadata: unknown): Record<string, unknown> {
    if (!metadata) return {};
    if (typeof metadata === "string") {
        try {
            const parsed = JSON.parse(metadata) as unknown;
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : {};
        } catch {
            return {};
        }
    }

    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
    const value = record?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanShipmentRecoveryMetadata(metadata: Record<string, unknown>): string | null {
    const next = { ...metadata };
    delete next.reconciliation;
    delete next.orderStatusSync;
    return Object.keys(next).length > 0 ? JSON.stringify(next) : null;
}

function safeFinalizedShipmentStatus(
    shipment: { rawStatus?: string | null },
    metadata: Record<string, unknown>,
): { status: string; hasExplicitProviderState: boolean } {
    const reconciliation = asRecord(metadata.reconciliation);
    const explicitStatus =
        stringField(reconciliation, "providerStatus") ??
        stringField(metadata, "order_status") ??
        stringField(metadata, "status");

    if (explicitStatus && explicitStatus !== ShipmentStatus.RECONCILE_REQUIRED) {
        return { status: explicitStatus, hasExplicitProviderState: true };
    }

    const rawStatus = shipment.rawStatus?.trim();
    if (
        rawStatus &&
        rawStatus !== ShipmentStatus.RECONCILE_REQUIRED &&
        !rawStatus.endsWith("_failed") &&
        !rawStatus.includes("reconcile") &&
        !rawStatus.includes("claim")
    ) {
        return { status: rawStatus, hasExplicitProviderState: true };
    }

    return { status: ShipmentStatus.PENDING, hasExplicitProviderState: false };
}

function createShipmentClaimId(): string {
    return `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function clearShipmentClaim(db: Database, orderId: string, claimId: string): Promise<void> {
    await db
        .update(orders)
        .set({
            shipmentClaimId: null,
            shipmentClaimExpiresAt: null,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orders.id, orderId),
            eq(orders.shipmentClaimId, claimId),
        ));
}

async function getRecordedCodCollection(
    db: Database,
    orderId: string,
    currency: OrderCurrencySnapshot,
): Promise<{ amount: number; collectedBy: string } | null> {
    const payment = await db
        .select({
            id: orderPayments.id,
            amount: orderPayments.amount,
            currency: orderPayments.currency,
            collectedBy: orderPayments.codCollectedBy,
        })
        .from(orderPayments)
        .where(and(
            eq(orderPayments.orderId, orderId),
            eq(orderPayments.paymentMethod, PaymentMethod.COD),
            eq(orderPayments.status, PaymentRecordStatus.SUCCEEDED),
        ))
        .get();

    if (!payment) return null;
    assertOrderPaymentCurrency(payment.currency, currency, "Recorded COD payment");

    const tracking = await db
        .select({
            id: codTracking.id,
            collectedBy: codTracking.collectedBy,
        })
        .from(codTracking)
        .where(and(
            eq(codTracking.orderId, orderId),
            eq(codTracking.codStatus, CodStatus.COLLECTED),
        ))
        .get();

    if (!tracking) return null;
    const collectedBy = payment.collectedBy?.trim();
    if (!collectedBy || tracking.collectedBy?.trim() !== collectedBy) return null;
    const amount = Number(payment.amount);
    return Number.isFinite(amount)
        ? { amount: roundOrderMoney(amount, currency), collectedBy }
        : null;
}

async function hasRecordedCodCollection(
    db: Database,
    orderId: string,
    currency: OrderCurrencySnapshot,
): Promise<boolean> {
    return Boolean(await getRecordedCodCollection(db, orderId, currency));
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

    await markShipmentReconciliationRequired(
        db,
        claimId,
        "expired_order_shipment_claim",
        {
            externalId: shipment.externalId ?? undefined,
            trackingId: shipment.trackingId ?? undefined,
            status: shipment.status,
        },
    );
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

export async function reconcileOrderShipment(
    db: Database,
    orderId: string,
    shipmentId: string,
): Promise<OrderShipmentReconciliationResult> {
    const shipment = await db
        .select({
            id: deliveryShipments.id,
            orderId: deliveryShipments.orderId,
            status: deliveryShipments.status,
            rawStatus: deliveryShipments.rawStatus,
            externalId: deliveryShipments.externalId,
            trackingId: deliveryShipments.trackingId,
            metadata: deliveryShipments.metadata,
        })
        .from(deliveryShipments)
        .where(eq(deliveryShipments.id, shipmentId))
        .get();

    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) {
        throw new ValidationError("Shipment does not belong to this order");
    }
    if (shipment.status !== ShipmentStatus.RECONCILE_REQUIRED) {
        throw new ValidationError("Shipment does not require reconciliation");
    }

    const metadata = parseShipmentMetadata(shipment.metadata);
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            version: orders.version,
            fulfillmentStatus: orders.fulfillmentStatus,
            shipmentClaimId: orders.shipmentClaimId,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();

    if (!order) throw new NotFoundError("Order not found");
    if (order.shipmentClaimId && order.shipmentClaimId !== shipmentId) {
        throw new ConflictError("Another shipment recovery claim is active for this order.");
    }

    await assertNoActiveRefundAttempt(db, orderId, {
        message: "Order has an active refund operation. Complete or reconcile the refund before repairing shipment recovery.",
    });
    await assertNoActivePaymentSessionAttempt(db, orderId);

    const orderStatusSync = asRecord(metadata.orderStatusSync);
    const shipmentStatusForSync = stringField(orderStatusSync, "shipmentStatus");
    if (shipmentStatusForSync) {
        const targetOrderStatus = stringField(orderStatusSync, "orderStatus") ?? order.status;
        let orderStatusChanged = false;
        if (targetOrderStatus !== order.status) {
            validateTransition("order", order.status, targetOrderStatus);
            const statusResult = await db
                .update(orders)
                .set({
                    status: targetOrderStatus,
                    fulfillmentStatus: targetOrderStatus === OrderStatus.SHIPPED || targetOrderStatus === OrderStatus.DELIVERED
                        ? FulfillmentStatus.COMPLETE
                        : order.fulfillmentStatus,
                    version: order.version + 1,
                    updatedAt: sql`unixepoch()`,
                })
                .where(and(
                    eq(orders.id, orderId),
                    eq(orders.version, order.version),
                    order.shipmentClaimId
                        ? eq(orders.shipmentClaimId, shipmentId)
                        : sql`${orders.shipmentClaimId} IS NULL`,
                    noActiveRefundAttemptForOrderIdCondition(orderId),
                    noActivePaymentSessionAttemptForOrderIdCondition(orderId),
                ))
                .returning({ id: orders.id });

            if (statusResult.length === 0) {
                throw new ConflictError("Order changed while shipment recovery was being repaired.");
            }
            orderStatusChanged = true;
        }

        const availabilityTransitionVariantIds = await reconcileInventoryForStatus(
            db,
            orderId,
            targetOrderStatus,
        );

        await db
            .update(deliveryShipments)
            .set({
                status: shipmentStatusForSync,
                rawStatus: shipmentStatusForSync,
                metadata: cleanShipmentRecoveryMetadata(metadata),
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(deliveryShipments.id, shipmentId),
                eq(deliveryShipments.status, ShipmentStatus.RECONCILE_REQUIRED),
            ));

        if (order.shipmentClaimId === shipmentId) {
            await clearShipmentClaim(db, orderId, shipmentId);
        }

        return {
            status: "repaired",
            orderId,
            shipmentId,
            orderStatus: targetOrderStatus,
            shipmentStatus: shipmentStatusForSync,
            orderStatusChanged,
            inventoryReconciled: true,
            claimCleared: order.shipmentClaimId === shipmentId,
            trackingId: shipment.trackingId,
            message: "Shipment inventory reconciliation repaired.",
            availabilityTransitionVariantIds,
        };
    }
    if (order.shipmentClaimId !== shipmentId) {
        throw new ConflictError("Shipment is no longer the active order shipment recovery claim.");
    }

    const finalizedShipmentStatus = safeFinalizedShipmentStatus(shipment, metadata);
    if (!shipment.externalId && !shipment.trackingId && !finalizedShipmentStatus.hasExplicitProviderState) {
        throw new ConflictError("Shipment recovery has no provider proof to finalize safely.");
    }

    const finalOrderStatus =
        order.status === OrderStatus.SHIPPED || order.status === OrderStatus.DELIVERED
            ? order.status
            : OrderStatus.SHIPPED;
    let orderStatusChanged = false;

    if (order.status !== finalOrderStatus) {
        validateTransition("order", order.status, finalOrderStatus);
        const statusResult = await db
            .update(orders)
            .set({
                status: finalOrderStatus,
                fulfillmentStatus: FulfillmentStatus.COMPLETE,
                version: order.version + 1,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(
                eq(orders.id, orderId),
                eq(orders.version, order.version),
                eq(orders.shipmentClaimId, shipmentId),
                noActiveRefundAttemptForOrderIdCondition(orderId),
                noActivePaymentSessionAttemptForOrderIdCondition(orderId),
            ))
            .returning({ id: orders.id });

        if (statusResult.length === 0) {
            throw new ConflictError("Order changed while shipment recovery was being repaired.");
        }
        orderStatusChanged = true;
    } else if (order.fulfillmentStatus !== FulfillmentStatus.COMPLETE) {
        await db
            .update(orders)
            .set({
                fulfillmentStatus: FulfillmentStatus.COMPLETE,
                updatedAt: sql`unixepoch()`,
            })
            .where(and(eq(orders.id, orderId), eq(orders.shipmentClaimId, shipmentId)));
    }

    const availabilityTransitionVariantIds = await reconcileInventoryForStatus(
        db,
        orderId,
        finalOrderStatus,
    );

    await db
        .update(deliveryShipments)
        .set({
            status: finalizedShipmentStatus.status,
            rawStatus: finalizedShipmentStatus.status,
            metadata: cleanShipmentRecoveryMetadata(metadata),
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(deliveryShipments.id, shipmentId),
            eq(deliveryShipments.status, ShipmentStatus.RECONCILE_REQUIRED),
        ));

    await clearShipmentClaim(db, orderId, shipmentId);

    return {
        status: "repaired",
        orderId,
        shipmentId,
        orderStatus: finalOrderStatus,
        shipmentStatus: finalizedShipmentStatus.status,
        orderStatusChanged,
        inventoryReconciled: true,
        claimCleared: true,
        trackingId: shipment.trackingId,
        message: "Shipment recovery repaired and order finalization completed.",
        availabilityTransitionVariantIds,
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

export async function processCodAction(db: Database, orderId: string, body: Record<string, unknown>) {
    const order = await db.select({
        status: orders.status,
        version: orders.version,
        totalAmount: orders.totalAmount,
        paidAmount: orders.paidAmount,
        balanceDue: orders.balanceDue,
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
            const existingCodCollection = await getRecordedCodCollection(db, orderId, currency);
            const collection = existingCodCollection
                ? null
                : validateCODCollectionDetails(order, {
                    collectedBy: body.collectedBy as string,
                    collectedAmount: body.collectedAmount as number,
                });

            if (existingCodCollection) {
                const requestedAmount = typeof body.collectedAmount === "number"
                    ? roundOrderMoney(body.collectedAmount, currency)
                    : Number.NaN;
                if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
                    throw new ValidationError("COD collected amount must be a positive finite number.");
                }
                if (!orderMoneyEqual(existingCodCollection.amount, requestedAmount, currency)) {
                    throw new ValidationError("COD collection was already recorded with a different amount.", {
                        recordedAmount: existingCodCollection.amount,
                        collectedAmount: requestedAmount,
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

            // Validate transition to DELIVERED. If current status is CONFIRMED,
            // transition through SHIPPED first (COD collection implies delivery).
            let currentVersion = order.version;
            let currentStatus = order.status;
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
            if (order.status === OrderStatus.CONFIRMED) {
                validateTransition("order", order.status, OrderStatus.SHIPPED);
                const shipResult = await db.update(orders).set({ status: OrderStatus.SHIPPED, version: currentVersion + 1, updatedAt: sql`unixepoch()` }).where(and(
                    eq(orders.id, orderId),
                    eq(orders.version, currentVersion),
                    noActiveRefundAttemptForOrderIdCondition(orderId),
                    noActivePaymentSessionAttemptForOrderIdCondition(orderId),
                )).returning({ id: orders.id });
                if (shipResult.length === 0) throw new ConflictError("Order was modified by another request. Please reload and try again.");
                currentVersion += 1;
                currentStatus = OrderStatus.SHIPPED;
                statusClaim = {
                    claimedStatus: OrderStatus.SHIPPED,
                    claimedVersion: currentVersion,
                };
            }
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
                    throw new ConflictError("Order was modified by another request. Please reload and try again.");
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
                    collectedAmount: collection?.collectedAmount ?? existingCodCollection!.amount,
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
            assertOrderCodActionAllowed(order.status, "failed");
            const failResult = await recordCODFailure(db, { orderId, reason: body.reason as "other" | "not_home" | "refused" | "no_cash" | "wrong_address", notes: body.notes as string | undefined });
            if (!failResult.success) throw new ValidationError(failResult.error || "COD failure recording failed");
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
                const fulfilledItems = await db.select({
                    id: orderItems.id,
                    quantity: orderItems.quantity,
                }).from(orderItems).where(and(
                    eq(orderItems.orderId, orderId),
                    sql`${orderItems.fulfillmentStatus} IN (${ItemFulfillmentStatus.SHIPPED}, ${ItemFulfillmentStatus.DELIVERED})`,
                )).all();
                if (fulfilledItems.length === 0) {
                    throw new ValidationError(
                        "Courier return evidence cannot be linked because no shipped order items were found.",
                    );
                }
                const createdReturn = await createOrderReturn(db, orderId, {
                    commandKey: `cod-rts-create:${orderId}`,
                    expectedOrderVersion: order.version,
                    reason: "Courier return to sender",
                    notes: typeof body.notes === "string" ? body.notes : null,
                    lines: fulfilledItems.map((item) => ({
                        orderItemId: item.id,
                        quantity: item.quantity,
                        reason: typeof body.reason === "string" ? body.reason : "return_to_sender",
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
                    notes: "Awaiting explicit warehouse receipt and disposition.",
                    lines: returnRecord.lines.map((line) => ({
                        lineId: line.id,
                        approvedQuantity: line.requestedQuantity,
                        rejectedQuantity: 0,
                    })),
                }, { type: "system", id: "cod" });
            }
            const retResult = await markCODReturned(db, orderId);
            if (!retResult.success) throw new ValidationError(retResult.error || "COD return failed");
            return {
                message: "Courier return-to-sender recorded; stock awaits warehouse receipt.",
                returnId: returnRecord.id,
                availabilityTransitionVariantIds: [],
            };
        }
        default:
            throw new ValidationError("Invalid action");
    }
}

export async function getOrderShipments(db: Database, orderId: string) {
    return db.select().from(deliveryShipments).where(eq(deliveryShipments.orderId, orderId)).all();
}

export async function createFulfillmentShipment(db: Database, orderId: string, body: Record<string, unknown>) {
    const order = await db.select({
        id: orders.id,
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        version: orders.version,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);
    await assertNoActiveRefundAttempt(db, orderId);
    await assertNoActivePaymentSessionAttempt(db, orderId);
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED) {
        throw new ValidationError("Cannot fulfill a cancelled/returned order");
    }

    const allItems = await db.select({ id: orderItems.id, fulfillmentStatus: orderItems.fulfillmentStatus }).from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    const shipmentItemIds = (body.itemIds as string[] | undefined) ?? allItems.map((i) => i.id);
    const ownItemIds = new Set(allItems.map((item) => item.id));
    const uniqueShipmentItemIds = new Set(shipmentItemIds as string[]);
    const missingItemIds = (shipmentItemIds as string[]).filter((itemId) => !ownItemIds.has(itemId));

    if (shipmentItemIds.length === 0) {
        throw new ValidationError("At least one order item is required to create a fulfillment shipment");
    }
    if (uniqueShipmentItemIds.size !== shipmentItemIds.length) {
        throw new ValidationError("Fulfillment shipment item IDs must be unique");
    }
    if (missingItemIds.length > 0) {
        throw new ValidationError(`Fulfillment items do not belong to this order: ${missingItemIds.join(", ")}`);
    }

    const alreadyFulfilled = allItems.filter((i) => (shipmentItemIds as string[]).includes(i.id) && (i.fulfillmentStatus === ItemFulfillmentStatus.SHIPPED || i.fulfillmentStatus === ItemFulfillmentStatus.DELIVERED));
    if (alreadyFulfilled.length > 0) throw new ConflictError(`Items already shipped: ${alreadyFulfilled.map((i) => i.id).join(", ")}`);

    const shipmentId = `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date();
    const unfulfilledItemIds = allItems.filter((i) => i.fulfillmentStatus === ItemFulfillmentStatus.PENDING || i.fulfillmentStatus === ItemFulfillmentStatus.PICKED || i.fulfillmentStatus === ItemFulfillmentStatus.PACKED).map((i) => i.id);
    const isFinalShipment = (body.isFinalShipment as boolean | undefined) ?? ((shipmentItemIds as string[]).every((sid: string) => unfulfilledItemIds.includes(sid)) && unfulfilledItemIds.every((uid) => (shipmentItemIds as string[]).includes(uid)));

    const newFulfillmentStatus = isFinalShipment ? FulfillmentStatus.COMPLETE : FulfillmentStatus.PARTIAL;
    const orderUpdate: Record<string, unknown> = {
        fulfillmentStatus: newFulfillmentStatus,
        version: order.version + 1,
        updatedAt: sql`unixepoch()`,
    };
    const shouldShipOrder = isFinalShipment && order.status === OrderStatus.CONFIRMED;
    if (shouldShipOrder) {
        validateTransition("order", order.status, OrderStatus.SHIPPED);
        orderUpdate.status = OrderStatus.SHIPPED;
    }

    const claimResult = await db.update(orders).set({
        shipmentClaimId: shipmentId,
        shipmentClaimExpiresAt: sql`unixepoch() + ${SHIPMENT_CLAIM_LEASE_SECONDS}`,
        version: order.version + 1,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, order.version),
        eq(orders.status, order.status),
        eq(orders.fulfillmentStatus, order.fulfillmentStatus),
        noActiveShipmentClaimCondition(),
        noActiveRefundAttemptForOrderIdCondition(orderId),
        noActivePaymentSessionAttemptForOrderIdCondition(orderId),
    )).returning({ id: orders.id });

    if (claimResult.length === 0) {
        throw new ConflictError("Order was modified by another request. Please reload and try again.");
    }

    // Drizzle D1 batch() requires specific tuple types
    const writes: unknown[] = [];

    writes.push(db.insert(deliveryShipments).values({
        id: shipmentId, orderId, trackingId: (body.trackingId as string | undefined) ?? null, trackingUrl: (body.trackingUrl as string | undefined) ?? null,
        courierName: (body.courierName as string | undefined) ?? null,
        status: ShipmentStatus.IN_TRANSIT,
        rawStatus: ShipmentStatus.IN_TRANSIT,
        note: (body.note as string | undefined) ?? null,
        shipmentItems: JSON.stringify(shipmentItemIds), shipmentAmount: (body.shipmentAmount as number | undefined) ?? null, isFinalShipment,
        createdAt: now, updatedAt: now,
    }));

    for (const itemId of shipmentItemIds as string[]) {
        writes.push(db.update(orderItems).set({ fulfillmentStatus: ItemFulfillmentStatus.SHIPPED }).where(and(
            eq(orderItems.id, itemId),
            eq(orderItems.orderId, orderId),
        )));
    }

    writes.push(db.update(orders).set({
        ...orderUpdate,
        shipmentClaimId: null,
        shipmentClaimExpiresAt: null,
        version: order.version + 2,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, order.version + 1),
        eq(orders.shipmentClaimId, shipmentId),
    )));

    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        await db.batch(writes as any);
    } catch (error) {
        const committedShipment = await db
            .select({ id: deliveryShipments.id })
            .from(deliveryShipments)
            .where(eq(deliveryShipments.id, shipmentId))
            .get();

        if (!committedShipment) {
            await clearShipmentClaim(db, orderId, shipmentId);
        }

        throw error;
    }

    const shouldReconcileShipmentInventory =
        isFinalShipment &&
        (shouldShipOrder || order.status === OrderStatus.SHIPPED || order.status === OrderStatus.DELIVERED);

    const availabilityTransitionVariantIds = shouldReconcileShipmentInventory
        ? await reconcileInventoryForStatus(
            db,
            orderId,
            order.status === OrderStatus.DELIVERED ? OrderStatus.DELIVERED : OrderStatus.SHIPPED,
        )
        : [];

    return {
        shipmentId,
        isFinalShipment,
        fulfillmentStatus: newFulfillmentStatus,
        availabilityTransitionVariantIds,
        ...(shouldShipOrder
            ? {
                statusChange: {
                    orderId,
                    previousStatus: order.status,
                    newStatus: OrderStatus.SHIPPED,
                    version: order.version + 2,
                },
            }
            : {}),
    };
}

// Statuses that warrant a customer notification email
const NOTIFICATION_STATUSES: Record<string, OrderNotificationType> = {
    pending: "order_created",
    confirmed: "order_confirmed",
    processing: "order_processing",
    shipped: "order_shipped",
    delivered: "order_delivered",
    completed: "order_completed",
    cancelled: "order_cancelled",
    returned: "order_returned",
    refunded: "order_refunded",
    partially_refunded: "order_partially_refunded",
};

export async function updateOrderStatus(db: Database, orderId: string, status: string, data?: { trackingId?: string }): Promise<StatusUpdateResult> {
    const nextStatus = normalizeOrderStatus(status);
    if (!nextStatus) {
        throw new ValidationError("Unknown order status.");
    }

    const existingOrder = await db.select({
        status: orders.status,
        inventoryAction: orders.inventoryAction,
        version: orders.version,
        customerName: orders.customerName,
        customerEmail: orders.customerEmail,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        totalAmount: orders.totalAmount,
        paidAmount: orders.paidAmount,
        balanceDue: orders.balanceDue,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!existingOrder) throw new NotFoundError("Order not found");
    const currentStatus = normalizeOrderStatus(existingOrder.status);
    if (!currentStatus) {
        throw new ValidationError("Order has an unknown current status.");
    }
    assertNoActiveShipmentClaim(existingOrder);
    await assertNoActiveRefundAttempt(db, orderId);
    await assertNoActivePaymentSessionAttempt(db, orderId);
    const isDeliveredOrCompleted = nextStatus === OrderStatus.DELIVERED || nextStatus === OrderStatus.COMPLETED;
    if (isDeliveredOrCompleted) {
        const currency = resolveOrderCurrencySnapshot(existingOrder);
        const paidAmount = roundOrderMoney(existingOrder.paidAmount ?? 0, currency);
        const totalAmount = roundOrderMoney(existingOrder.totalAmount, currency);
        const storedBalanceDue = roundOrderMoney(existingOrder.balanceDue ?? 0, currency);
        const computedBalanceDue = roundOrderMoney(Math.max(0, totalAmount - paidAmount), currency);
        const hasMoneyDue = storedBalanceDue > 0 || computedBalanceDue > 0;
        if (hasMoneyDue || existingOrder.paymentStatus !== PaymentStatus.PAID) {
            throw new ValidationError(
                existingOrder.paymentMethod === PaymentMethod.COD
                    ? "Record COD collection through the COD action before marking the order delivered or completed."
                    : existingOrder.paymentStatus === PaymentStatus.PARTIAL
                    ? "Record the remaining cash balance through the collection action before marking the order delivered or completed."
                    : "Settle the outstanding payment before marking the order delivered or completed.",
            );
        }

        if (existingOrder.paymentMethod === PaymentMethod.COD) {
            const hasCodCollection = await hasRecordedCodCollection(db, orderId, currency);
            if (!hasCodCollection || paidAmount <= 0) {
                throw new ValidationError("Record COD collection through the COD action before marking the order delivered or completed.");
            }
        }
    }
    if (currentStatus === nextStatus) {
        const availabilityTransitionVariantIds = await reconcileInventoryForStatus(
            db,
            orderId,
            nextStatus,
        );
        if (nextStatus === OrderStatus.DELIVERED || nextStatus === OrderStatus.COMPLETED) {
            await markManualDeliveryEvidence(db, orderId);
        }
        return {
            message: "Status unchanged; inventory reconciled",
            availabilityTransitionVariantIds,
        };
    }

    assertGenericAdminOrderStatusTransition(currentStatus, nextStatus);

    // Validate the status transition before applying any side effects
    validateTransition("order", currentStatus, nextStatus);

    // Optimistic locking: CAS update FIRST — only proceed with side effects
    // if we win the version check. This prevents the race condition where two
    // concurrent callers (e.g. admin + webhook) both apply inventory before
    // either detects the conflict.
    const result = await db.update(orders).set({
        status: nextStatus,
        version: existingOrder.version + 1,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, existingOrder.version),
        noActiveRefundAttemptForOrderIdCondition(orderId),
        noActivePaymentSessionAttemptForOrderIdCondition(orderId),
    )).returning({ id: orders.id });

    if (result.length === 0) {
        throw new ConflictError("Order was modified by another request. Please reload and try again.");
    }

    // CAS succeeded. If inventory reconciliation fails before the order's
    // inventoryAction changes, roll back the buyer-visible status so operators
    // do not see a completed transition with stale stock counters.
    let availabilityTransitionVariantIds: string[];
    try {
        availabilityTransitionVariantIds = await reconcileInventoryForStatus(
            db,
            orderId,
            nextStatus,
        );
    } catch (error: unknown) {
        await rollbackOrderStatusIfInventoryUnchanged(db, {
            orderId,
            previousStatus: currentStatus,
            claimedStatus: nextStatus,
            claimedVersion: existingOrder.version + 1,
            previousInventoryAction: existingOrder.inventoryAction as string,
        });
        throw error;
    }
    if (nextStatus === OrderStatus.DELIVERED || nextStatus === OrderStatus.COMPLETED) {
        await markManualDeliveryEvidence(db, orderId);
    }

    // Build notification payload if the new status warrants one
    const notificationType = NOTIFICATION_STATUSES[nextStatus];
    const notification = notificationType
        ? {
            orderId,
            customerEmail: existingOrder.customerEmail ?? undefined,
            customerName: existingOrder.customerName,
            notificationType,
            dedupeKey: buildOrderStatusNotificationDedupeKey({
                orderId,
                notificationType,
                previousStatus: currentStatus,
                newStatus: nextStatus,
                version: existingOrder.version + 1,
            }),
            previousStatus: currentStatus,
            newStatus: nextStatus,
            version: existingOrder.version + 1,
            ...(nextStatus === OrderStatus.SHIPPED && data?.trackingId
                ? { trackingId: data.trackingId }
                : {}),
        }
        : undefined;

    return {
        message: "Order status updated successfully",
        notification,
        availabilityTransitionVariantIds,
    };
}
