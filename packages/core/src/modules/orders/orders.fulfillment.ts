// src/modules/orders/orders.fulfillment.ts
// Fulfillment and status update functions for orders.

import type { Database } from "@scalius/database/client";
import { hasOrderEvent, recordOrderEvent } from "./order-timeline";
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
import {
    createShipment,
    getDeliveryProviderActionReadiness,
    lookupShipmentByMerchantOrderId,
    markShipmentReconciliationRequired,
    presentShipment,
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

import { sql, eq, and, inArray, notInArray, getTableColumns, type SQL } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import {
    canProcessOrderCodAction,
    normalizeOrderStatus,
    type OrderCodAction,
} from "@scalius/shared/order-state";
import {
    assertOrderPaymentCurrency,
    resolveOrderCurrencySnapshot,
    type OrderCurrencySnapshot,
} from "../payments/order-currency";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { validateTransition } from "./order-state-machine";
import type {
    OrderShipmentReconciliationResult,
    StatusUpdateResult,
    UnknownShipmentResolutionResult,
} from "./orders.types";
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
    type UnknownShipmentResolutionInput,
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

const CANCELLATION_UNSAFE_PAYMENT_RECORD_STATUSES = [
    PaymentRecordStatus.PENDING,
    PaymentRecordStatus.CONFIRMED,
    PaymentRecordStatus.SUCCEEDED,
] as const;

const CANCELLATION_REQUIRES_REFUND_MESSAGE =
    "This order has been paid. Refund the payment first, then cancel.";
const CANCELLATION_REQUIRES_PAYMENT_RECONCILIATION_MESSAGE =
    "A payment for this order is still being processed. Check the payment before cancelling.";

function noUnsafeCancellationPaymentCondition(orderId: string): SQL {
    return sql`
        ${orders.paymentStatus} IN (${PaymentStatus.UNPAID}, ${PaymentStatus.FAILED})
        AND ${orders.paidAmountMinor} = 0
        AND NOT EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderId}
              AND ${orderPayments.status} IN (
                  ${PaymentRecordStatus.PENDING},
                  ${PaymentRecordStatus.CONFIRMED},
                  ${PaymentRecordStatus.SUCCEEDED}
              )
        )
    `;
}

async function assertGenericCancellationPaymentSafe(
    db: Database,
    orderId: string,
    payment: { paymentStatus: string; paidAmountMinor: number },
): Promise<void> {
    const hasSafeOrderPaymentStatus =
        payment.paymentStatus === PaymentStatus.UNPAID
        || payment.paymentStatus === PaymentStatus.FAILED;
    if (
        !hasSafeOrderPaymentStatus
        || payment.paidAmountMinor !== 0
    ) {
        throw new ValidationError(CANCELLATION_REQUIRES_REFUND_MESSAGE);
    }

    const unsafePayment = await db
        .select({ id: orderPayments.id })
        .from(orderPayments)
        .where(and(
            eq(orderPayments.orderId, orderId),
            inArray(orderPayments.status, [...CANCELLATION_UNSAFE_PAYMENT_RECORD_STATUSES]),
        ))
        .get();
    if (unsafePayment) {
        throw new ValidationError(CANCELLATION_REQUIRES_PAYMENT_RECONCILIATION_MESSAGE);
    }
}

const COD_ACTION_REFUSALS: Record<OrderCodAction, string> = {
    collected: "Cash can be recorded once the order is sent with a courier.",
    failed: "A failed delivery can be recorded only while the order is with the courier.",
    returned: "Only an order that was sent can be marked returned.",
};

function assertOrderCodActionAllowed(status: string, action: OrderCodAction): void {
    if (canProcessOrderCodAction(status, action)) return;
    throw new ValidationError(COD_ACTION_REFUSALS[action]);
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
            // A parcel that failed once and was delivered on the next try is delivered.
            sql`${deliveryShipments.status} NOT IN (
                ${ShipmentStatus.DELIVERED},
                ${ShipmentStatus.RETURNED},
                ${ShipmentStatus.CANCELLED},
                ${ShipmentStatus.FAILED}
            )`,
        )),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    await db.batch(writes as any);
}

/**
 * A courier booking sends the whole order: every line is handed over, so
 * returns and return-to-sender can count what was sent. Idempotent.
 */
async function markAllOrderItemsSent(db: Database, orderId: string): Promise<void> {
    await db.update(orderItems).set({
        shippedQuantity: sql`${orderItems.quantity}`,
        fulfillmentStatus: ItemFulfillmentStatus.SHIPPED,
    }).where(and(
        eq(orderItems.orderId, orderId),
        inArray(orderItems.fulfillmentStatus, [
            ItemFulfillmentStatus.PENDING,
            ItemFulfillmentStatus.PICKED,
            ItemFulfillmentStatus.PACKED,
        ]),
    ));
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

async function getRecordedCodCollection(
    db: Database,
    orderId: string,
    currency: OrderCurrencySnapshot,
): Promise<{ amountMinor: number; collectedBy: string } | null> {
    const payment = await db
        .select({
            id: orderPayments.id,
            amountMinor: orderPayments.amountMinor,
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
    return { amountMinor: payment.amountMinor, collectedBy };
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
                await markAllOrderItemsSent(db, orderId);
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
                    await markAllOrderItemsSent(db, orderId);
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
            const requestedAmountMinor = toMinor(requestedAmount, currency.decimalPlaces);
            const existingCodCollection = await getRecordedCodCollection(db, orderId, currency);
            const collection = existingCodCollection
                ? null
                : validateCODCollectionDetails(order, {
                    collectedBy: body.collectedBy as string,
                    collectedAmountMinor: requestedAmountMinor,
                });

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
            assertOrderCodActionAllowed(order.status, "failed");
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

export async function getOrderShipments(db: Database, orderId: string) {
    const rows = await db.select({
        ...getTableColumns(deliveryShipments),
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
    }).from(deliveryShipments)
        .innerJoin(orders, eq(orders.id, deliveryShipments.orderId))
        .where(eq(deliveryShipments.orderId, orderId))
        .all();
    return rows.map(presentShipment);
}

const SENDABLE_ORDER_STATUSES = new Set<string>([
    OrderStatus.CONFIRMED,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
]);

interface ShipmentLine {
    itemId: string;
    quantity: number;
}

/**
 * The lines one own-courier shipment sends: explicit `{ itemId, quantity }`
 * pairs (part of a line is fine), whole lines by id, or everything left.
 */
function resolveShipmentLines(
    items: ReadonlyArray<{ id: string; quantity: number; shippedQuantity: number }>,
    body: Record<string, unknown>,
): ShipmentLine[] {
    const remaining = new Map(items.map((item) => [item.id, item.quantity - item.shippedQuantity]));
    const requested: ShipmentLine[] = Array.isArray(body.items)
        ? (body.items as ShipmentLine[]).map((line) => ({ itemId: line.itemId, quantity: line.quantity }))
        : Array.isArray(body.itemIds)
            ? (body.itemIds as string[]).map((itemId) => ({ itemId, quantity: remaining.get(itemId) ?? 0 }))
            : items.map((item) => ({ itemId: item.id, quantity: remaining.get(item.id) ?? 0 }))
                .filter((line) => line.quantity > 0);
    if (requested.length === 0) {
        throw new ValidationError(
            Array.isArray(body.items) || Array.isArray(body.itemIds)
                ? "Choose at least one item to send."
                : "Everything in this order has already been sent.",
        );
    }
    if (new Set(requested.map((line) => line.itemId)).size !== requested.length) {
        throw new ValidationError("Each item can appear only once in a shipment.");
    }
    for (const line of requested) {
        const left = remaining.get(line.itemId);
        if (left === undefined) {
            throw new ValidationError("An item in this shipment is not part of the order. Reload and try again.");
        }
        if (!Number.isInteger(line.quantity) || line.quantity < 1) {
            throw new ValidationError("Send at least 1 of each selected item.");
        }
        if (line.quantity > left) {
            throw new ConflictError(
                left === 0
                    ? "Some of these items were already sent. Reload to see the latest."
                    : `Only ${left} of that item ${left === 1 ? "is" : "are"} left to send.`,
            );
        }
    }
    return requested;
}

async function findShipmentByRequestKey(db: Database, orderId: string, requestKey: string) {
    const rows = await db.select({
        id: deliveryShipments.id,
        isFinalShipment: deliveryShipments.isFinalShipment,
        metadata: deliveryShipments.metadata,
    }).from(deliveryShipments).where(and(
        eq(deliveryShipments.orderId, orderId),
        eq(deliveryShipments.providerType, "manual"),
    )).all();
    return rows.find((row) => parseShipmentMetadata(row.metadata).requestKey === requestKey) ?? null;
}

export async function createFulfillmentShipment(db: Database, orderId: string, body: Record<string, unknown>) {
    const order = await db.select({
        id: orders.id,
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        version: orders.version,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);
    const requestKey = typeof body.requestKey === "string" && body.requestKey.trim()
        ? body.requestKey.trim()
        : null;
    if (requestKey) {
        // A double click or a retried request returns the first shipment
        // instead of failing on items that it already sent (ORD-10).
        const replay = await findShipmentByRequestKey(db, orderId, requestKey);
        if (replay) {
            return {
                shipmentId: replay.id,
                isFinalShipment: replay.isFinalShipment ?? false,
                fulfillmentStatus: order.fulfillmentStatus,
                availabilityTransitionVariantIds: [] as string[],
                lines: [] as ShipmentLine[],
                replayed: true,
                statusChange: undefined,
            };
        }
    }
    const shipmentAmount = body.shipmentAmount;
    if (shipmentAmount != null && (typeof shipmentAmount !== "number" || !Number.isFinite(shipmentAmount) || shipmentAmount < 0)) {
        throw new ValidationError("The delivery cost can't be negative.");
    }
    await assertNoActiveRefundAttempt(db, orderId);
    await assertNoActivePaymentSessionAttempt(db, orderId);
    if (!SENDABLE_ORDER_STATUSES.has(order.status)) {
        throw new ValidationError(
            order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED
                ? "A cancelled or returned order can't be sent."
                : "Confirm the order before sending it.",
        );
    }

    const allItems = await db.select({
        id: orderItems.id,
        quantity: orderItems.quantity,
        shippedQuantity: orderItems.shippedQuantity,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    const lines = resolveShipmentLines(allItems, body);
    const shipmentId = `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date();
    const remainingAfter = allItems.reduce((sum, item) => {
        const sent = lines.find((line) => line.itemId === item.id)?.quantity ?? 0;
        return sum + item.quantity - item.shippedQuantity - sent;
    }, 0);
    const isFinalShipment = remainingAfter === 0;

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
        throw new ConflictError("This order changed. Reload to see the latest.");
    }

    // Drizzle D1 batch() requires specific tuple types
    const writes: unknown[] = [];

    writes.push(db.insert(deliveryShipments).values({
        id: shipmentId, orderId, trackingId: (body.trackingId as string | undefined) ?? null, trackingUrl: (body.trackingUrl as string | undefined) ?? null,
        courierName: (body.courierName as string | undefined) ?? null,
        status: ShipmentStatus.IN_TRANSIT,
        rawStatus: ShipmentStatus.IN_TRANSIT,
        note: (body.note as string | undefined) ?? null,
        shipmentItems: JSON.stringify(lines),
        shipmentAmountMinor: shipmentAmount == null ? null : toMinor(shipmentAmount, order.currencyDecimalPlaces),
        isFinalShipment,
        metadata: requestKey ? JSON.stringify({ requestKey }) : null,
        createdAt: now, updatedAt: now,
    }));

    for (const line of lines) {
        const item = allItems.find((candidate) => candidate.id === line.itemId)!;
        const shippedQuantity = item.shippedQuantity + line.quantity;
        writes.push(db.update(orderItems).set({
            shippedQuantity,
            ...(shippedQuantity === item.quantity ? { fulfillmentStatus: ItemFulfillmentStatus.SHIPPED } : {}),
        }).where(and(
            eq(orderItems.id, line.itemId),
            eq(orderItems.orderId, orderId),
            eq(orderItems.shippedQuantity, item.shippedQuantity),
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
        /** What this parcel holds, for the timeline and the shipping message. */
        lines,
        replayed: false,
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
        totalAmountMinor: orders.totalAmountMinor,
        paidAmountMinor: orders.paidAmountMinor,
        balanceDueMinor: orders.balanceDueMinor,
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
        const hasMoneyDue = existingOrder.balanceDueMinor > 0
            || existingOrder.totalAmountMinor > existingOrder.paidAmountMinor;
        if (hasMoneyDue || existingOrder.paymentStatus !== PaymentStatus.PAID) {
            throw new ValidationError(
                existingOrder.paymentMethod === PaymentMethod.COD
                    ? "Mark the cash as collected first."
                    : existingOrder.paymentStatus === PaymentStatus.PARTIAL
                    ? "Record the rest of the payment first."
                    : "This order still has money due.",
            );
        }

        if (existingOrder.paymentMethod === PaymentMethod.COD) {
            const hasCodCollection = await hasRecordedCodCollection(db, orderId, currency);
            if (!hasCodCollection || existingOrder.paidAmountMinor <= 0) {
                throw new ValidationError("Mark the cash as collected first.");
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

    if (nextStatus === OrderStatus.CANCELLED) {
        await assertNothingWithTheCourier(db, orderId);
        await assertGenericCancellationPaymentSafe(db, orderId, existingOrder);
    }

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
        ...(nextStatus === OrderStatus.CANCELLED
            ? [noUnsafeCancellationPaymentCondition(orderId), nothingSentCondition(orderId)]
            : []),
    )).returning({ id: orders.id });

    if (result.length === 0) {
        throw new ConflictError("This order changed. Reload to see the latest.");
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

/**
 * Units already handed to a courier are out of the building: cancelling would
 * put them back into sellable stock while a rider still holds them (R2-ORD-02).
 * They must come back as a return, or be delivered, first.
 */
async function assertNothingWithTheCourier(db: Database, orderId: string): Promise<void> {
    const row = await db.select({
        sent: sql<number>`coalesce(sum(${orderItems.shippedQuantity}), 0)`,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).get();
    const sent = Number(row?.sent ?? 0);
    if (sent > 0) {
        throw new ValidationError(sent === 1
            ? "1 item is with the courier. Mark it returned or delivered first."
            : `${sent} items are with the courier. Mark them returned or delivered first.`);
    }
}

function nothingSentCondition(orderId: string) {
    return sql`NOT EXISTS (SELECT 1 FROM ${orderItems} WHERE ${orderItems.orderId} = ${orderId} AND ${orderItems.shippedQuantity} > 0)`;
}

export interface BulkOrderActionResult {
    orderId: string;
    success: boolean;
    error?: string;
}

/**
 * Confirms each new order in the selection (the phone-confirmation queue).
 * Orders past that stage are reported as skipped, never changed. With a
 * request key, running the same selection again (double click, retry) reports
 * the orders it already confirmed as done instead of failed.
 */
export async function bulkConfirmOrders(
    db: Database,
    orderIds: readonly string[],
    options: { requestKey?: string; actorId?: string | null } = {},
) {
    const results: Array<BulkOrderActionResult & { update?: StatusUpdateResult }> = [];
    const eventKey = options.requestKey ? `bulk-confirm:${options.requestKey}` : null;
    for (const orderId of orderIds) {
        try {
            const order = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).get();
            if (!order) throw new NotFoundError("Order not found");
            if (eventKey && await hasOrderEvent(db, orderId, "status_changed", eventKey)) {
                results.push({ orderId, success: true });
                continue;
            }
            if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.PROCESSING) {
                results.push({ orderId, success: false, error: "Only new orders can be confirmed." });
                continue;
            }
            const update = await updateOrderStatus(db, orderId, OrderStatus.CONFIRMED);
            await recordOrderEvent(db, {
                orderId,
                kind: "status_changed",
                actorId: options.actorId ?? null,
                requestKey: eventKey,
                data: { from: order.status, to: OrderStatus.CONFIRMED },
            });
            results.push({ orderId, success: true, update });
        } catch (error: unknown) {
            results.push({ orderId, success: false, error: error instanceof Error ? error.message : "Couldn't confirm this order." });
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
