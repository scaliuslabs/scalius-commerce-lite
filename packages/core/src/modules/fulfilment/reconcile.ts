// Courier booking reconciliation, including bookings whose provider outcome is unknown.
import type { Database } from "@scalius/database/client";
import {
    orders,
    deliveryShipments,
    OrderStatus,
    FulfillmentStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import { lookupShipmentByMerchantOrderId } from "../delivery/delivery.service";
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
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { validateTransition } from "../orders/status/state-machine";
import type {
    OrderShipmentReconciliationResult,
    UnknownShipmentResolutionResult,
} from "../orders/types";
import type { UnknownShipmentResolutionInput } from "../orders/validation";
import { parseShipmentMetadata, markAllOrderItemsSent, clearShipmentClaim } from "./shared";
import { reconcileInventoryForStatus } from "../orders/status/lifecycle";

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

    if (explicitStatus && explicitStatus !== ShipmentStatus.RECONCILE_REQUIRED &&
        explicitStatus !== PROVIDER_OUTCOME_UNKNOWN && explicitStatus !== "creating") {
        return { status: explicitStatus, hasExplicitProviderState: true };
    }

    const rawStatus = shipment.rawStatus?.trim();
    if (
        rawStatus &&
        rawStatus !== ShipmentStatus.RECONCILE_REQUIRED &&
        rawStatus !== PROVIDER_OUTCOME_UNKNOWN &&
        rawStatus !== "creating" &&
        !rawStatus.endsWith("_failed") &&
        !rawStatus.includes("reconcile") &&
        !rawStatus.includes("claim")
    ) {
        return { status: rawStatus, hasExplicitProviderState: true };
    }

    return { status: ShipmentStatus.PENDING, hasExplicitProviderState: false };
}

type UnknownShipmentResolutionEvidence = {
    operationKey: string;
    method: "provider_lookup" | "merchant_attestation";
    outcome: "confirmed_existing" | "confirmed_not_created" | "confirmed_cancelled";
    evidenceSource: "provider_api_invoice_lookup" | "courier_portal" | "courier_support";
    evidenceNote?: string;
    actorId: string | null;
    confirmedAt: string;
};

function getUnknownShipmentResolutionEvidence(
    metadata: Record<string, unknown>,
): UnknownShipmentResolutionEvidence | null {
    const value = asRecord(metadata.unknownOutcomeResolution);
    const operationKey = stringField(value, "operationKey");
    const method = stringField(value, "method");
    const outcome = stringField(value, "outcome");
    const evidenceSource = stringField(value, "evidenceSource");
    const confirmedAt = stringField(value, "confirmedAt");
    if (!operationKey || !confirmedAt ||
        (method !== "provider_lookup" && method !== "merchant_attestation") ||
        !["confirmed_existing", "confirmed_not_created", "confirmed_cancelled"].includes(outcome ?? "") ||
        !["provider_api_invoice_lookup", "courier_portal", "courier_support"].includes(evidenceSource ?? "")) {
        return null;
    }
    return {
        operationKey,
        method,
        outcome: outcome as UnknownShipmentResolutionEvidence["outcome"],
        evidenceSource: evidenceSource as UnknownShipmentResolutionEvidence["evidenceSource"],
        evidenceNote: stringField(value, "evidenceNote") ?? undefined,
        actorId: stringField(value, "actorId"),
        confirmedAt,
    };
}

async function readUnknownShipmentResolutionTarget(
    db: Database,
    orderId: string,
    shipmentId: string,
) {
    const order = await db.select({
        id: orders.id,
        status: orders.status,
        version: orders.version,
        fulfillmentStatus: orders.fulfillmentStatus,
        shipmentClaimId: orders.shipmentClaimId,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");

    const shipment = await db.select({
        id: deliveryShipments.id,
        orderId: deliveryShipments.orderId,
        providerId: deliveryShipments.providerId,
        providerType: deliveryShipments.providerType,
        status: deliveryShipments.status,
        rawStatus: deliveryShipments.rawStatus,
        externalId: deliveryShipments.externalId,
        trackingId: deliveryShipments.trackingId,
        metadata: deliveryShipments.metadata,
    }).from(deliveryShipments).where(eq(deliveryShipments.id, shipmentId)).get();
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) throw new ValidationError("Shipment does not belong to this order");
    return { order, shipment, metadata: parseShipmentMetadata(shipment.metadata) };
}

function assertCurrentUnknownShipmentResolutionTarget(
    target: Awaited<ReturnType<typeof readUnknownShipmentResolutionTarget>>,
    expectedOrderVersion: number,
): void {
    if (target.order.version !== expectedOrderVersion) {
        throw new ConflictError("Order changed. Reload before resolving shipment recovery.");
    }
    if (target.order.shipmentClaimId !== target.shipment.id) {
        throw new ConflictError("Shipment is no longer the active order recovery claim.");
    }
    const reconciliationReason = stringField(asRecord(target.metadata.reconciliation), "reason");
    if (target.shipment.status !== ShipmentStatus.RECONCILE_REQUIRED ||
        (target.shipment.rawStatus !== PROVIDER_OUTCOME_UNKNOWN && reconciliationReason !== PROVIDER_OUTCOME_UNKNOWN)) {
        throw new ConflictError("Shipment no longer has an unknown courier outcome.");
    }
    if (!target.shipment.providerId || target.shipment.providerType === "manual") {
        throw new ConflictError("Unknown courier resolution requires the original saved delivery provider.");
    }
}

async function persistConfirmedExistingShipment(
    db: Database,
    target: Awaited<ReturnType<typeof readUnknownShipmentResolutionTarget>>,
    expectedOrderVersion: number,
    evidence: UnknownShipmentResolutionEvidence,
    providerStatus: string,
    rawProviderStatus: string,
    externalId?: string,
    trackingId?: string,
): Promise<void> {
    const nextMetadata = {
        ...target.metadata,
        reconciliation: {
            required: true,
            reason: "confirmed_existing_shipment",
            providerStatus,
            rawProviderStatus,
        },
        unknownOutcomeResolution: evidence,
    };
    const result = await db.update(deliveryShipments).set({
        ...(externalId ? { externalId } : {}),
        ...(trackingId ? { trackingId } : {}),
        rawStatus: "confirmed_existing_shipment",
        metadata: JSON.stringify(nextMetadata),
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(deliveryShipments.id, target.shipment.id),
        eq(deliveryShipments.status, ShipmentStatus.RECONCILE_REQUIRED),
        eq(deliveryShipments.rawStatus, PROVIDER_OUTCOME_UNKNOWN),
        sql`EXISTS (
            SELECT 1 FROM ${orders}
            WHERE ${orders.id} = ${target.order.id}
              AND ${orders.version} = ${expectedOrderVersion}
              AND ${orders.shipmentClaimId} = ${target.shipment.id}
        )`,
    )).returning({ id: deliveryShipments.id });
    if (result.length === 0) {
        throw new ConflictError("Order or shipment changed. Reload before resolving shipment recovery.");
    }
}

async function finishConfirmedExistingShipment(
    db: Database,
    orderId: string,
    shipmentId: string,
    resolution: "provider_confirmed_existing" | "merchant_confirmed_existing",
): Promise<Extract<UnknownShipmentResolutionResult, { status: "repaired" }>> {
    const target = await readUnknownShipmentResolutionTarget(db, orderId, shipmentId);
    if (target.order.shipmentClaimId !== shipmentId ||
        target.shipment.status !== ShipmentStatus.RECONCILE_REQUIRED) {
        return {
            status: "repaired",
            resolution,
            orderId,
            shipmentId,
            orderStatus: target.order.status,
            shipmentStatus: target.shipment.status,
            orderStatusChanged: false,
            inventoryReconciled: true,
            claimCleared: !target.order.shipmentClaimId,
            trackingId: target.shipment.trackingId,
            message: "Courier confirmation was already recorded and shipment recovery is complete.",
            availabilityTransitionVariantIds: [],
        };
    }
    const result = await reconcileOrderShipment(db, orderId, shipmentId);
    return { ...result, resolution };
}

export async function lookupUnknownOrderShipment(
    db: Database,
    input: {
        orderId: string;
        shipmentId: string;
        expectedOrderVersion: number;
        operationKey: string;
        actorId: string | null;
        encryptionKey?: string;
    },
): Promise<Extract<UnknownShipmentResolutionResult, { status: "repaired" }>> {
    let target = await readUnknownShipmentResolutionTarget(db, input.orderId, input.shipmentId);
    const replay = getUnknownShipmentResolutionEvidence(target.metadata);
    if (replay?.operationKey === input.operationKey && replay.outcome === "confirmed_existing") {
        return finishConfirmedExistingShipment(db, input.orderId, input.shipmentId, "provider_confirmed_existing");
    }
    if (replay) throw new ConflictError("This unknown shipment outcome was already resolved.");
    assertCurrentUnknownShipmentResolutionTarget(target, input.expectedOrderVersion);

    const lookup = await lookupShipmentByMerchantOrderId(
        db,
        target.shipment.providerId!,
        input.orderId,
        input.encryptionKey,
    );
    if (!lookup.confirmed) throw new ConflictError(lookup.message);
    if (lookup.status === ShipmentStatus.UNKNOWN) {
        throw new ConflictError(
            "Steadfast did not return a recognized shipment state. The recovery lock remains active.",
        );
    }
    if (lookup.status === ShipmentStatus.CANCELLED) {
        throw new ConflictError(
            "Steadfast confirms this order's booking was cancelled. Record a courier-confirmed cancellation to release the shipment lock.",
        );
    }

    target = await readUnknownShipmentResolutionTarget(db, input.orderId, input.shipmentId);
    assertCurrentUnknownShipmentResolutionTarget(target, input.expectedOrderVersion);
    await persistConfirmedExistingShipment(
        db,
        target,
        input.expectedOrderVersion,
        {
            operationKey: input.operationKey,
            method: "provider_lookup",
            outcome: "confirmed_existing",
            evidenceSource: "provider_api_invoice_lookup",
            actorId: input.actorId,
            confirmedAt: new Date().toISOString(),
        },
        lookup.status,
        lookup.rawStatus,
    );
    return finishConfirmedExistingShipment(db, input.orderId, input.shipmentId, "provider_confirmed_existing");
}

export async function resolveUnknownOrderShipment(
    db: Database,
    input: UnknownShipmentResolutionInput & {
        orderId: string;
        shipmentId: string;
        actorId: string | null;
        encryptionKey?: string;
    },
): Promise<UnknownShipmentResolutionResult> {
    const target = await readUnknownShipmentResolutionTarget(db, input.orderId, input.shipmentId);
    const replay = getUnknownShipmentResolutionEvidence(target.metadata);
    if (replay?.operationKey === input.operationKey) {
        if (replay.outcome === "confirmed_existing") {
            return finishConfirmedExistingShipment(db, input.orderId, input.shipmentId, "merchant_confirmed_existing");
        }
        if (!target.order.shipmentClaimId) {
            return {
                status: "released",
                resolution: replay.outcome === "confirmed_cancelled"
                    ? "merchant_confirmed_cancelled"
                    : "merchant_confirmed_not_created",
                orderId: input.orderId,
                shipmentId: input.shipmentId,
                claimCleared: true,
                orderVersion: target.order.version,
                message: "Courier confirmation was already recorded and the shipment lock is released.",
            };
        }
    }
    if (replay) throw new ConflictError("This unknown shipment outcome was already resolved.");
    assertCurrentUnknownShipmentResolutionTarget(target, input.expectedOrderVersion);

    if (input.outcome === "confirmed_not_created" && target.shipment.providerType === "steadfast") {
        const lookup = await lookupShipmentByMerchantOrderId(
            db,
            target.shipment.providerId!,
            input.orderId,
            input.encryptionKey,
        );
        if (lookup.confirmed) {
            throw new ConflictError(
                "Steadfast confirms a shipment for this order. Record the confirmed shipment or a courier-confirmed cancellation; it cannot be marked not created.",
            );
        }
    }

    const evidence: UnknownShipmentResolutionEvidence = {
        operationKey: input.operationKey,
        method: "merchant_attestation",
        outcome: input.outcome,
        evidenceSource: input.evidenceSource,
        evidenceNote: input.evidenceNote,
        actorId: input.actorId,
        confirmedAt: new Date().toISOString(),
    };

    if (input.outcome === "confirmed_existing") {
        await persistConfirmedExistingShipment(
            db,
            target,
            input.expectedOrderVersion,
            evidence,
            ShipmentStatus.PENDING,
            "merchant_confirmed_existing",
            input.externalId,
            input.trackingId,
        );
        return finishConfirmedExistingShipment(db, input.orderId, input.shipmentId, "merchant_confirmed_existing");
    }

    const finalStatus = input.outcome === "confirmed_cancelled"
        ? ShipmentStatus.CANCELLED
        : ShipmentStatus.FAILED;
    const nextMetadata = { ...target.metadata };
    delete nextMetadata.reconciliation;
    nextMetadata.unknownOutcomeResolution = evidence;
    const [shipmentResult, orderResult] = await db.batch([
        db.update(deliveryShipments).set({
            status: finalStatus,
            rawStatus: input.outcome,
            metadata: JSON.stringify(nextMetadata),
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(deliveryShipments.id, input.shipmentId),
            eq(deliveryShipments.status, ShipmentStatus.RECONCILE_REQUIRED),
            eq(deliveryShipments.rawStatus, PROVIDER_OUTCOME_UNKNOWN),
            sql`EXISTS (
                SELECT 1 FROM ${orders}
                WHERE ${orders.id} = ${input.orderId}
                  AND ${orders.version} = ${input.expectedOrderVersion}
                  AND ${orders.shipmentClaimId} = ${input.shipmentId}
            )`,
        )).returning({ id: deliveryShipments.id }),
        db.update(orders).set({
            shipmentClaimId: null,
            shipmentClaimExpiresAt: null,
            version: input.expectedOrderVersion + 1,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, input.orderId),
            eq(orders.version, input.expectedOrderVersion),
            eq(orders.shipmentClaimId, input.shipmentId),
            sql`EXISTS (
                SELECT 1 FROM ${deliveryShipments}
                WHERE ${deliveryShipments.id} = ${input.shipmentId}
                  AND ${deliveryShipments.status} = ${finalStatus}
                  AND json_extract(${deliveryShipments.metadata}, '$.unknownOutcomeResolution.operationKey') = ${input.operationKey}
            )`,
        )).returning({ version: orders.version }),
    ] as any) as [{ id: string }[], { version: number }[]];
    if (!shipmentResult[0] || !orderResult[0]) {
        throw new ConflictError("Order or shipment changed. Reload before resolving shipment recovery.");
    }
    return {
        status: "released",
        resolution: input.outcome === "confirmed_cancelled"
            ? "merchant_confirmed_cancelled"
            : "merchant_confirmed_not_created",
        orderId: input.orderId,
        shipmentId: input.shipmentId,
        claimCleared: true,
        orderVersion: orderResult[0].version,
        message: input.outcome === "confirmed_cancelled"
            ? "Courier cancellation recorded. The shipment lock is released."
            : "Courier confirmation recorded. The shipment lock is released for a new booking.",
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
    if (shipment.rawStatus === PROVIDER_OUTCOME_UNKNOWN ||
        stringField(asRecord(metadata.reconciliation), "reason") === PROVIDER_OUTCOME_UNKNOWN) {
        throw new ConflictError("Shipment outcome is unknown. Obtain provider confirmation before this shipment can be reconciled.");
    }
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

        if (targetOrderStatus === OrderStatus.SHIPPED || targetOrderStatus === OrderStatus.DELIVERED) {
            await markAllOrderItemsSent(db, orderId);
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
