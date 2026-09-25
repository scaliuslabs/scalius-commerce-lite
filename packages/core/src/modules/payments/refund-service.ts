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
    giftCards,
    PaymentStatus,
    OrderStatus,
    PaymentRecordStatus,
    type OrderPayment,
} from "@scalius/database/schema";
import { COD_PAYMENT_METHOD, getPaymentGateway, isPaymentMethodId } from "./gateways/registry";
import { applyInventoryForStatusChangeWithImpact } from "../inventory/inventory-transitions";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import { canTransitionTo } from "../orders/status/state-machine";
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
import { buildNotificationOutboxInsert } from "../notifications/notification-outbox";
import { readPromotionRefundSnapshot } from "../promotions/promotions.refunds";
import { readGiftCardSettings } from "../settings/documents";
import {
    GIFT_CARD_PAYMENT_METHOD,
    buildGiftCardRefundStatement,
    buildStoreCreditGiftCardStatements,
    deriveGiftCardKeys,
    giftCardExpiryFromMonths,
    giftCardIdsForTenderPayments,
    normalizeGiftCardRecipient,
} from "../gift-cards";
import { buildBatchGuard, isBatchGuardError } from "@scalius/database/client";

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
    /**
     * Where the money goes: back to the payments it came from (default), or
     * one new gift card for the whole amount ("store credit"), with no
     * provider call and no cash changing hands.
     */
    settlement?: RefundSettlement;
    /** The staff member recording the refund (gift-card ledger actor). */
    actorUserId?: string | null;
}

export const REFUND_SETTLEMENTS = ["original", "store_credit"] as const;
export type RefundSettlement = (typeof REFUND_SETTLEMENTS)[number];

/** The store-credit card a refund issued (never its code). */
export interface RefundStoreCredit {
    giftCardId: string;
    last4: string;
    /** Decimal major units of the order currency. */
    amount: number;
    amountMinor: number;
    /** Internal: the `gift_card_issued` outbox row to hand to the queue. API responses omit it. */
    notificationOutboxId?: string;
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
    settlement?: RefundSettlement;
    /** Set when the refund was issued as store credit. */
    storeCredit?: RefundStoreCredit;
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

/**
 * How one allocation is settled. `provider` dispatches through the gateway
 * after the claim; `manual_external` records a COD repayment staff already
 * made. `gift_card` (credit back to the tender's card) and `store_credit`
 * (one new card for the refund) are internal: the claim batch itself moves
 * the money, so they never call a provider and never wait on one.
 */
type RefundSettlementMode = "provider" | "manual_external" | "gift_card" | "store_credit";

interface RefundAllocation {
    id: string;
    sourcePayment: CapturedPayment;
    amountMinor: number;
    idempotencyKey: string;
    refundReference: string;
    index: number;
    settlementMode?: RefundSettlementMode;
    /** gift_card: the card the tender debited. store_credit: the new card. */
    giftCardId?: string;
}

/** Provider status of internally settled attempts; reconciliation finalizes them as accepted. */
export const INTERNAL_REFUND_PROVIDER_STATUSES = {
    gift_card: "gift_card_credited",
    store_credit: "store_credit_issued",
} as const;

export function isInternalRefundProviderStatus(value: string | null | undefined): boolean {
    return value === INTERNAL_REFUND_PROVIDER_STATUSES.gift_card
        || value === INTERNAL_REFUND_PROVIDER_STATUSES.store_credit;
}

function allocationSettlementMode(allocation: Pick<RefundAllocation, "settlementMode" | "sourcePayment">): RefundSettlementMode {
    if (allocation.settlementMode) return allocation.settlementMode;
    if (allocation.sourcePayment.paymentMethod === GIFT_CARD_PAYMENT_METHOD) return "gift_card";
    return allocation.sourcePayment.paymentMethod === COD_PAYMENT_METHOD ? "manual_external" : "provider";
}

function isInternalSettlement(mode: RefundSettlementMode): mode is "gift_card" | "store_credit" {
    return mode === "gift_card" || mode === "store_credit";
}

function acceptedProviderStatus(allocation: Pick<RefundAllocation, "settlementMode" | "sourcePayment">): string {
    const mode = allocationSettlementMode(allocation);
    if (isInternalSettlement(mode)) return INTERNAL_REFUND_PROVIDER_STATUSES[mode];
    return mode === "manual_external" ? "manual_confirmed" : "accepted";
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
        id: refundAttempts.id,
        gateway: refundAttempts.gateway,
        amountMinor: refundAttempts.amountMinor,
        status: refundAttempts.status,
        providerRefundId: refundAttempts.providerRefundId,
        lastError: refundAttempts.lastError,
        metadata: refundAttempts.metadata,
    }).from(refundAttempts).where(and(
        eq(refundAttempts.orderId, params.orderId),
        sql`substr(${refundAttempts.attemptKey}, 1, ${prefix.length}) = ${prefix}`,
    )).all();
    if (rows.length === 0) return null;
    const amountMinor = rows.reduce((sum, row) => sum + row.amountMinor, 0);
    if (params.amount !== undefined && toMinor(params.amount, currency.decimalPlaces) !== amountMinor) {
        throw new ConflictError("This refund request was already used for a different amount. Reload and try again.");
    }
    const settlement: RefundSettlement = rows.some((row) =>
        parseRefundMetadata(row.metadata).settlementMode === "store_credit") ? "store_credit" : "original";
    if ((params.settlement ?? "original") !== settlement) {
        throw new ConflictError("This refund request was already used for a different refund. Reload and try again.");
    }
    if (rows.some((row) => ACTIVE_REFUND_ATTEMPT_STATUSES.includes(row.status as never))) {
        throw new ConflictError(REFUND_IN_PROGRESS_MESSAGE);
    }
    const failed = rows.find((row) => row.status === "failed");
    const storeCredit = settlement === "store_credit"
        ? await db.select({ id: giftCards.id, last4: giftCards.codeLast4, amountMinor: giftCards.initialAmountMinor })
            .from(giftCards)
            .where(and(
                eq(giftCards.source, "refund"),
                inArray(giftCards.sourceRefundAttemptId, rows.map((row) => row.id)),
            ))
            .get()
        : undefined;
    return {
        success: !failed,
        ...(failed ? { error: failed.lastError ?? "Refund processing failed" } : {}),
        gateway: rows[0]!.gateway,
        refundId: rows.map((row) => row.providerRefundId).filter(Boolean).join(",") || undefined,
        amount: fromMinor(amountMinor, currency.decimalPlaces),
        isFullRefund: order.paymentStatus === PaymentStatus.REFUNDED,
        manualSettlementRecorded: settlement === "original" && rows.some((row) => row.gateway === COD_PAYMENT_METHOD),
        availabilityTransitionVariantIds: [],
        replayed: true,
        settlement,
        ...(storeCredit ? {
            storeCredit: {
                giftCardId: storeCredit.id,
                last4: storeCredit.last4,
                amount: fromMinor(storeCredit.amountMinor, currency.decimalPlaces),
                amountMinor: storeCredit.amountMinor,
            },
        } : {}),
    };
}

function normalizePaymentGateway(value: string): string {
    // A gift-card tender is an internal payment: refundable, never dispatched.
    if (isPaymentMethodId(value) || value === GIFT_CARD_PAYMENT_METHOD) return value;
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
    // Cash or gateway money goes back first, gift-card tenders last: the
    // buyer gets their money back before their card balance (§14 decision 16).
    // The sort is stable, so each group keeps the newest-first ledger order.
    const allocationOrder = [...params.capturedPayments].sort((left, right) =>
        Number(left.paymentMethod === GIFT_CARD_PAYMENT_METHOD) - Number(right.paymentMethod === GIFT_CARD_PAYMENT_METHOD));

    for (const sourcePayment of allocationOrder) {
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
        // Omitted for "original" so the hash of an ordinary refund is unchanged.
        settlement: params.request.settlement === "store_credit" ? "store_credit" : undefined,
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
    const mode = allocationSettlementMode(params.allocation);

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
        ...(isInternalSettlement(mode) ? {
            settlementMode: mode,
            giftCardId: params.allocation.giftCardId,
            settlementOutcome: params.status === "refunded" ? "credited" : params.status,
        } : mode === "manual_external" ? {
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
    const mode = allocationSettlementMode(params.allocation);
    return JSON.stringify({
        reason: params.request.reason,
        gateway: params.allocation.sourcePayment.paymentMethod,
        ...(isInternalSettlement(mode) ? {
            settlementMode: mode,
            giftCardId: params.allocation.giftCardId,
        } : mode === "manual_external" ? {
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
    const mode = allocationSettlementMode(params.allocation);
    // An internal settlement commits in this very batch: the attempt starts
    // accepted, so a crash before finalization is finalized by recovery
    // instead of being released as "never dispatched" and refunded twice.
    const internal = isInternalSettlement(mode)
        ? {
            status: "processing",
            attempts: 1,
            providerStatus: INTERNAL_REFUND_PROVIDER_STATUSES[mode],
            responsePayload: JSON.stringify({ settlementMode: mode, giftCardId: params.allocation.giftCardId ?? null }),
        }
        : { status: "pending" };
    return {
        id: getRefundAttemptId(params.allocation),
        attemptKey: getRefundAttemptKeyForRequest(params.request, params.allocation),
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
        ...internal,
        claimId: params.groupId,
        claimExpiresAt: sql`unixepoch() + ${REFUND_ATTEMPT_LEASE_SECONDS}`,
        metadata: buildRefundAttemptMetadata(params),
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
    };
}

/** The attempt's unique key; also the idempotency key of a gift-card refund credit. */
function getRefundAttemptKeyForRequest(request: RefundRequest, allocation: RefundAllocation): string {
    const requestKey = request.requestKey?.trim();
    return requestKey
        ? `${refundRequestAttemptKeyPrefix(request.orderId, requestKey)}${allocation.index}`
        : getRefundAttemptKey(allocation);
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
    const isManualSettlement = allocationSettlementMode(allocation) === "manual_external";
    await db.update(refundAttempts).set({
        status: "processing",
        providerRefundId: allocation.refundId ?? null,
        providerStatus: acceptedProviderStatus(allocation),
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
            providerStatus: acceptedProviderStatus(allocation),
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

/** Batch-guard marker: the refund claim predicate no longer holds. */
const REFUND_CLAIM_CONFLICT = "REFUND_CLAIM_CONFLICT";
const GIFT_CARD_LEDGER_REASON_MAX_LENGTH = 500;

function refundLedgerReason(reason: string): string | null {
    const text = reason.trim();
    return text ? Array.from(text).slice(0, GIFT_CARD_LEDGER_REASON_MAX_LENGTH).join("") : null;
}

interface PreparedStoreCredit {
    giftCardId: string;
    /** The card, its `issue` transaction and its `gift_card_issued` outbox row. */
    statements: unknown[];
    notificationOutboxId: string;
}

/**
 * The store-credit card for a refund (Wave B §4.4): one `source='refund'`
 * card for the whole amount, owned by the order's account (if any) and
 * delivered to the order contact (email, else phone), expiring per the
 * store's gift-card setting (never by default). Its id derives from the
 * first allocation's attempt, which is unique, so it is issued once.
 */
async function prepareStoreCredit(
    db: Database,
    input: {
        order: {
            id: string;
            customerName: string;
            customerEmail: string | null;
            customerPhone: string;
            accountOwnerCustomerId: string | null;
        };
        encryptionKey: string | undefined;
        currencyCode: string;
        amountMinor: number;
        refundAttemptId: string;
        actor: { type: "system" | "admin"; id: string | null };
    },
): Promise<PreparedStoreCredit> {
    const keys = await deriveGiftCardKeys(input.encryptionKey);
    const settings = await readGiftCardSettings(db);
    if (!settings.ok) {
        throw new ServiceUnavailableError("Gift card settings couldn't be read. Try the refund again.");
    }
    const built = await buildStoreCreditGiftCardStatements(db, keys, {
        refundAttemptId: input.refundAttemptId,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        orderId: input.order.id,
        customerId: input.order.accountOwnerCustomerId,
        recipient: normalizeGiftCardRecipient({
            name: input.order.customerName,
            email: input.order.customerEmail,
            phone: input.order.customerPhone,
        }),
        expiresAt: giftCardExpiryFromMonths(settings.value.defaultExpiryMonths),
        actor: input.actor,
    });
    // Ids only: the code is resolved and sent at dispatch time, never stored.
    const notification = buildNotificationOutboxInsert(db, {
        subjectType: "gift_card",
        subjectId: built.giftCardId,
        audience: "customer",
        notificationType: "gift_card_issued",
        dedupeKey: `gift_card_issued:${built.giftCardId}`,
        source: "orders-refund-store-credit",
    });
    return {
        giftCardId: built.giftCardId,
        statements: [...built.statements, notification.statement],
        notificationOutboxId: notification.outboxId,
    };
}

/**
 * Decides how each allocation settles. Store credit settles every allocation
 * into the one new card. Otherwise a gift-card tender is credited back to the
 * card it debited (read from the ledger; an untraceable tender fails closed),
 * and everything else keeps its provider or manual COD settlement.
 */
async function assignAllocationSettlements(
    db: Database,
    allocations: RefundAllocation[],
    storeCreditGiftCardId: string | null,
): Promise<void> {
    if (storeCreditGiftCardId) {
        for (const allocation of allocations) {
            allocation.settlementMode = "store_credit";
            allocation.giftCardId = storeCreditGiftCardId;
        }
        return;
    }
    const tenders = allocations.filter((allocation) => allocation.sourcePayment.paymentMethod === GIFT_CARD_PAYMENT_METHOD);
    if (tenders.length === 0) return;
    const cardByPayment = await giftCardIdsForTenderPayments(db, tenders.map((allocation) => allocation.sourcePayment.id));
    for (const allocation of tenders) {
        const giftCardId = cardByPayment.get(allocation.sourcePayment.id);
        if (!giftCardId) {
            throw new ValidationError("This gift card payment can't be traced to its card, so it can't be refunded automatically.");
        }
        allocation.settlementMode = "gift_card";
        allocation.giftCardId = giftCardId;
    }
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
            customerName: orders.customerName,
            customerEmail: orders.customerEmail,
            customerPhone: orders.customerPhone,
            accountOwnerCustomerId: orders.accountOwnerCustomerId,
        })
        .from(orders)
        .where(eq(orders.id, params.orderId))
        .get();

    if (!order) {
        throw new NotFoundError(`Order ${params.orderId} not found`);
    }
    const settlement: RefundSettlement = params.settlement ?? "original";
    if (!REFUND_SETTLEMENTS.includes(settlement)) {
        throw new ValidationError(`Unsupported refund settlement: ${String(settlement)}`);
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
    const actor = params.actorUserId
        ? { type: "admin" as const, id: params.actorUserId }
        : { type: "system" as const, id: null };
    // Internal settlements are prepared before the claim, so a missing key or
    // an unreadable setting fails closed before anything is written.
    const storeCredit = settlement === "store_credit"
        ? await prepareStoreCredit(db, {
            order,
            encryptionKey,
            currencyCode: currency.code,
            amountMinor: refundAmount,
            refundAttemptId: getRefundAttemptId(allocations[0]!),
            actor,
        })
        : null;
    await assignAllocationSettlements(db, allocations, storeCredit?.giftCardId ?? null);
    const hasManualCodAllocation = allocations.some(
        (allocation) => allocationSettlementMode(allocation) === "manual_external",
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
    const claimCondition = and(
        eq(orders.id, params.orderId),
        eq(orders.version, order.version),
        sql`${orders.paidAmountMinor} >= ${refundAmount}`,
        noActiveRefundAttemptForOrderIdCondition(params.orderId),
        noActivePaymentSessionAttemptForOrderIdCondition(params.orderId),
    );
    // Gift-card ledger rows are append-only, so a lost claim can't be cleaned
    // up afterwards like the pending rows below. When the batch moves card
    // money, a guard evaluates the claim predicate first and fails the whole
    // batch, so nothing commits unless the claim does.
    const movesGiftCardMoney = storeCredit !== null
        || allocations.some((allocation) => allocationSettlementMode(allocation) === "gift_card");
    const ledgerReason = refundLedgerReason(params.reason);
    let claimResults: unknown[];
    try {
        claimResults = await db.batch([
            ...(movesGiftCardMoney
                ? [buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${claimCondition})`, REFUND_CLAIM_CONFLICT)]
                : []),
            // The guarded order claim must execute before this transaction creates
            // its own active refund rows. D1 batches are sequential: placing this
            // statement after the inserts makes the no-active-refund predicate see
            // and reject the claim's own rows.
            db.update(orders).set({
                version: claimVersion,
                updatedAt: sql`unixepoch()`,
            }).where(claimCondition).returning({ id: orders.id, version: orders.version }),
            ...allocations.flatMap((allocation) => {
                const mode = allocationSettlementMode(allocation);
                const internal = isInternalSettlement(mode);
                return [
                    db.insert(orderPayments).values({
                        id: allocation.id,
                        orderId: params.orderId,
                        amountMinor: allocation.amountMinor,
                        currency: currency.code,
                        paymentMethod: allocation.sourcePayment.paymentMethod,
                        paymentType: "refund",
                        // An internal settlement is done once this batch commits.
                        status: internal ? PaymentRecordStatus.REFUNDED : PaymentRecordStatus.PENDING,
                        metadata: buildRefundMetadata({
                            request: params,
                            allocation,
                            groupId: refundGroupId,
                            claimVersion,
                            allocationCount: allocations.length,
                            status: internal ? "refunded" : "pending",
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
                    // Credit back to the tender's card, keyed by the attempt key (G5).
                    ...(mode === "gift_card" ? [buildGiftCardRefundStatement(db, {
                        giftCardId: allocation.giftCardId!,
                        amountMinor: allocation.amountMinor,
                        orderId: params.orderId,
                        orderPaymentId: allocation.id,
                        refundAttemptId: getRefundAttemptId(allocation),
                        idempotencyKey: getRefundAttemptKeyForRequest(params, allocation),
                        actor,
                        reason: ledgerReason,
                    })] : []),
                ];
            }),
            // One new card for the whole refund, after the attempt it belongs to.
            ...(storeCredit?.statements ?? []),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        ] as any) as unknown[];
    } catch (error: unknown) {
        if (isBatchGuardError(error, REFUND_CLAIM_CONFLICT)) {
            // Lost the claim: another refund, payment or edit got there first.
            const replay = requestKey
                ? await findRefundRequestReplay(db, { ...params, requestKey }, order, currency)
                : null;
            if (replay) return replay;
            throw new ConflictError("Refund failed due to a concurrent modification. Please retry.");
        }
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

    const claimedOrderResult = claimResults[movesGiftCardMoney ? 1 : 0] as Array<{ id: string; version: number }> | undefined;
    const claimedOrder = claimedOrderResult?.[0];
    if (!claimedOrder) {
        // Unreachable when the batch moved card money: its guard failed the batch.
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
    // Internal settlements (gift card, store credit) committed with the claim:
    // they count as done before any provider is called, so a provider failure
    // below still finalizes them instead of marking settled money as failed.
    const completedAllocations: CompletedRefundAllocation[] = allocations
        .filter((allocation) => isInternalSettlement(allocationSettlementMode(allocation)))
        .map((allocation) => ({ ...allocation }));
    try {
        for (const allocation of allocations) {
            if (isInternalSettlement(allocationSettlementMode(allocation))) continue;
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
    const storeCreditCard = storeCredit
        ? await db.select({ last4: giftCards.codeLast4 }).from(giftCards).where(eq(giftCards.id, storeCredit.giftCardId)).get()
        : undefined;

    return {
        success: true,
        gateway: resultGateway,
        refundId: getCompletedRefundIds(completedAllocations),
        amount: fromMinor(refundAmount, currency.decimalPlaces),
        isFullRefund,
        manualSettlementRecorded: hasManualCodAllocation,
        settlement,
        ...(storeCredit && storeCreditCard ? {
            storeCredit: {
                giftCardId: storeCredit.giftCardId,
                last4: storeCreditCard.last4,
                amount: fromMinor(refundAmount, currency.decimalPlaces),
                amountMinor: refundAmount,
                notificationOutboxId: storeCredit.notificationOutboxId,
            },
        } : {}),
        availabilityTransitionVariantIds,
        refundNotification: {
            notificationType: refundNotification.notificationType,
            dedupeKey: refundNotification.dedupeKey,
            amount: refundNotification.amount,
            refundId: refundNotification.refundId,
        },
    };
}
