// src/modules/payments/refund-service.ts
// Gateway-agnostic refund orchestrator.
// Determines the correct payment gateway from the order's payment records
// and dispatches the refund via the unified PaymentProvider interface.

import { eq, sql, desc, and, inArray } from "drizzle-orm";
import {
    orders,
    orderPayments,
    refundAttempts,
    PaymentStatus,
    OrderStatus,
    PaymentRecordStatus,
    type OrderPayment,
} from "@scalius/database/schema";
import { createPaymentProvider } from "./factory";
import {
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
    getStripeSettings,
    getSSLCommerzSettings,
    getPolarSettings,
} from "./gateway-settings";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import type { Database } from "@scalius/database/client";
import type { PaymentGateway } from "./types";
import { NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { roundPrice } from "@scalius/shared/price-utils";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCurrencyConfig } from "../settings/settings.service";
import { canTransitionTo } from "../orders/order-state-machine";
import { assertNoActiveShipmentClaim } from "../orders/shipment-claim";
import { computePaymentStateAfterRefund } from "./payment-state";
import type {
    PaymentProvider,
    RefundParams as ProviderRefundParams,
    RefundResult as ProviderRefundResult,
} from "./provider";

export interface RefundRequest {
    orderId: string;
    /** Amount to refund. If omitted, full refund of paidAmount. */
    amount?: number;
    reason: string;
    /** Override gateway detection (useful for multi-gateway orders) */
    gateway?: "stripe" | "sslcommerz" | "polar" | "cod";
}

export interface RefundResult {
    success: boolean;
    gateway: string;
    refundId?: string;
    amount: number;
    isFullRefund: boolean;
    error?: string;
}

const REFUND_IN_PROGRESS_MESSAGE = "A refund is already in progress for this order. Please wait and retry.";
const REFUND_PROVIDER_DEADLINE_MS = 25_000;
const REFUND_ATTEMPT_LEASE_SECONDS = 5 * 60;
const MAX_REFUND_ATTEMPT_ERROR_LENGTH = 500;
const PRE_FULFILLMENT_REFUND_STATUSES = new Set<string>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
]);
const ACTIVE_REFUND_ATTEMPT_STATUSES = [
    "pending",
    "processing",
    "provider_unknown",
    "reconcile_required",
] as const;

type CapturedPayment = OrderPayment & { paymentMethod: PaymentGateway };

interface RefundAllocation {
    id: string;
    sourcePayment: CapturedPayment;
    amount: number;
    idempotencyKey: string;
    refundReference: string;
    index: number;
}

interface CompletedRefundAllocation extends RefundAllocation {
    refundId?: string;
}

class ProviderRefundOutcomeUnknownError extends ServiceUnavailableError {
    readonly originalError: unknown;

    constructor(originalError: unknown) {
        super("Refund provider outcome is unknown. The refund remains pending to prevent duplicate refunds until it is reconciled.");
        this.name = "ProviderRefundOutcomeUnknownError";
        this.originalError = originalError;
    }
}

function getRefundClaimBaseId(orderId: string, orderVersion: number): string {
    return `refund_${orderId}_${orderVersion}`;
}

function getRefundClaimId(orderId: string, orderVersion: number, allocationIndex: number): string {
    return `${getRefundClaimBaseId(orderId, orderVersion)}_${allocationIndex + 1}`;
}

function getRefundAttemptId(allocation: Pick<RefundAllocation, "id">): string {
    return `rfa_${allocation.id}`;
}

function getRefundAttemptKey(allocation: Pick<RefundAllocation, "idempotencyKey">): string {
    return `refund_attempt:${allocation.idempotencyKey}`;
}

function normalizePaymentGateway(value: string): PaymentGateway {
    if (value === "stripe" || value === "sslcommerz" || value === "polar" || value === "cod") {
        return value;
    }
    throw new ValidationError(`Unsupported payment gateway: ${value}`);
}

function parseRefundMetadata(metadata: string | null): Record<string, unknown> {
    if (!metadata) return {};
    try {
        const parsed = JSON.parse(metadata) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function getRefundSourcePaymentId(refund: Pick<OrderPayment, "metadata">): string | undefined {
    const metadata = parseRefundMetadata(refund.metadata);
    const sourcePaymentId = metadata.sourcePaymentId;
    return typeof sourcePaymentId === "string" && sourcePaymentId ? sourcePaymentId : undefined;
}

function buildRefundIdempotencyKey(orderId: string, sourcePaymentId: string, claimVersion: number): string {
    return `refund:${orderId}:${sourcePaymentId}:${claimVersion}`;
}

function buildRefundReference(orderId: string, sourcePaymentId: string, claimVersion: number, index: number): string {
    const suffix = `${orderId}${sourcePaymentId}${claimVersion}${index + 1}`
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(-24)
        .toUpperCase();
    return `REF${suffix}`.slice(0, 30);
}

function computeRefundedBySourcePayment(
    capturedPayments: CapturedPayment[],
    refundRows: Array<Pick<OrderPayment, "amount" | "metadata">>,
): Map<string, number> {
    const refundedBySource = new Map<string, number>();
    let unattributedRefundAmount = 0;

    for (const refund of refundRows) {
        const amount = roundPrice(Math.max(0, refund.amount));
        if (amount <= 0) continue;

        const sourcePaymentId = getRefundSourcePaymentId(refund);
        if (sourcePaymentId) {
            refundedBySource.set(sourcePaymentId, roundPrice((refundedBySource.get(sourcePaymentId) ?? 0) + amount));
        } else {
            unattributedRefundAmount = roundPrice(unattributedRefundAmount + amount);
        }
    }

    // Older refund rows did not store sourcePaymentId. Attribute those refunds
    // against newest captures first, matching the old "latest payment" behavior,
    // so future allocations cannot over-refund an order that has old history.
    for (const payment of capturedPayments) {
        if (unattributedRefundAmount <= 0) break;
        const alreadyRefunded = refundedBySource.get(payment.id) ?? 0;
        const remainingPaymentAmount = roundPrice(Math.max(0, payment.amount - alreadyRefunded));
        const applied = roundPrice(Math.min(remainingPaymentAmount, unattributedRefundAmount));
        if (applied > 0) {
            refundedBySource.set(payment.id, roundPrice(alreadyRefunded + applied));
            unattributedRefundAmount = roundPrice(unattributedRefundAmount - applied);
        }
    }

    return refundedBySource;
}

function buildRefundAllocations(params: {
    orderId: string;
    claimVersion: number;
    refundAmount: number;
    capturedPayments: CapturedPayment[];
    refundRows: Array<Pick<OrderPayment, "amount" | "metadata">>;
}): RefundAllocation[] {
    const refundedBySource = computeRefundedBySourcePayment(params.capturedPayments, params.refundRows);
    let remainingRefundAmount = params.refundAmount;
    const allocations: RefundAllocation[] = [];

    for (const sourcePayment of params.capturedPayments) {
        if (remainingRefundAmount <= 0) break;
        const alreadyRefunded = refundedBySource.get(sourcePayment.id) ?? 0;
        const refundableAmount = roundPrice(Math.max(0, sourcePayment.amount - alreadyRefunded));
        if (refundableAmount <= 0) continue;

        const amount = roundPrice(Math.min(refundableAmount, remainingRefundAmount));
        const index = allocations.length;
        allocations.push({
            id: getRefundClaimId(params.orderId, params.claimVersion - 1, index),
            sourcePayment,
            amount,
            idempotencyKey: buildRefundIdempotencyKey(params.orderId, sourcePayment.id, params.claimVersion),
            refundReference: buildRefundReference(params.orderId, sourcePayment.id, params.claimVersion, index),
            index,
        });
        remainingRefundAmount = roundPrice(remainingRefundAmount - amount);
    }

    if (remainingRefundAmount > 0) {
        throw new ValidationError("Refund amount exceeds refundable captured payment balance", {
            requestedAmount: params.refundAmount,
            remainingUnallocatedAmount: remainingRefundAmount,
        });
    }

    if (allocations.length === 0) {
        throw new NotFoundError("No refundable payment record found for this order");
    }

    return allocations;
}

function getResultGateway(allocations: RefundAllocation[]): string {
    const gateways = [...new Set(allocations.map((allocation) => allocation.sourcePayment.paymentMethod))];
    return gateways.length === 1 ? gateways[0]! : "mixed";
}

function isConstraintError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /constraint|unique|primary key/i.test(message);
}

function isProviderRefundOutcomeUnknownError(error: unknown): error is ProviderRefundOutcomeUnknownError {
    return error instanceof ProviderRefundOutcomeUnknownError;
}

function serializeRefundAttemptError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, MAX_REFUND_ATTEMPT_ERROR_LENGTH);
}

async function buildRefundRequestHash(params: {
    request: RefundRequest;
    refundAmount: number;
    currency: string;
    allocations: RefundAllocation[];
}): Promise<string> {
    return sha256Hex(stableStringify({
        orderId: params.request.orderId,
        amount: params.refundAmount,
        reason: params.request.reason,
        gateway: params.request.gateway ?? null,
        currency: params.currency,
        allocations: params.allocations.map((allocation) => ({
            sourcePaymentId: allocation.sourcePayment.id,
            amount: allocation.amount,
            gateway: allocation.sourcePayment.paymentMethod,
            providerIdempotencyKey: allocation.idempotencyKey,
            refundReference: allocation.refundReference,
            allocationIndex: allocation.index,
        })),
    }));
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function getOrderStatusAfterRefund(currentStatus: string, isFullRefund: boolean): string | undefined {
    if (!isFullRefund) {
        return canTransitionTo("order", currentStatus, OrderStatus.PARTIALLY_REFUNDED)
            ? OrderStatus.PARTIALLY_REFUNDED
            : undefined;
    }

    if (canTransitionTo("order", currentStatus, OrderStatus.REFUNDED)) {
        return OrderStatus.REFUNDED;
    }

    if (
        PRE_FULFILLMENT_REFUND_STATUSES.has(currentStatus) &&
        canTransitionTo("order", currentStatus, OrderStatus.CANCELLED)
    ) {
        return OrderStatus.CANCELLED;
    }

    return undefined;
}

function shouldReleaseInventoryForFullRefund(currentStatus: string, nextStatus: string | undefined): boolean {
    return nextStatus === OrderStatus.CANCELLED && PRE_FULFILLMENT_REFUND_STATUSES.has(currentStatus);
}

async function updateOrderStatusIfVersionMatches(
    db: Database,
    params: {
        orderId: string;
        nextStatus: string;
        expectedVersion: number;
    },
): Promise<boolean> {
    const result = await db
        .update(orders)
        .set({
            status: params.nextStatus,
            version: sql`${orders.version} + 1`,
            updatedAt: sql`unixepoch()`,
        })
        .where(and(
            eq(orders.id, params.orderId),
            eq(orders.version, params.expectedVersion),
        ))
        .returning({ id: orders.id });

    return result.length > 0;
}

async function assertNoActiveRefundAttempt(db: Database, orderId: string): Promise<void> {
    const activeAttempt = await db
        .select({ id: refundAttempts.id, status: refundAttempts.status })
        .from(refundAttempts)
        .where(
            and(
                eq(refundAttempts.orderId, orderId),
                inArray(refundAttempts.status, [...ACTIVE_REFUND_ATTEMPT_STATUSES]),
            ),
        )
        .get();

    if (activeAttempt) {
        throw new ConflictError(REFUND_IN_PROGRESS_MESSAGE);
    }

    const pendingRefund = await db
        .select({ id: orderPayments.id })
        .from(orderPayments)
        .where(
            and(
                eq(orderPayments.orderId, orderId),
                eq(orderPayments.paymentType, "refund"),
                eq(orderPayments.status, "pending"),
            ),
        )
        .get();

    if (pendingRefund) {
        throw new ConflictError(REFUND_IN_PROGRESS_MESSAGE);
    }
}

function buildRefundMetadata(params: {
    request: RefundRequest;
    allocation: RefundAllocation;
    groupId: string;
    claimVersion: number;
    allocationCount: number;
    status: "pending" | "refunded" | "failed";
    refundId?: string;
    providerOutcome?: "not_dispatched" | "accepted" | "rejected" | "unknown";
    error?: unknown;
}): string {
    const failedMessage = params.error instanceof Error
        ? params.error.message
        : params.error == null
            ? undefined
            : String(params.error);

    return JSON.stringify({
        reason: params.request.reason,
        gateway: params.allocation.sourcePayment.paymentMethod,
        sourcePaymentId: params.allocation.sourcePayment.id,
        sourcePaymentType: params.allocation.sourcePayment.paymentType,
        sourceTransactionId: getTransactionId(
            params.allocation.sourcePayment.paymentMethod,
            params.allocation.sourcePayment,
        ),
        refundGroupId: params.groupId,
        allocationIndex: params.allocation.index,
        allocationCount: params.allocationCount,
        providerIdempotencyKey: params.allocation.idempotencyKey,
        refundReference: params.allocation.refundReference,
        claimVersion: params.claimVersion,
        providerOutcome: params.providerOutcome ?? (
            params.status === "refunded"
                ? "accepted"
                : params.status === "failed"
                    ? "rejected"
                    : "not_dispatched"
        ),
        ...(params.refundId ? { refundId: params.refundId, providerRefundId: params.refundId } : {}),
        ...(params.status === "pending" ? { claimedAt: new Date().toISOString() } : {}),
        ...(params.status === "pending" && params.providerOutcome === "unknown" ? {
            error: failedMessage,
            providerOutcomeUnknownAt: new Date().toISOString(),
        } : {}),
        ...(params.status === "refunded" ? { refundedAt: new Date().toISOString() } : {}),
        ...(params.status === "failed" ? { error: failedMessage, failedAt: new Date().toISOString() } : {}),
    });
}

function buildRefundAttemptMetadata(params: {
    request: RefundRequest;
    allocation: RefundAllocation;
    groupId: string;
    claimVersion: number;
    allocationCount: number;
}): string {
    return JSON.stringify({
        reason: params.request.reason,
        gateway: params.allocation.sourcePayment.paymentMethod,
        refundGroupId: params.groupId,
        claimVersion: params.claimVersion,
        sourcePaymentId: params.allocation.sourcePayment.id,
        sourcePaymentType: params.allocation.sourcePayment.paymentType,
        allocationIndex: params.allocation.index,
        allocationCount: params.allocationCount,
    });
}

function buildRefundAttemptInsert(params: {
    request: RefundRequest;
    allocation: RefundAllocation;
    groupId: string;
    claimVersion: number;
    allocationCount: number;
    requestHash: string;
    currency: string;
}) {
    return {
        id: getRefundAttemptId(params.allocation),
        attemptKey: getRefundAttemptKey(params.allocation),
        refundGroupId: params.groupId,
        orderId: params.request.orderId,
        sourcePaymentId: params.allocation.sourcePayment.id,
        refundPaymentId: params.allocation.id,
        gateway: params.allocation.sourcePayment.paymentMethod,
        amount: params.allocation.amount,
        currency: params.currency,
        reason: params.request.reason,
        requestHash: params.requestHash,
        providerIdempotencyKey: params.allocation.idempotencyKey,
        refundReference: params.allocation.refundReference,
        allocationIndex: params.allocation.index,
        allocationCount: params.allocationCount,
        sourceTransactionId: getRefundAttemptSourceTransactionId(params.allocation),
        status: "pending",
        claimId: params.groupId,
        claimExpiresAt: sql`unixepoch() + ${REFUND_ATTEMPT_LEASE_SECONDS}`,
        metadata: buildRefundAttemptMetadata(params),
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    };
}

function getRefundAttemptSourceTransactionId(allocation: RefundAllocation): string | null {
    if (allocation.sourcePayment.paymentMethod === "cod") {
        return null;
    }
    return getTransactionId(allocation.sourcePayment.paymentMethod, allocation.sourcePayment);
}

async function markRefundAttemptProcessing(
    db: Database,
    allocation: RefundAllocation,
    refundGroupId: string,
): Promise<void> {
    await db.update(refundAttempts).set({
        status: "processing",
        attempts: sql`${refundAttempts.attempts} + 1`,
        claimId: refundGroupId,
        claimExpiresAt: sql`unixepoch() + ${REFUND_ATTEMPT_LEASE_SECONDS}`,
        lastError: null,
        updatedAt: sql`unixepoch()`,
    }).where(eq(refundAttempts.id, getRefundAttemptId(allocation)));
}

async function markRefundAttemptProviderAccepted(
    db: Database,
    allocation: CompletedRefundAllocation,
): Promise<void> {
    await db.update(refundAttempts).set({
        status: "processing",
        providerRefundId: allocation.refundId ?? null,
        providerStatus: "accepted",
        responsePayload: JSON.stringify({ refundId: allocation.refundId ?? null }),
        updatedAt: sql`unixepoch()`,
    }).where(eq(refundAttempts.id, getRefundAttemptId(allocation)));
}

async function markRefundAttemptsRefunded(
    db: Database,
    allocations: CompletedRefundAllocation[],
): Promise<void> {
    if (allocations.length === 0) return;

    await db.batch(allocations.map((allocation) =>
        db.update(refundAttempts).set({
            status: "refunded",
            providerStatus: "accepted",
            providerRefundId: allocation.refundId ?? null,
            claimId: null,
            claimExpiresAt: null,
            refundedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }).where(eq(refundAttempts.id, getRefundAttemptId(allocation)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ) as any);
}

async function markRefundAttemptsReconcileRequired(
    db: Database,
    allocations: CompletedRefundAllocation[],
    error: unknown,
): Promise<void> {
    if (allocations.length === 0) return;

    await db.batch(allocations.map((allocation) =>
        db.update(refundAttempts).set({
            status: "reconcile_required",
            providerStatus: "accepted",
            providerRefundId: allocation.refundId ?? null,
            claimId: null,
            claimExpiresAt: null,
            nextProbeAt: sql`unixepoch()`,
            lastError: serializeRefundAttemptError(error),
            updatedAt: sql`unixepoch()`,
        }).where(eq(refundAttempts.id, getRefundAttemptId(allocation)))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ) as any);
}

async function markRefundAllocationsFailed(
    db: Database,
    params: {
        request: RefundRequest;
        allocations: RefundAllocation[];
        groupId: string;
        claimVersion: number;
        allocationCount: number;
        error: unknown;
    },
): Promise<void> {
    if (params.allocations.length === 0) return;

    await db.batch(
        params.allocations.flatMap((allocation) => [
        db.update(orderPayments).set({
            status: PaymentRecordStatus.FAILED,
            metadata: buildRefundMetadata({
                request: params.request,
                allocation,
                groupId: params.groupId,
                claimVersion: params.claimVersion,
                allocationCount: params.allocationCount,
                status: "failed",
                error: params.error,
            }),
            updatedAt: sql`unixepoch()`,
        }).where(eq(orderPayments.id, allocation.id)),
        db.update(refundAttempts).set({
            status: "failed",
            providerStatus: "rejected",
            claimId: null,
            claimExpiresAt: null,
            lastError: serializeRefundAttemptError(params.error),
            failedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }).where(eq(refundAttempts.id, getRefundAttemptId(allocation))),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        ]) as any,
    );
}

async function markRefundAllocationsProviderUnknown(
    db: Database,
    params: {
        request: RefundRequest;
        allocations: RefundAllocation[];
        groupId: string;
        claimVersion: number;
        allocationCount: number;
        error: unknown;
    },
): Promise<void> {
    if (params.allocations.length === 0) return;

    const originalError = isProviderRefundOutcomeUnknownError(params.error)
        ? params.error.originalError
        : params.error;

    await db.batch(
        params.allocations.flatMap((allocation) => [
        db.update(orderPayments).set({
            status: PaymentRecordStatus.PENDING,
            metadata: buildRefundMetadata({
                request: params.request,
                allocation,
                groupId: params.groupId,
                claimVersion: params.claimVersion,
                allocationCount: params.allocationCount,
                status: "pending",
                providerOutcome: "unknown",
                error: originalError,
            }),
            updatedAt: sql`unixepoch()`,
        }).where(eq(orderPayments.id, allocation.id)),
        db.update(refundAttempts).set({
            status: "provider_unknown",
            providerStatus: "unknown",
            claimId: null,
            claimExpiresAt: null,
            nextProbeAt: sql`unixepoch()`,
            lastError: serializeRefundAttemptError(originalError),
            updatedAt: sql`unixepoch()`,
        }).where(eq(refundAttempts.id, getRefundAttemptId(allocation))),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        ]) as any,
    );
}

async function applyRefundedPaymentState(
    db: Database,
    params: {
        orderId: string;
        totalAmount: number;
        currentPaidAmount: number;
        refundAmount: number;
        isFullRefund: boolean;
        expectedVersion: number;
    },
): Promise<{ version: number }> {
    const newPaymentState = computePaymentStateAfterRefund({
        totalAmount: params.totalAmount,
        currentPaidAmount: params.currentPaidAmount,
        refundAmount: params.refundAmount,
        isFullRefund: params.isFullRefund,
    });

    const rows = await db.update(orders).set({
        paidAmount: newPaymentState.paidAmount,
        balanceDue: newPaymentState.balanceDue,
        paymentStatus: newPaymentState.paymentStatus,
        version: sql`${orders.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, params.orderId),
        eq(orders.version, params.expectedVersion),
        sql`${orders.paidAmount} >= ${params.refundAmount}`,
    )).returning({ version: orders.version });

    const updated = rows[0];
    if (!updated) {
        throw new ConflictError("Refund payment state could not be updated after provider refund succeeded. Please review before retrying.");
    }

    return updated;
}

// ---------------------------------------------------------------------------
// Gateway transaction ID resolution
// ---------------------------------------------------------------------------

/** Extract the correct gateway-specific transaction ID from a payment record. */
function getTransactionId(
    gateway: PaymentGateway,
    payment: { stripeChargeId?: string | null; sslcommerzBankTranId?: string | null; polarCheckoutId?: string | null },
): string {
    switch (gateway) {
        case "stripe": {
            if (!payment.stripeChargeId) throw new ValidationError("No Stripe charge ID found on payment record");
            return payment.stripeChargeId;
        }
        case "sslcommerz": {
            if (!payment.sslcommerzBankTranId) throw new ValidationError("No SSLCommerz bank_tran_id found on payment record");
            return payment.sslcommerzBankTranId;
        }
        case "polar": {
            if (!payment.polarCheckoutId) throw new ValidationError("No Polar order ID found on payment record");
            return payment.polarCheckoutId;
        }
        case "cod":
            return `COD-${Date.now()}`;
        default:
            throw new ValidationError(`Unsupported payment gateway: ${gateway}`);
    }
}

// ---------------------------------------------------------------------------
// Resolve gateway settings and create provider
// ---------------------------------------------------------------------------

async function resolveProvider(
    db: Database,
    kv: KVNamespace | undefined,
    gateway: PaymentGateway,
    encryptionKey?: string,
) {
    switch (gateway) {
        case "stripe": {
            const settings = await getStripeSettings(
                db,
                kv,
                encryptionKey,
                FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
            );
            if (!settings) throw new ServiceUnavailableError("Stripe is not configured");
            return createPaymentProvider({ type: "stripe", settings });
        }
        case "sslcommerz": {
            const settings = await getSSLCommerzSettings(
                db,
                kv,
                encryptionKey,
                FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
            );
            if (!settings) throw new ServiceUnavailableError("SSLCommerz is not configured");
            return createPaymentProvider({ type: "sslcommerz", settings });
        }
        case "polar": {
            const settings = await getPolarSettings(
                db,
                kv,
                encryptionKey,
                FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
            );
            if (!settings) throw new ServiceUnavailableError("Polar is not configured");
            return createPaymentProvider({ type: "polar", settings });
        }
        case "cod":
            return createPaymentProvider({ type: "cod", db });
        default:
            throw new ValidationError(`Unsupported payment gateway: ${gateway}`);
    }
}

// ---------------------------------------------------------------------------
// Unified refund dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a refund through the unified PaymentProvider interface.
 * Returns the gateway-assigned refund ID.
 *
 * Amount conventions per gateway (matching RefundParams contract):
 *   - Stripe & Polar: smallest currency unit (cents/paisa)
 *   - SSLCommerz: major units (the provider passes through to SSLCommerz API)
 *   - COD: no external amount needed
 */
async function dispatchRefund(
    db: Database,
    kv: KVNamespace | undefined,
    gateway: PaymentGateway,
    payment: { stripeChargeId?: string | null; sslcommerzBankTranId?: string | null; polarCheckoutId?: string | null; metadata?: string | null },
    refundAmount: number,
    currencyDecimals: number,
    params: RefundRequest,
    providerMetadata: Record<string, string>,
    encryptionKey?: string,
): Promise<string | undefined> {
    const transactionId = getTransactionId(gateway, payment);
    const provider = await resolveProvider(db, kv, gateway, encryptionKey);

    // Determine the correct amount for each gateway's convention:
    // Stripe: smallest currency unit, always explicit for allocation safety
    // Polar: smallest currency unit, always requires explicit positive amount
    // SSLCommerz/COD: major units, always required
    let providerAmount: number | undefined;
    if (gateway === "stripe") {
        providerAmount = Math.round(refundAmount * Math.pow(10, currencyDecimals));
    } else if (gateway === "polar") {
        // Polar ALWAYS requires an explicit positive amount (no "refund all" shorthand).
        // If the payment used currency conversion (e.g. BDT→USD), convert the
        // store-currency refund amount to gateway currency using the stored rate.
        let gatewayRefundAmount = refundAmount;
        let gatewayDecimals = currencyDecimals;

        if (payment.metadata) {
            try {
                const meta = typeof payment.metadata === "string"
                    ? JSON.parse(payment.metadata)
                    : payment.metadata;
                const storedRate = parseFloat(meta?.exchangeRate);
                const gatewayCurrency = meta?.gatewayCurrency;
                if (storedRate && storedRate !== 1 && gatewayCurrency) {
                    gatewayRefundAmount = Math.round((refundAmount / storedRate) * 100) / 100;
                    gatewayDecimals = getDecimalPlaces(gatewayCurrency);
                }
            } catch { /* metadata parse failed — use store currency as-is */ }
        }

        providerAmount = Math.round(gatewayRefundAmount * Math.pow(10, gatewayDecimals));
    } else {
        // SSLCommerz and COD: always pass the explicit amount in major units
        providerAmount = refundAmount;
    }

    const refundParams = {
        transactionId,
        amount: providerAmount,
        reason: params.reason,
        metadata: providerMetadata,
    };

    let result: ProviderRefundResult;
    try {
        result = gateway === "cod"
            ? await provider.createRefund(refundParams)
            : await callProviderRefundWithDeadline(provider, refundParams);
    } catch (error: unknown) {
        if (gateway === "cod") throw error;
        throw new ProviderRefundOutcomeUnknownError(error);
    }

    return result.refundId;
}

async function callProviderRefundWithDeadline(
    provider: PaymentProvider,
    params: ProviderRefundParams,
): Promise<ProviderRefundResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            provider.createRefund(params),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`Refund provider did not settle within ${REFUND_PROVIDER_DEADLINE_MS}ms`));
                }, REFUND_PROVIDER_DEADLINE_MS);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

/**
 * Process a refund for an order.
 *
 * 1. Finds the payment record (or uses specified gateway)
 * 2. Claims refund capacity locally before provider dispatch
 * 3. Dispatches to the correct gateway API via PaymentProvider
 * 4. Finalizes order payment status
 * 5. Releases inventory on full refund
 */
export async function processRefund(
    db: Database,
    kv: KVNamespace | undefined,
    params: RefundRequest,
    encryptionKey?: string,
): Promise<RefundResult> {
    // 1. Fetch order (include version for CAS to prevent concurrent refund races)
    const order = await db
        .select({
            id: orders.id,
            totalAmount: orders.totalAmount,
            paidAmount: orders.paidAmount,
            balanceDue: orders.balanceDue,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            version: orders.version,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .get();

    if (!order) {
        throw new NotFoundError(`Order ${params.orderId} not found`);
    }
    assertNoActiveShipmentClaim(order);

    if (order.paymentStatus === PaymentStatus.UNPAID || order.paymentStatus === PaymentStatus.FAILED) {
        throw new ValidationError("Order has no payments to refund");
    }

    if (
        order.paymentStatus === PaymentStatus.REFUNDED &&
        order.status === OrderStatus.CANCELLED &&
        order.inventoryAction !== "deducted"
    ) {
        await applyInventoryForStatusChange(db, params.orderId, OrderStatus.CANCELLED);
        return {
            success: true,
            gateway: params.gateway ?? order.paymentMethod,
            amount: 0,
            isFullRefund: true,
        };
    }

    if (order.paymentStatus === PaymentStatus.REFUNDED) {
        throw new ConflictError("Order is already fully refunded");
    }

    await assertNoActiveRefundAttempt(db, params.orderId);

    // Determine and validate refund amount before any gateway calls
    const paidAmount = order.paidAmount ?? 0;
    const refundAmount = roundPrice(params.amount ?? (order.paidAmount ?? order.totalAmount));

    if (refundAmount <= 0) {
        throw new ValidationError("Refund amount must be greater than zero");
    }

    if (refundAmount > paidAmount) {
        throw new ValidationError(
            `Refund amount (${refundAmount}) exceeds paid amount (${paidAmount})`
        );
    }

    const isFullRefund = refundAmount >= paidAmount;

    // 2. Load all successful captures newest-first, then allocate the refund
    // across the remaining refundable amount on each source payment.
    const capturedPaymentRows = await db
        .select()
        .from(orderPayments)
        .where(
            and(
                eq(orderPayments.orderId, params.orderId),
                eq(orderPayments.status, PaymentRecordStatus.SUCCEEDED),
            ),
        )
        .orderBy(desc(orderPayments.createdAt));

    const capturedPayments = capturedPaymentRows
        .map((payment) => ({
            ...payment,
            paymentMethod: normalizePaymentGateway(payment.paymentMethod),
        }))
        .filter((payment) => !params.gateway || payment.paymentMethod === params.gateway);

    if (capturedPayments.length === 0) {
        throw new NotFoundError("No payment record found for this order");
    }

    const priorRefundRows = await db
        .select()
        .from(orderPayments)
        .where(
            and(
                eq(orderPayments.orderId, params.orderId),
                eq(orderPayments.paymentType, "refund"),
                eq(orderPayments.status, PaymentRecordStatus.REFUNDED),
            ),
        );

    // Get currency decimals for smallest-unit conversion (Stripe/Polar)
    const currencyConfig = await getCurrencyConfig(db, kv);
    const currencyDecimals = getDecimalPlaces(currencyConfig.code);

    const claimVersion = order.version + 1;
    const refundGroupId = getRefundClaimBaseId(params.orderId, order.version);
    const allocations = buildRefundAllocations({
        orderId: params.orderId,
        claimVersion,
        refundAmount,
        capturedPayments,
        refundRows: priorRefundRows,
    });
    const refundRequestHash = await buildRefundRequestHash({
        request: params,
        refundAmount,
        currency: currencyConfig.code,
        allocations,
    });
    const resultGateway = getResultGateway(allocations);

    // 3. Claim refund capacity locally before calling the gateway. The deterministic
    // refund allocation IDs and order-version CAS ensure that concurrent callers
    // cannot both pass this point and hit external providers.
    let claimResults: [...unknown[], Array<{ id: string; version: number }>];
    try {
        claimResults = await db.batch([
            ...allocations.flatMap((allocation) => [
                db.insert(orderPayments).values({
                    id: allocation.id,
                    orderId: params.orderId,
                    amount: allocation.amount,
                    currency: currencyConfig.code,
                    paymentMethod: allocation.sourcePayment.paymentMethod,
                    paymentType: "refund",
                    status: PaymentRecordStatus.PENDING,
                    metadata: buildRefundMetadata({
                        request: params,
                        allocation,
                        groupId: refundGroupId,
                        claimVersion,
                        allocationCount: allocations.length,
                        status: "pending",
                    }),
                    createdAt: sql`unixepoch()`,
                    updatedAt: sql`unixepoch()`,
                }),
                db.insert(refundAttempts).values(buildRefundAttemptInsert({
                    request: params,
                    allocation,
                    groupId: refundGroupId,
                    claimVersion,
                    allocationCount: allocations.length,
                    requestHash: refundRequestHash,
                    currency: currencyConfig.code,
                })),
            ]),
            db.update(orders).set({
                version: claimVersion,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orders.id, params.orderId),
                eq(orders.version, order.version),
                sql`${orders.paidAmount} >= ${refundAmount}`,
            )).returning({ id: orders.id, version: orders.version }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        ] as any) as any;
    } catch (error: unknown) {
        if (isConstraintError(error)) {
            throw new ConflictError(REFUND_IN_PROGRESS_MESSAGE);
        }
        throw error;
    }

    const claimedOrderResult = claimResults[claimResults.length - 1] as Array<{ id: string; version: number }> | undefined;
    const claimedOrder = claimedOrderResult?.[0];
    if (!claimedOrder) {
        await db.delete(refundAttempts).where(inArray(refundAttempts.refundPaymentId, allocations.map((allocation) => allocation.id)));
        await db.delete(orderPayments).where(inArray(orderPayments.id, allocations.map((allocation) => allocation.id)));
        throw new ConflictError(
            "Refund failed due to a concurrent modification. Please retry."
        );
    }

    // 4. Dispatch to gateway via unified PaymentProvider interface after the
    // local claim succeeds. Pre-provider failures become terminal failed rows.
    // Once a provider call starts, timeout/network/provider exceptions are
    // ambiguous: leave uncompleted rows pending so duplicate retries are blocked
    // until reconciliation proves whether the gateway accepted the refund.
    const completedAllocations: CompletedRefundAllocation[] = [];
    try {
        for (const allocation of allocations) {
            await markRefundAttemptProcessing(db, allocation, refundGroupId);
            const refundId = await dispatchRefund(
                db,
                kv,
                allocation.sourcePayment.paymentMethod,
                allocation.sourcePayment,
                allocation.amount,
                currencyDecimals,
                params,
                {
                    idempotencyKey: allocation.idempotencyKey,
                    refundReference: allocation.refundReference,
                    sourcePaymentId: allocation.sourcePayment.id,
                    refundGroupId,
                },
                encryptionKey,
            );

            const completedAllocation = { ...allocation, refundId };
            completedAllocations.push(completedAllocation);

            await db.update(orderPayments).set({
                status: PaymentRecordStatus.REFUNDED,
                // Refund records must NOT copy the original payment's unique gateway IDs —
                // partial unique indexes (e.g., UNIQUE(orderId, stripePaymentIntentId))
                // would reject the insert. Refund is identified by metadata.refundId instead.
                metadata: buildRefundMetadata({
                    request: params,
                    allocation,
                    groupId: refundGroupId,
                    claimVersion,
                    allocationCount: allocations.length,
                    status: "refunded",
                    refundId,
                }),
                updatedAt: sql`unixepoch()`,
            }).where(eq(orderPayments.id, allocation.id));
            await markRefundAttemptProviderAccepted(db, completedAllocation);
        }
    } catch (error: unknown) {
        const completedIds = new Set(completedAllocations.map((allocation) => allocation.id));
        const unresolvedAllocations = allocations.filter((allocation) => !completedIds.has(allocation.id));

        if (isProviderRefundOutcomeUnknownError(error)) {
            await markRefundAllocationsProviderUnknown(db, {
                request: params,
                allocations: unresolvedAllocations,
                groupId: refundGroupId,
                claimVersion,
                allocationCount: allocations.length,
                error,
            });
        } else {
            await markRefundAllocationsFailed(db, {
                request: params,
                allocations: unresolvedAllocations,
                groupId: refundGroupId,
                claimVersion,
                allocationCount: allocations.length,
                error,
            });
        }

        const completedAmount = roundPrice(completedAllocations.reduce((sum, allocation) => sum + allocation.amount, 0));
        if (completedAmount > 0) {
            try {
                await applyRefundedPaymentState(db, {
                    orderId: params.orderId,
                    totalAmount: order.totalAmount,
                    currentPaidAmount: order.paidAmount ?? 0,
                    refundAmount: completedAmount,
                    isFullRefund: false,
                    expectedVersion: claimedOrder.version,
                });
                await markRefundAttemptsRefunded(db, completedAllocations);
            } catch (finalizeError: unknown) {
                await markRefundAttemptsReconcileRequired(db, completedAllocations, finalizeError);
                throw new ServiceUnavailableError(
                    `Refund partially processed: ${completedAmount} was accepted by the provider, but local order reconciliation failed. Please review before retrying.`,
                );
            }
            const remainingAmount = roundPrice(refundAmount - completedAmount);
            if (isProviderRefundOutcomeUnknownError(error)) {
                throw new ServiceUnavailableError(
                    `Refund partially processed: ${completedAmount} was accepted by the provider, but ${remainingAmount} has an unknown provider outcome. Do not retry until the pending refund is reconciled.`,
                );
            }
            throw new ServiceUnavailableError(
                `Refund partially processed: ${completedAmount} was accepted by the provider, but ${remainingAmount} could not be completed. Please review before retrying.`,
            );
        }
        if (isProviderRefundOutcomeUnknownError(error)) {
            throw error;
        }
        throw error;
    }

    try {
        const appliedPaymentState = await applyRefundedPaymentState(db, {
            orderId: params.orderId,
            totalAmount: order.totalAmount,
            currentPaidAmount: order.paidAmount ?? 0,
            refundAmount,
            isFullRefund,
            expectedVersion: claimedOrder.version,
        });

        // Determine new order status based on refund type and state machine constraints.
        // Pre-fulfillment full refunds cancel the order and release reservations.
        // Fulfilled/returned full refunds mark payment/order as refunded without
        // restocking physical inventory; returns own that inventory transition.
        const nextOrderStatus = getOrderStatusAfterRefund(order.status, isFullRefund);
        let orderStatusChanged = false;

        if (nextOrderStatus) {
            orderStatusChanged = await updateOrderStatusIfVersionMatches(db, {
                orderId: params.orderId,
                nextStatus: nextOrderStatus,
                expectedVersion: appliedPaymentState.version,
            });

            if (!orderStatusChanged) {
                throw new ConflictError("Refund payment was accepted, but order status reconciliation lost a concurrent update.");
            }
        }

        // 5. Handle inventory on full refund:
        //    - Pre-fulfillment cancellation releases reserved stock.
        //    - Shipped/delivered/completed refunds do NOT auto-restore stock.
        //      Use the explicit return flow when merchandise comes back.
        if (isFullRefund && orderStatusChanged && shouldReleaseInventoryForFullRefund(order.status, nextOrderStatus)) {
            await applyInventoryForStatusChange(db, params.orderId, OrderStatus.CANCELLED);
        }
        await markRefundAttemptsRefunded(db, completedAllocations);
    } catch (finalizeError: unknown) {
        await markRefundAttemptsReconcileRequired(db, completedAllocations, finalizeError);
        throw finalizeError;
    }

    return {
        success: true,
        gateway: resultGateway,
        refundId: completedAllocations.map((allocation) => allocation.refundId).filter(Boolean).join(",") || undefined,
        amount: refundAmount,
        isFullRefund,
    };
}

/**
 * Process an order return.
 *
 * Sets order status to RETURNED and optionally triggers a refund.
 */
export async function processReturn(
    db: Database,
    kv: KVNamespace | undefined,
    params: {
        orderId: string;
        reason: string;
        autoRefund: boolean;
    },
    encryptionKey?: string,
): Promise<{ refundResult?: RefundResult }> {
    // Verify order exists and is in a returnable state (include version for CAS)
    const order = await db
        .select({
            id: orders.id,
            status: orders.status,
            paymentStatus: orders.paymentStatus,
            version: orders.version,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        })
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .get();

    if (!order) {
        throw new NotFoundError(`Order ${params.orderId} not found`);
    }
    assertNoActiveShipmentClaim(order);
    await assertNoActiveRefundAttempt(db, params.orderId);

    const returnableStatuses: string[] = [OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.SHIPPED];
    if (order.status !== OrderStatus.RETURNED && !returnableStatuses.includes(order.status)) {
        throw new ValidationError(
            `Cannot return an order in '${order.status}' status. Order must be delivered, completed, or shipped.`
        );
    }

    // CAS update first: only apply inventory if this request actually owns the
    // RETURNED transition. This prevents orphan stock restoration when a
    // concurrent status change wins the order version race.
    const orderStatusChanged = order.status === OrderStatus.RETURNED
        ? true
        : await updateOrderStatusIfVersionMatches(db, {
            orderId: params.orderId,
            nextStatus: OrderStatus.RETURNED,
            expectedVersion: order.version,
        });

    if (!orderStatusChanged) {
        throw new ConflictError("Order was modified by another request. Please reload and try again.");
    }

    await applyInventoryForStatusChange(db, params.orderId, OrderStatus.RETURNED);

    // Auto-refund if requested and order has payments
    let refundResult: RefundResult | undefined;
    if (params.autoRefund && order.paymentStatus !== PaymentStatus.UNPAID && order.paymentStatus !== PaymentStatus.REFUNDED) {
        refundResult = await processRefund(db, kv, {
            orderId: params.orderId,
            reason: params.reason,
        }, encryptionKey);
    }

    return { refundResult };
}
