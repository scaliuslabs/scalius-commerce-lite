// Courier booking reconciliation, including bookings whose provider outcome is unknown.
import type { Database } from "@scalius/database/client";
import {
    orders,
    deliveryShipments,
    OrderStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import {
  type CourierProvidersSource,
  lookupShipmentByMerchantOrderId,
  PROVIDER_OUTCOME_UNKNOWN,
} from "../delivery";
import {
  assertNoActivePaymentSessionAttempt,
  assertNoActiveRefundAttempt,
  expiredShipmentClaimCondition,
  isShipmentClaimHeld,
  isShipmentClaimLeaseLive,
  noActivePaymentSessionAttemptForOrderIdCondition,
  noActiveRefundAttemptForOrderIdCondition,
  validateTransition,
} from "../order-kernel";
import { sql, eq, and } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import {
  type OrderShipmentReconciliationResult,
  reconcileInventoryForStatus,
  type UnknownShipmentResolutionInput,
  type UnknownShipmentResolutionResult,
} from "../orders";
import { parseShipmentMetadata, clearShipmentClaim } from "./shared";
import { recordCourierBookingFulfilment } from "./ledger";
import { resolveExpiredShipmentClaim } from "./bulk";

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
        /** The request's couriers (the active courier apps'); absent: none. */
        couriers?: CourierProvidersSource;
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
        input.couriers,
    );
    if (!lookup.confirmed) throw new ConflictError(lookup.message);
    if (lookup.status === ShipmentStatus.UNKNOWN) {
        throw new ConflictError(
            `${lookup.courier} did not return a recognized shipment state. The recovery lock remains active.`,
        );
    }
    if (lookup.status === ShipmentStatus.CANCELLED) {
        throw new ConflictError(
            `${lookup.courier} confirms this order's booking was cancelled. Record a courier-confirmed cancellation to release the shipment lock.`,
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
        lookup.externalId ?? undefined,
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
        /** The request's couriers (the active courier apps'); absent: none. */
        couriers?: CourierProvidersSource;
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

    // Releasing the lock ("not created" or "cancelled") rests on the staff's
    // own search of the courier: a lookup only ever vetoes (it is
    // positive-only, and Pathao has none). A wrong release lets a re-booking
    // send a second cash-on-delivery parcel.
    if (input.outcome === "confirmed_not_created" || input.outcome === "confirmed_cancelled") {
        const lookup = await lookupShipmentByMerchantOrderId(
            db,
            target.shipment.providerId!,
            input.orderId,
            input.encryptionKey,
            input.couriers,
        );
        if (lookup.confirmed && (input.outcome === "confirmed_not_created" || lookup.status !== ShipmentStatus.CANCELLED)) {
            throw new ConflictError(input.outcome === "confirmed_not_created"
                ? `${lookup.courier} confirms a shipment for this order. Record the confirmed shipment or a courier-confirmed cancellation; it cannot be marked not created.`
                : `${lookup.courier} shows this order's booking as active. Record the confirmed shipment instead.`);
        }
        // A lookup that could not run proves nothing: the lock stays, unless
        // courier support answered (the one way out of a lookup that never comes back).
        if (!lookup.confirmed && lookup.reason === "unavailable" && input.evidenceSource !== "courier_support") {
            throw new ConflictError(`${lookup.message} If the lookup stays unavailable, record what courier support confirmed, with their reference.`);
        }
        // The note names the order ID the staff searched the courier for.
        if (!input.evidenceNote.toLowerCase().includes(input.orderId.toLowerCase())) {
            throw new ValidationError(
                `Search the courier for order ID ${input.orderId} and note what it showed, including the order ID.`,
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
    // Repair settles an expired booking claim first (as the maintenance sweep
    // would): released when its attempt booked nothing, otherwise it becomes
    // the reconciliation or the courier confirmation handled below. A held
    // claim whose attempt moved on (a courier status written before the claim
    // was settled) becomes that reconciliation again, with the status it shows.
    const claim = await db
        .select({
            status: orders.status,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();
    if (claim?.shipmentClaimId === shipmentId && (!isShipmentClaimLeaseLive(claim) || isShipmentClaimHeld(claim))) {
        const attempt = await db
            .select({ orderId: deliveryShipments.orderId, status: deliveryShipments.status })
            .from(deliveryShipments)
            .where(eq(deliveryShipments.id, shipmentId))
            .get();
        if (attempt && attempt.orderId !== orderId) {
            throw new ValidationError("Shipment does not belong to this order");
        }
        if (attempt?.status !== ShipmentStatus.RECONCILE_REQUIRED) {
            const outcome = await resolveExpiredShipmentClaim(db, orderId, shipmentId);
            if (!outcome.blocked) {
                return {
                    status: "repaired",
                    orderId,
                    shipmentId,
                    orderStatus: claim.status,
                    shipmentStatus: attempt?.status ?? ShipmentStatus.FAILED,
                    orderStatusChanged: false,
                    inventoryReconciled: false,
                    claimCleared: true,
                    trackingId: null,
                    message: "The expired shipment attempt booked nothing. The shipment lock is released.",
                    availabilityTransitionVariantIds: [],
                };
            }
        }
    }

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
            await recordCourierBookingFulfilment(db, orderId, shipmentId);
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
    }

    await recordCourierBookingFulfilment(db, orderId, shipmentId);
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

export const EXPIRED_SHIPMENT_CLAIM_SWEEP_LIMIT = 25;

export interface ExpiredShipmentClaimSweepResult {
    scanned: number;
    /** Attempts that booked nothing: the order is free again. */
    released: number;
    /** Booked attempts finished as Repair would (the order is shipped, the claim cleared). */
    finalized: Array<{ orderId: string; shipmentId: string; orderStatus: string; orderStatusChanged: boolean; trackingId: string | null }>;
    /** Held for staff: an unknown courier outcome, or a booking that could not be finished. */
    held: number;
    failed: number;
    /** The cursor: the last order looked at, or null once the range wrapped. */
    lastOrderId: string | null;
}

/**
 * The maintenance backstop for dead courier bookings, over every order whose
 * shipment claim lease ran out (the partial claim index holds only claimed
 * orders), after `afterOrderId` so a claim that keeps failing never holds the
 * others back. An attempt that booked nothing is released; a booked attempt
 * (the courier's id is on its row) is finished the way Repair finishes it, so
 * the courier's later pushes apply; an unknown outcome is held for a courier
 * confirmation. Held claims lose their expiry, so they leave this range.
 */
export async function sweepExpiredShipmentClaims(
    db: Database,
    options: { limit?: number; afterOrderId?: string | null } = {},
): Promise<ExpiredShipmentClaimSweepResult> {
    const limit = Math.max(1, Math.min(EXPIRED_SHIPMENT_CLAIM_SWEEP_LIMIT * 4, Math.floor(options.limit ?? EXPIRED_SHIPMENT_CLAIM_SWEEP_LIMIT)));
    // The cursor and order use `id || ''` so the planner reads the partial
    // claim index (claimed orders only), never the primary key's whole range.
    const cursorKey = sql<string>`(${orders.id} || '')`;
    const rows = await db
        .select({ id: orders.id, shipmentClaimId: orders.shipmentClaimId })
        .from(orders)
        .where(and(expiredShipmentClaimCondition(), options.afterOrderId ? sql`${cursorKey} > ${options.afterOrderId}` : undefined))
        .orderBy(cursorKey)
        .limit(limit)
        .all();
    const result: ExpiredShipmentClaimSweepResult = {
        scanned: rows.length,
        released: 0,
        finalized: [],
        held: 0,
        failed: 0,
        // A short page means the range ended: the next run starts over.
        lastOrderId: rows.length === limit ? rows.at(-1)!.id : null,
    };
    for (const row of rows) {
        if (!row.shipmentClaimId) continue;
        try {
            const attempt = await db
                .select({ status: deliveryShipments.status, externalId: deliveryShipments.externalId, trackingId: deliveryShipments.trackingId })
                .from(deliveryShipments)
                .where(eq(deliveryShipments.id, row.shipmentClaimId))
                .get();
            const booked = Boolean(attempt && (attempt.externalId || attempt.trackingId)
                && attempt.status !== ShipmentStatus.FAILED && attempt.status !== ShipmentStatus.CANCELLED);
            if (!booked) {
                const outcome = await resolveExpiredShipmentClaim(db, row.id, row.shipmentClaimId);
                if (outcome.blocked) result.held += 1;
                else result.released += 1;
                continue;
            }
            try {
                const repaired = await reconcileOrderShipment(db, row.id, row.shipmentClaimId);
                result.finalized.push({
                    orderId: row.id,
                    shipmentId: row.shipmentClaimId,
                    orderStatus: repaired.orderStatus,
                    orderStatusChanged: repaired.orderStatusChanged,
                    trackingId: repaired.trackingId,
                });
            } catch (error) {
                // The claim is held for staff (Repair); the order stays locked.
                result.held += 1;
                console.error(`[fulfilment] Booked shipment ${row.shipmentClaimId} of order ${row.id} could not be finished:`, error);
            }
        } catch (error) {
            result.failed += 1;
            console.error(`[fulfilment] Expired shipment claim ${row.shipmentClaimId} of order ${row.id} could not be resolved:`, error);
        }
    }
    return result;
}

/**
 * Before a courier push for a booked shipment is applied: the push proves the
 * booking exists, so an order still claimed by it (a booking whose invocation
 * died before finishing) is finished first. `in_flight`: the booking may still
 * be finishing, the courier should send again; `unresolved`: the shipment
 * waits for staff, nothing may be written over it.
 */
export async function settleShipmentClaimForCourierPush(
    db: Database,
    shipmentId: string,
    nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ state: "ready" | "in_flight" | "unresolved"; finalized?: OrderShipmentReconciliationResult }> {
    const shipment = await db
        .select({ orderId: deliveryShipments.orderId, status: deliveryShipments.status })
        .from(deliveryShipments)
        .where(eq(deliveryShipments.id, shipmentId))
        .get();
    if (!shipment) return { state: "unresolved" };
    const order = await db
        .select({ shipmentClaimId: orders.shipmentClaimId, shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt })
        .from(orders)
        .where(eq(orders.id, shipment.orderId))
        .get();
    if (order?.shipmentClaimId !== shipmentId) {
        return { state: shipment.status === ShipmentStatus.RECONCILE_REQUIRED ? "unresolved" : "ready" };
    }
    if (isShipmentClaimLeaseLive(order, nowSeconds) && !isShipmentClaimHeld(order)) return { state: "in_flight" };
    try {
        return { state: "ready", finalized: await reconcileOrderShipment(db, shipment.orderId, shipmentId) };
    } catch (error) {
        console.error(`[fulfilment] Shipment ${shipmentId} could not be finished before its courier push:`, error);
        return { state: "unresolved" };
    }
}
