// src/modules/payments/refund-service.ts
// Gateway-agnostic refund orchestrator.
// Allocates a refund across the order's captured payments, claims it locally,
// then dispatches each allocation through its gateway adapter (gateways/port.ts).

import { toStoreMinor } from "../settings/store-money";
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
import { COD_PAYMENT_METHOD, getPaymentGateway, isPaymentMethodId } from "./gateways/registry";
import { applyInventoryForStatusChangeWithImpact } from "../inventory/inventory-transitions";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { canTransitionTo } from "../orders/order-state-machine";
import { assertNoActiveShipmentClaim } from "../orders/shipment-claim";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { computeOrderPaymentState } from "./payment-state";
import {
    assertOrderPaymentCurrency,
    resolveOrderCurrencySnapshot,
    type OrderCurrencySnapshot,
} from "./order-currency";
import {
    ACTIVE_REFUND_ATTEMPT_STATUSES,
    REFUND_IN_PROGRESS_MESSAGE,
    assertNoActiveRefundAttempt,
    noActiveRefundAttemptForOrderIdCondition,
} from "./refund-attempt-guard";
import {
    assertNoActivePaymentSessionAttempt,
    noActivePaymentSessionAttemptForOrderIdCondition,
} from "./payment-session-attempts";
import type { OrderNotificationType } from "../notifications/notification-types";
import { readPromotionRefundSnapshot } from "../promotions/promotions.refunds";

export interface RefundRequest {
    orderId: string;
    /** Decimal amount from the HTTP request. If omitted, the full paid amount is refunded. */
    amount?: number;
    reason: string;
    /** Refund only payments captured by this payment method (useful for multi-gateway orders). */
    gateway?: string;
    /** Required when any allocation records an already-completed external COD repayment. */
    manualSettlementConfirmed?: boolean;
    /**
     * One key per refund the merchant means to make (one per dialog opening).
     * Sending it again (double click, retry) returns the first refund instead
     * of refunding twice.
     */
    requestKey?: string;
}

export interface RefundResult {
    success: boolean;
    gateway: string;
    refundId?: string;
    amount: number;
    isFullRefund: boolean;
    /** True when at least one allocation records a confirmed off-platform COD repayment. */
    manualSettlementRecorded?: boolean;
    /** This request key was already used: nothing new was refunded, notified or logged. */
    replayed?: boolean;
    error?: string;
    /** Internal cache signal; API responses must not expose this field. */
    availabilityTransitionVariantIds: string[];
    refundNotification?: {
        notificationType: RefundCompletionNotificationType;
        dedupeKey: string;
        amount: number;
        refundId?: string;
    };
}

export type RefundCompletionNotificationType = Extract<
    OrderNotificationType,
    "order_refunded" | "order_partially_refunded"
>;

export type RefundCustomerNotificationType = Extract<
    OrderNotificationType,
    "refund_processing" | "refund_failed" | "order_refunded" | "order_partially_refunded"
>;

export interface RefundNotificationFact {
    orderId: string;
    notificationType: RefundCustomerNotificationType;
    dedupeKey: string;
    amount: number;
    refundId?: string;
}

type RefundCompletionNotificationFact = RefundNotificationFact & {
    notificationType: RefundCompletionNotificationType;
};

export interface RefundRelatedOrderStatusChange {
    orderId: string;
    previousStatus: string;
    newStatus: string;
    version: number;
}

export class PartialRefundProcessedError extends ServiceUnavailableError {
    readonly affectedOrderIds: string[];
    readonly gateway: string;
    readonly refundNotifications: RefundNotificationFact[];
    readonly statusChange?: RefundRelatedOrderStatusChange;
    readonly availabilityTransitionVariantIds: string[];

    constructor(message: string, options: {
        affectedOrderIds: string[];
        gateway: string;
        refundNotifications: RefundNotificationFact[];
        statusChange?: RefundRelatedOrderStatusChange;
        availabilityTransitionVariantIds?: string[];
    }) {
        super(message);
        this.name = "PartialRefundProcessedError";
        this.affectedOrderIds = options.affectedOrderIds;
        this.gateway = options.gateway;
        this.refundNotifications = options.refundNotifications;
        this.statusChange = options.statusChange;
        this.availabilityTransitionVariantIds =
            options.availabilityTransitionVariantIds ?? [];
    }
}

const REFUND_PROVIDER_DEADLINE_MS = 25_000;
const REFUND_ATTEMPT_LEASE_SECONDS = 5 * 60;
const MAX_REFUND_ATTEMPT_ERROR_LENGTH = 500;
const PRE_FULFILLMENT_REFUND_STATUSES = new Set<string>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
]);

type CapturedPayment = OrderPayment;

interface RefundAllocation {
    id: string;
    sourcePayment: CapturedPayment;
    amountMinor: number;
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

/** Attempt keys of a merchant refund request: unique, so the same request can't claim twice. */
function refundRequestAttemptKeyPrefix(orderId: string, requestKey: string): string {
    return `refund_request:${orderId}:${requestKey}:`;
}

/**
 * The refund an earlier call with this request key made, if any. The same key
 * for a different amount is refused rather than silently ignored.
 */
async function findRefundRequestReplay(
    db: Database,
    params: RefundRequest & { requestKey: string },
    order: { paymentStatus: string },
    currency: { code: string; decimalPlaces: number },
): Promise<RefundResult | null> {
    const prefix = refundRequestAttemptKeyPrefix(params.orderId, params.requestKey);
    const rows = await db.select({
        gateway: refundAttempts.gateway,
        amountMinor: refundAttempts.amountMinor,
        status: refundAttempts.status,
        providerRefundId: refundAttempts.providerRefundId,
        lastError: refundAttempts.lastError,
    }).from(refundAttempts).where(and(
        eq(refundAttempts.orderId, params.orderId),
        sql`substr(${refundAttempts.attemptKey}, 1, ${prefix.length}) = ${prefix}`,
    )).all();
    if (rows.length === 0) return null;
    const amountMinor = rows.reduce((sum, row) => sum + row.amountMinor, 0);
    if (params.amount !== undefined && toMinor(params.amount, currency.decimalPlaces) !== amountMinor) {
        throw new ConflictError("This refund request was already used for a different amount. Reload and try again.");
    }
    if (rows.some((row) => ACTIVE_REFUND_ATTEMPT_STATUSES.includes(row.status as never))) {
        throw new ConflictError(REFUND_IN_PROGRESS_MESSAGE);
    }
    const failed = rows.find((row) => row.status === "failed");
    return {
        success: !failed,
        ...(failed ? { error: failed.lastError ?? "Refund processing failed" } : {}),
        gateway: rows[0]!.gateway,
        refundId: rows.map((row) => row.providerRefundId).filter(Boolean).join(",") || undefined,
        amount: fromMinor(amountMinor, currency.decimalPlaces),
        isFullRefund: order.paymentStatus === PaymentStatus.REFUNDED,
        manualSettlementRecorded: rows.some((row) => row.gateway === COD_PAYMENT_METHOD),
        availabilityTransitionVariantIds: [],
        replayed: true,
    };
}

function normalizePaymentGateway(value: string): string {
    if (isPaymentMethodId(value)) return value;
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

function buildFullRefundNotificationDedupeKey(orderId: string, refundGroupId: string): string {
    return `refund:${orderId}:${refundGroupId}:full`;
}

function buildPartialRefundNotificationDedupeKey(orderId: string, refundGroupId: string): string {
    return `refund:${orderId}:${refundGroupId}:partial`;
}

function buildRefundStateNotificationDedupeKey(
    orderId: string,
    refundGroupId: string,
    state: "processing" | "failed",
): string {
    return `refund:${orderId}:${refundGroupId}:${state}`;
}

function buildReconciledRefundNotificationDedupeKey(
    orderId: string,
    attemptIds: string[],
    isFullRefund: boolean,
): string {
    return `refund-reconcile:${orderId}:${[...attemptIds].sort().join(",")}:${isFullRefund ? "full" : "partial"}`;
}

function computeRefundedBySourcePayment(
    capturedPayments: CapturedPayment[],
    refundRows: Array<Pick<OrderPayment, "amountMinor" | "metadata">>,
): Map<string, number> {
    const refundedBySource = new Map<string, number>();
    let unattributedRefundAmount = 0;

    for (const refund of refundRows) {
        const amount = Math.max(0, refund.amountMinor);
        if (amount <= 0) continue;

        const sourcePaymentId = getRefundSourcePaymentId(refund);
        if (sourcePaymentId) {
            refundedBySource.set(sourcePaymentId, (refundedBySource.get(sourcePaymentId) ?? 0) + amount);
        } else {
            unattributedRefundAmount += amount;
        }
    }

    // Older refund rows did not store sourcePaymentId. Attribute those refunds
    // against newest captures first, matching the old "latest payment" behavior,
    // so future allocations cannot over-refund an order that has old history.
    for (const payment of capturedPayments) {
        if (unattributedRefundAmount <= 0) break;
        const alreadyRefunded = refundedBySource.get(payment.id) ?? 0;
        const remainingPaymentAmount = Math.max(0, payment.amountMinor - alreadyRefunded);
        const applied = Math.min(remainingPaymentAmount, unattributedRefundAmount);
        if (applied > 0) {
            refundedBySource.set(payment.id, alreadyRefunded + applied);
            unattributedRefundAmount -= applied;
        }
    }

    return refundedBySource;
}

function buildRefundAllocations(params: {
    orderId: string;
    claimVersion: number;
    refundAmountMinor: number;
    capturedPayments: CapturedPayment[];
    refundRows: Array<Pick<OrderPayment, "amountMinor" | "metadata">>;
    currency: OrderCurrencySnapshot;
}): RefundAllocation[] {
    const refundedBySource = computeRefundedBySourcePayment(
        params.capturedPayments,
        params.refundRows,
    );
    let remainingRefundAmount = params.refundAmountMinor;
    const allocations: RefundAllocation[] = [];

    for (const sourcePayment of params.capturedPayments) {
        if (remainingRefundAmount <= 0) break;
        const alreadyRefunded = refundedBySource.get(sourcePayment.id) ?? 0;
        const refundableAmount = Math.max(0, sourcePayment.amountMinor - alreadyRefunded);
        if (refundableAmount <= 0) continue;

        const amountMinor = Math.min(refundableAmount, remainingRefundAmount);
        const index = allocations.length;
        allocations.push({
            id: getRefundClaimId(params.orderId, params.claimVersion - 1, index),
            sourcePayment,
            amountMinor,
            idempotencyKey: buildRefundIdempotencyKey(params.orderId, sourcePayment.id, params.claimVersion),
            refundReference: buildRefundReference(params.orderId, sourcePayment.id, params.claimVersion, index),
            index,
        });
        remainingRefundAmount -= amountMinor;
    }

    if (remainingRefundAmount > 0) {
        throw new ValidationError("Refund amount exceeds refundable captured payment balance", {
            requestedAmount: fromMinor(params.refundAmountMinor, params.currency.decimalPlaces),
            remainingUnallocatedAmount: fromMinor(remainingRefundAmount, params.currency.decimalPlaces),
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
    refundAmountMinor: number;
    currency: string;
    allocations: RefundAllocation[];
}): Promise<string> {
    return sha256Hex(stableStringify({
        orderId: params.request.orderId,
        amountMinor: params.refundAmountMinor,
        reason: params.request.reason,
        gateway: params.request.gateway ?? null,
        manualSettlementConfirmed: params.request.manualSettlementConfirmed === true,
        currency: params.currency,
        allocations: params.allocations.map((allocation) => ({
            sourcePaymentId: allocation.sourcePayment.id,
            amountMinor: allocation.amountMinor,
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

/** A partial refund is a payment fact only; the order keeps its lifecycle status. */
function getOrderStatusAfterRefund(currentStatus: string, isFullRefund: boolean): string | undefined {
    if (!isFullRefund) return undefined;

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

export interface FinalizeAcceptedRefundAttemptsResult {
    orderIds: string[];
    finalizedAttemptIds: string[];
    refundNotifications: RefundNotificationFact[];
    availabilityTransitionVariantIds: string[];
}

function isCapturedPaymentRow(payment: Pick<OrderPayment, "paymentType" | "status">): boolean {
    return payment.paymentType !== "refund" && payment.status === PaymentRecordStatus.SUCCEEDED;
}

function isRefundedPaymentRow(payment: Pick<OrderPayment, "paymentType" | "status">): boolean {
    return payment.paymentType === "refund" && payment.status === PaymentRecordStatus.REFUNDED;
}

function computePaymentStateFromLedger(params: {
    totalAmountMinor: number;
    payments: Array<Pick<OrderPayment, "paymentType" | "status" | "amountMinor">>;
}) {
    const capturedAmount = params.payments
        .filter(isCapturedPaymentRow)
        .reduce((sum, payment) => sum + payment.amountMinor, 0);
    const refundedAmount = params.payments
        .filter(isRefundedPaymentRow)
        .reduce((sum, payment) => sum + payment.amountMinor, 0);
    const isFullRefund = capturedAmount > 0 && refundedAmount >= capturedAmount;

    // Money given back from a fully paid order never turns into money owed:
    // the customer has no balance due and the payment reads "(partially)
    // refunded". "Partly paid" stays reserved for a real under-payment.
    if (isFullRefund) {
        return {
            isFullRefund,
            paidAmountMinor: 0,
            balanceDueMinor: 0,
            paymentStatus: PaymentStatus.REFUNDED,
        };
    }
    if (refundedAmount > 0 && capturedAmount >= params.totalAmountMinor) {
        return {
            isFullRefund,
            paidAmountMinor: capturedAmount - refundedAmount,
            balanceDueMinor: 0,
            paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
        };
    }

    return {
        isFullRefund,
        ...computeOrderPaymentState({
            totalAmountMinor: params.totalAmountMinor,
            paidAmountMinor: capturedAmount - refundedAmount,
        }),
    };
}

export async function finalizeAcceptedRefundAttemptIds(
    db: Database,
    attemptIds: string[],
): Promise<FinalizeAcceptedRefundAttemptsResult> {
    const uniqueAttemptIds = [...new Set(attemptIds.filter(Boolean))];
    if (uniqueAttemptIds.length === 0) {
        return {
            orderIds: [],
            finalizedAttemptIds: [],
            refundNotifications: [],
            availabilityTransitionVariantIds: [],
        };
    }

    const attempts = await db
        .select({
            id: refundAttempts.id,
            orderId: refundAttempts.orderId,
            refundPaymentId: refundAttempts.refundPaymentId,
            providerRefundId: refundAttempts.providerRefundId,
            amountMinor: refundAttempts.amountMinor,
            currency: refundAttempts.currency,
        })
        .from(refundAttempts)
        .where(inArray(refundAttempts.id, uniqueAttemptIds));

    if (attempts.length !== uniqueAttemptIds.length) {
        throw new NotFoundError("One or more refund attempts could not be found for reconciliation.");
    }

    const refundPaymentIds = attempts.map((attempt) => attempt.refundPaymentId);
    const refundPaymentIdSet = new Set(refundPaymentIds);
    const reconciliationByOrder = new Map<string, {
        order: {
            id: string;
            totalAmountMinor: number;
            status: string;
            version: number;
            currencyCode: string;
            currencyDecimalPlaces: number;
        };
        currency: OrderCurrencySnapshot;
        paymentRows: Array<Pick<OrderPayment, "paymentType" | "status" | "amountMinor">>;
    }>();

    // Validate every immutable order/payment currency before mutating refund rows.
    for (const orderId of new Set(attempts.map((attempt) => attempt.orderId))) {
        const order = await db
            .select({
                id: orders.id,
                totalAmountMinor: orders.totalAmountMinor,
                status: orders.status,
                version: orders.version,
                currencyCode: orders.currencyCode,
                currencyDecimalPlaces: orders.currencyDecimalPlaces,
            })
            .from(orders)
            .where(eq(orders.id, orderId))
            .get();
        if (!order) {
            throw new NotFoundError(`Order ${orderId} not found while reconciling refund attempts.`);
        }
        const currency = resolveOrderCurrencySnapshot(order);
        const orderAttempts = attempts.filter((attempt) => attempt.orderId === orderId);
        for (const attempt of orderAttempts) {
            assertOrderPaymentCurrency(attempt.currency, currency, "Refund attempt");
        }

        const ledgerRows = await db
            .select({
                id: orderPayments.id,
                paymentType: orderPayments.paymentType,
                status: orderPayments.status,
                amountMinor: orderPayments.amountMinor,
                currency: orderPayments.currency,
            })
            .from(orderPayments)
            .where(eq(orderPayments.orderId, orderId));
        for (const payment of ledgerRows) {
            assertOrderPaymentCurrency(payment.currency, currency, "Order payment ledger");
        }
        reconciliationByOrder.set(orderId, {
            order,
            currency,
            paymentRows: ledgerRows.map((payment) => ({
                paymentType: payment.paymentType,
                status: refundPaymentIdSet.has(payment.id)
                    ? PaymentRecordStatus.REFUNDED
                    : payment.status,
                amountMinor: payment.amountMinor,
            })),
        });
    }

    await db.update(orderPayments).set({
        status: PaymentRecordStatus.REFUNDED,
        updatedAt: sql`unixepoch()`,
    }).where(inArray(orderPayments.id, refundPaymentIds));

    const finalizedOrderIds = new Set<string>();
    const finalizedAttemptIds: string[] = [];
    const refundNotifications: RefundNotificationFact[] = [];
    const availabilityTransitionVariantIds = new Set<string>();

    for (const orderId of new Set(attempts.map((attempt) => attempt.orderId))) {
        const orderAttempts = attempts.filter((attempt) => attempt.orderId === orderId);
        const reconciliation = reconciliationByOrder.get(orderId)!;
        const { order, currency, paymentRows } = reconciliation;

        const paymentState = computePaymentStateFromLedger({
            totalAmountMinor: order.totalAmountMinor,
            payments: paymentRows,
        });
        const nextOrderStatus = getOrderStatusAfterRefund(order.status, paymentState.isFullRefund);
        const shouldReleaseInventory =
            paymentState.isFullRefund &&
            (nextOrderStatus === OrderStatus.CANCELLED || order.status === OrderStatus.CANCELLED);

        const updateResult = await db.update(orders).set({
            paidAmountMinor: paymentState.paidAmountMinor,
            balanceDueMinor: paymentState.balanceDueMinor,
            paymentStatus: paymentState.paymentStatus,
            ...(nextOrderStatus ? { status: nextOrderStatus } : {}),
            version: sql`${orders.version} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, orderId),
            eq(orders.version, order.version),
        )).returning({ id: orders.id });

        if (updateResult.length === 0) {
            throw new ConflictError("Refund settlement was recorded, but local order reconciliation lost a concurrent update.");
        }

        if (shouldReleaseInventory) {
            const impact = await applyInventoryForStatusChangeWithImpact(
                db,
                orderId,
                OrderStatus.CANCELLED,
            );
            for (const variantId of impact.availabilityTransitionVariantIds) {
                availabilityTransitionVariantIds.add(variantId);
            }
        }

        finalizedOrderIds.add(orderId);
        const notificationAttemptIds = orderAttempts.map((attempt) => attempt.id);
        const notificationRefundIds = orderAttempts
            .map((attempt) => attempt.providerRefundId)
            .filter((refundId): refundId is string => Boolean(refundId));
        refundNotifications.push({
            orderId,
            notificationType: paymentState.isFullRefund ? "order_refunded" : "order_partially_refunded",
            dedupeKey: buildReconciledRefundNotificationDedupeKey(
                orderId,
                notificationAttemptIds,
                paymentState.isFullRefund,
            ),
            amount: fromMinor(
                orderAttempts.reduce((sum, attempt) => sum + attempt.amountMinor, 0),
                currency.decimalPlaces,
            ),
            refundId: notificationRefundIds.join(",") || undefined,
        });
    }

    await db.update(refundAttempts).set({
        status: "refunded",
        claimId: null,
        claimExpiresAt: null,
        refundedAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    }).where(inArray(refundAttempts.id, uniqueAttemptIds));
    finalizedAttemptIds.push(...uniqueAttemptIds);

    return {
        orderIds: [...finalizedOrderIds],
        finalizedAttemptIds,
        refundNotifications,
        availabilityTransitionVariantIds: [...availabilityTransitionVariantIds],
    };
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
    const isManualSettlement = params.allocation.sourcePayment.paymentMethod === COD_PAYMENT_METHOD;

    return JSON.stringify({
        reason: params.request.reason,
        gateway: params.allocation.sourcePayment.paymentMethod,
        sourcePaymentId: params.allocation.sourcePayment.id,
        sourcePaymentType: params.allocation.sourcePayment.paymentType,
        sourceTransactionId: getRefundAttemptSourceTransactionId(params.allocation),
        refundGroupId: params.groupId,
        allocationIndex: params.allocation.index,
        allocationCount: params.allocationCount,
        providerIdempotencyKey: params.allocation.idempotencyKey,
        refundReference: params.allocation.refundReference,
        claimVersion: params.claimVersion,
        ...(isManualSettlement ? {
            settlementMode: "manual_external",
            manualSettlementConfirmed: params.request.manualSettlementConfirmed === true,
            manualSettlementOutcome: params.status === "refunded" ? "confirmed" : params.status,
        } : {
            providerOutcome: params.providerOutcome ?? (
                params.status === "refunded"
                    ? "accepted"
                    : params.status === "failed"
                        ? "rejected"
                        : "not_dispatched"
            ),
        }),
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
    const isManualSettlement = params.allocation.sourcePayment.paymentMethod === COD_PAYMENT_METHOD;
    return JSON.stringify({
        reason: params.request.reason,
        gateway: params.allocation.sourcePayment.paymentMethod,
        ...(isManualSettlement ? {
            settlementMode: "manual_external",
            manualSettlementConfirmed: params.request.manualSettlementConfirmed === true,
        } : {}),
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
    const requestKey = params.request.requestKey?.trim();
    return {
        id: getRefundAttemptId(params.allocation),
        attemptKey: requestKey
            ? `${refundRequestAttemptKeyPrefix(params.request.orderId, requestKey)}${params.allocation.index}`
            : getRefundAttemptKey(params.allocation),
        refundGroupId: params.groupId,
        orderId: params.request.orderId,
        sourcePaymentId: params.allocation.sourcePayment.id,
        refundPaymentId: params.allocation.id,
        gateway: params.allocation.sourcePayment.paymentMethod,
        amountMinor: params.allocation.amountMinor,
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
    if (allocation.sourcePayment.paymentMethod === COD_PAYMENT_METHOD) return null;
    return allocation.sourcePayment.providerSecondaryRef ?? allocation.sourcePayment.providerRef ?? null;
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

async function markRefundAttemptAccepted(
    db: Database,
    allocation: CompletedRefundAllocation,
): Promise<void> {
    const isManualSettlement = allocation.sourcePayment.paymentMethod === COD_PAYMENT_METHOD;
    await db.update(refundAttempts).set({
        status: "processing",
        providerRefundId: allocation.refundId ?? null,
        providerStatus: isManualSettlement ? "manual_confirmed" : "accepted",
        responsePayload: isManualSettlement
            ? JSON.stringify({ settlementMode: "manual_external" })
            : JSON.stringify({ refundId: allocation.refundId ?? null }),
        updatedAt: sql`unixepoch()`,
    }).where(eq(refundAttempts.id, getRefundAttemptId(allocation)));
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
            providerStatus: allocation.sourcePayment.paymentMethod === COD_PAYMENT_METHOD
                ? "manual_confirmed"
                : "accepted",
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

// ---------------------------------------------------------------------------
// Refund dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch one refund allocation through its gateway adapter and return the
 * provider refund id. COD has no provider: the caller has already confirmed
 * the external repayment. Failures before the provider call (configuration,
 * missing references) are terminal; once the call starts, any error is an
 * unknown outcome that reconciliation must resolve.
 */
async function dispatchRefund(
    db: Database,
    payment: CapturedPayment,
    refundAmountMinor: number,
    currency: OrderCurrencySnapshot,
    params: RefundRequest,
    providerMetadata: { idempotencyKey: string; refundReference: string } & Record<string, string>,
    encryptionKey?: string,
): Promise<string | undefined> {
    if (payment.paymentMethod === COD_PAYMENT_METHOD) return undefined;
    const gateway = getPaymentGateway(payment.paymentMethod);
    if (!gateway?.refund) throw new ValidationError(`Unsupported refund gateway: ${payment.paymentMethod}`);
    const settings = await gateway.loadSettings(db, encryptionKey);
    if (!settings) throw new ServiceUnavailableError(`${gateway.label} is not configured`);
    if (!settings.enabled) throw new ServiceUnavailableError(`${gateway.label} payment gateway is disabled`);
    if (settings.credentialErrors?.length) throw new ServiceUnavailableError(`${gateway.label} credentials are not readable`);
    if (!payment.providerRef) throw new ValidationError(`No ${gateway.label} payment reference found on payment record`);
    if (!Number.isSafeInteger(refundAmountMinor) || refundAmountMinor <= 0) {
        throw new ValidationError(`${gateway.label} refund must resolve to a positive provider amount.`);
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            gateway.refund(settings, {
                providerRef: payment.providerRef,
                secondaryRef: payment.providerSecondaryRef,
                amountMinor: refundAmountMinor,
                currency: currency.code,
                reason: params.reason,
                idempotencyKey: providerMetadata.idempotencyKey,
                reference: providerMetadata.refundReference,
                metadata: providerMetadata,
            }),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error(`Refund provider did not settle within ${REFUND_PROVIDER_DEADLINE_MS}ms`));
                }, REFUND_PROVIDER_DEADLINE_MS);
            }),
        ]);
        return result.refundId;
    } catch (error: unknown) {
        // Adapters validate their inputs before any network call.
        if (error instanceof ValidationError) throw error;
        throw new ProviderRefundOutcomeUnknownError(error);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function getCompletedRefundIds(allocations: CompletedRefundAllocation[]): string | undefined {
    return allocations.map((allocation) => allocation.refundId).filter(Boolean).join(",") || undefined;
}

function buildDirectRefundNotificationFact(params: {
    orderId: string;
    refundGroupId: string;
    amountMinor: number;
    isFullRefund: boolean;
    refundId?: string;
    currency: OrderCurrencySnapshot;
}): RefundCompletionNotificationFact {
    return {
        orderId: params.orderId,
        notificationType: params.isFullRefund ? "order_refunded" : "order_partially_refunded",
        dedupeKey: params.isFullRefund
            ? buildFullRefundNotificationDedupeKey(params.orderId, params.refundGroupId)
            : buildPartialRefundNotificationDedupeKey(params.orderId, params.refundGroupId),
        amount: fromMinor(params.amountMinor, params.currency.decimalPlaces),
        refundId: params.refundId,
    };
}

function buildRefundStateNotificationFact(params: {
    orderId: string;
    refundGroupId: string;
    notificationType: Extract<RefundCustomerNotificationType, "refund_processing" | "refund_failed">;
    amountMinor: number;
    currency: OrderCurrencySnapshot;
}): RefundNotificationFact {
    const state = params.notificationType === "refund_processing" ? "processing" : "failed";
    return {
        orderId: params.orderId,
        notificationType: params.notificationType,
        dedupeKey: buildRefundStateNotificationDedupeKey(params.orderId, params.refundGroupId, state),
        amount: fromMinor(params.amountMinor, params.currency.decimalPlaces),
    };
}

/**
 * Process a refund for an order.
 *
 * 1. Finds the payment record (or uses specified gateway)
 * 2. Claims refund capacity locally before provider dispatch
 * 3. Dispatches each allocation through its gateway adapter
 * 4. Finalizes order payment status
 * 5. Releases inventory on full refund
 */
export async function processRefund(
    db: Database,
    params: RefundRequest,
    encryptionKey?: string,
): Promise<RefundResult> {
    // 1. Fetch order (include version for CAS to prevent concurrent refund races)
    const order = await db
        .select({
            id: orders.id,
            paidAmountMinor: orders.paidAmountMinor,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            version: orders.version,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            discountAmountMinor: orders.discountAmountMinor,
        })
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .get();

    if (!order) {
        throw new NotFoundError(`Order ${params.orderId} not found`);
    }
    const currency = resolveOrderCurrencySnapshot(order);
    const requestKey = params.requestKey?.trim();
    if (requestKey) {
        const replay = await findRefundRequestReplay(db, { ...params, requestKey }, order, currency);
        if (replay) return replay;
    }
    if (order.discountAmountMinor > 0) {
        await readPromotionRefundSnapshot(db, {
            orderId: order.id,
            currencyCode: currency.code,
            orderDiscountAmountMinor: order.discountAmountMinor,
        });
    }
    assertNoActiveShipmentClaim(order);
    await assertNoActivePaymentSessionAttempt(db, params.orderId);
    await assertNoActiveRefundAttempt(db, params.orderId, { message: REFUND_IN_PROGRESS_MESSAGE });

    // Validate the complete ledger before any local mutation or provider call.
    // A wrong-currency failed/pending row would otherwise surface only during
    // finalization, after inventory repair or an external refund was accepted.
    const paymentLedgerRows = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, params.orderId))
        .orderBy(desc(orderPayments.createdAt));
    for (const payment of paymentLedgerRows) {
        assertOrderPaymentCurrency(payment.currency, currency, "Order payment ledger");
    }

    if (order.paymentStatus === PaymentStatus.UNPAID || order.paymentStatus === PaymentStatus.FAILED) {
        throw new ValidationError("Order has no payments to refund");
    }

    if (
        order.paymentStatus === PaymentStatus.REFUNDED &&
        order.status === OrderStatus.CANCELLED &&
        order.inventoryAction !== "deducted"
    ) {
        const impact = await applyInventoryForStatusChangeWithImpact(
            db,
            params.orderId,
            OrderStatus.CANCELLED,
        );
        return {
            success: true,
            gateway: params.gateway ?? order.paymentMethod,
            amount: 0,
            isFullRefund: true,
            availabilityTransitionVariantIds:
                impact.availabilityTransitionVariantIds,
        };
    }

    if (order.paymentStatus === PaymentStatus.REFUNDED) {
        throw new ConflictError("Order is already fully refunded");
    }

    // Determine and validate refund amount before any gateway calls
    const paidAmount = order.paidAmountMinor;
    if (params.amount !== undefined && (!Number.isFinite(params.amount) || params.amount <= 0)) {
        throw new ValidationError("Refund amount must be greater than zero");
    }
    const refundAmount = params.amount === undefined
        ? paidAmount
        : toStoreMinor(params.amount, currency);

    if (refundAmount <= 0) {
        throw new ValidationError("Refund amount must be greater than zero");
    }

    if (refundAmount > paidAmount) {
        const display = (minor: number) => fromMinor(minor, currency.decimalPlaces);
        throw new ValidationError(
            `Refund amount (${display(refundAmount)}) exceeds paid amount (${display(paidAmount)})`
        );
    }

    const isFullRefund = refundAmount >= paidAmount;

    const capturedPayments = paymentLedgerRows
        .filter((payment) =>
            payment.paymentType !== "refund" &&
            payment.status === PaymentRecordStatus.SUCCEEDED
        )
        .map((payment) => ({
            ...payment,
            paymentMethod: normalizePaymentGateway(payment.paymentMethod),
        }))
        .filter((payment) => !params.gateway || payment.paymentMethod === params.gateway);

    if (capturedPayments.length === 0) {
        throw new NotFoundError("No payment record found for this order");
    }

    const priorRefundRows = paymentLedgerRows.filter((payment) =>
        payment.paymentType === "refund" &&
        payment.status === PaymentRecordStatus.REFUNDED
    );

    const claimVersion = order.version + 1;
    const refundGroupId = getRefundClaimBaseId(params.orderId, order.version);
    const allocations = buildRefundAllocations({
        orderId: params.orderId,
        claimVersion,
        refundAmountMinor: refundAmount,
        capturedPayments,
        refundRows: priorRefundRows,
        currency,
    });
    const hasManualCodAllocation = allocations.some(
        (allocation) => allocation.sourcePayment.paymentMethod === COD_PAYMENT_METHOD,
    );
    if (hasManualCodAllocation && params.manualSettlementConfirmed !== true) {
        throw new ValidationError(
            "Confirm that the customer has already received the manual COD refund before recording it.",
        );
    }
    const refundRequestHash = await buildRefundRequestHash({
        request: params,
        refundAmountMinor: refundAmount,
        currency: currency.code,
        allocations,
    });
    const resultGateway = getResultGateway(allocations);

    // 3. Claim refund capacity locally before calling the gateway. The deterministic
    // refund allocation IDs and order-version CAS ensure that concurrent callers
    // cannot both pass this point and hit external providers.
    let claimResults: [Array<{ id: string; version: number }>, ...unknown[]];
    try {
        claimResults = await db.batch([
            // The guarded order claim must execute before this transaction creates
            // its own active refund rows. D1 batches are sequential: placing this
            // statement after the inserts makes the no-active-refund predicate see
            // and reject the claim's own rows.
            db.update(orders).set({
                version: claimVersion,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orders.id, params.orderId),
                eq(orders.version, order.version),
                sql`${orders.paidAmountMinor} >= ${refundAmount}`,
                noActiveRefundAttemptForOrderIdCondition(params.orderId),
                noActivePaymentSessionAttemptForOrderIdCondition(params.orderId),
            )).returning({ id: orders.id, version: orders.version }),
            ...allocations.flatMap((allocation) => [
                db.insert(orderPayments).values({
                    id: allocation.id,
                    orderId: params.orderId,
                    amountMinor: allocation.amountMinor,
                    currency: currency.code,
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
                    currency: currency.code,
                })),
            ]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        ] as any) as any;
    } catch (error: unknown) {
        if (isConstraintError(error)) {
            // The same request key raced in from a second click.
            const replay = requestKey
                ? await findRefundRequestReplay(db, { ...params, requestKey }, order, currency)
                : null;
            if (replay) return replay;
            throw new ConflictError(REFUND_IN_PROGRESS_MESSAGE);
        }
        throw error;
    }

    const claimedOrderResult = claimResults[0];
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
                allocation.sourcePayment,
                allocation.amountMinor,
                currency,
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
                // Refund rows never copy the source provider_ref: UNIQUE(provider,
                // provider_ref) identifies captures. The refund id lives in metadata.
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
            await markRefundAttemptAccepted(db, completedAllocation);
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

        const completedAmount = completedAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
        const display = (minor: number) => fromMinor(minor, currency.decimalPlaces);
        if (completedAmount > 0) {
            let finalizedResult: FinalizeAcceptedRefundAttemptsResult;
            try {
                finalizedResult = await finalizeAcceptedRefundAttemptIds(
                    db,
                    completedAllocations.map((allocation) => getRefundAttemptId(allocation)),
                );
            } catch (finalizeError: unknown) {
                await markRefundAttemptsReconcileRequired(db, completedAllocations, finalizeError);
                throw new ServiceUnavailableError(
                    `Refund partially processed: ${display(completedAmount)} was completed, but local order reconciliation failed. Please review before retrying.`,
                );
            }
            const remainingAmount = refundAmount - completedAmount;
            const affectedOrderIds = finalizedResult.orderIds.length > 0
                ? finalizedResult.orderIds
                : [params.orderId];
            const refundNotifications: RefundNotificationFact[] = [...finalizedResult.refundNotifications];
            if (isProviderRefundOutcomeUnknownError(error)) {
                if (remainingAmount > 0) {
                    refundNotifications.push(buildRefundStateNotificationFact({
                        orderId: params.orderId,
                        refundGroupId,
                        notificationType: "refund_processing",
                        amountMinor: remainingAmount,
                        currency,
                    }));
                }
                throw new PartialRefundProcessedError(
                    `Refund partially processed: ${display(completedAmount)} was completed, but ${display(remainingAmount)} has an unknown provider outcome. Do not retry until the pending refund is reconciled.`,
                    {
                        affectedOrderIds,
                        gateway: resultGateway,
                        refundNotifications,
                        availabilityTransitionVariantIds:
                            finalizedResult.availabilityTransitionVariantIds,
                    },
                );
            }
            if (remainingAmount > 0) {
                refundNotifications.push(buildRefundStateNotificationFact({
                    orderId: params.orderId,
                    refundGroupId,
                    notificationType: "refund_failed",
                    amountMinor: remainingAmount,
                    currency,
                }));
            }
            throw new PartialRefundProcessedError(
                `Refund partially processed: ${display(completedAmount)} was completed, but ${display(remainingAmount)} could not be completed. Please review before retrying.`,
                {
                    affectedOrderIds,
                    gateway: resultGateway,
                    refundNotifications,
                    availabilityTransitionVariantIds:
                        finalizedResult.availabilityTransitionVariantIds,
                },
            );
        }
        if (isProviderRefundOutcomeUnknownError(error)) {
            throw error;
        }
        throw error;
    }

    let availabilityTransitionVariantIds: string[];
    try {
        const finalizedResult = await finalizeAcceptedRefundAttemptIds(
            db,
            completedAllocations.map((allocation) => getRefundAttemptId(allocation)),
        );
        availabilityTransitionVariantIds =
            finalizedResult.availabilityTransitionVariantIds;
    } catch (finalizeError: unknown) {
        await markRefundAttemptsReconcileRequired(db, completedAllocations, finalizeError);
        throw finalizeError;
    }

    const refundNotification = buildDirectRefundNotificationFact({
        orderId: params.orderId,
        refundGroupId,
        amountMinor: refundAmount,
        isFullRefund,
        refundId: getCompletedRefundIds(completedAllocations),
        currency,
    });

    return {
        success: true,
        gateway: resultGateway,
        refundId: getCompletedRefundIds(completedAllocations),
        amount: fromMinor(refundAmount, currency.decimalPlaces),
        isFullRefund,
        manualSettlementRecorded: hasManualCodAllocation,
        availabilityTransitionVariantIds,
        refundNotification: {
            notificationType: refundNotification.notificationType,
            dedupeKey: refundNotification.dedupeKey,
            amount: refundNotification.amount,
            refundId: refundNotification.refundId,
        },
    };
}
