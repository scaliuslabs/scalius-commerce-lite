// src/modules/payments/refund-service.ts
// Gateway-agnostic refund orchestrator.
// Allocates a refund across the order's captured payments, claims it locally,
// then dispatches each allocation through its gateway adapter (gateways/port.ts).

import { inJsonArray } from "../../utils/in-json-array";
import { orderPricePolicy, readGiftCardSettings, toStoreMinor } from "../settings";
import { readStoreCurrency } from "../markets";
import { eq, inArray, sql, desc, and, type SQL } from "drizzle-orm";
import {
    orders,
    orderEvents,
    orderItems,
    orderPayments,
    orderRefundLines,
    orderRefunds,
    orderWithheldUnits,
    refundAttempts,
    giftCards,
    notificationOutbox,
    user,
    PaymentStatus,
    OrderStatus,
    PaymentRecordStatus,
    type OrderPayment,
} from "@scalius/database/schema";
import {
    isManualSettlementMethod,
    isPaymentMethodId,
    paymentProvidersFor,
    RECORDED_PAYMENT_METHOD,
    type PaymentProvidersSource,
} from "./gateways/registry";
import { canOperateExistingPayments } from "./gateways/port";
import { presentedSettlement } from "@scalius/shared/money-chain";
import { providerErrorOf } from "@scalius/shared/plugins/providers/kinds";
import { applyInventoryForStatusChangeWithImpact, isOrderInventoryConflictError, prepareInventoryForStatusChange } from "../inventory";
import type { Database } from "@scalius/database/client";
import { AppError, NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import {
  ACTIVE_REFUND_ATTEMPT_STATUSES,
  assertNoActivePaymentSessionAttempt,
  assertNoActiveRefundAttempt,
  assertNoActiveShipmentClaim,
  canTransitionTo,
  noActivePaymentSessionAttemptForOrderIdCondition,
  noActiveRefundAttemptForOrderIdCondition,
  REFUND_ATTEMPT_CLAIM_LOST,
  REFUND_IN_PROGRESS_MESSAGE,
  RefundAttemptClaimLostError,
  refundAttemptHeldCondition,
  type StockHeldReason,
  shipmentClaimShipmentStatusSql,
} from "../order-kernel";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { latePaymentEventStatement, latePaymentOf } from "./process-payment";
import { DISPUTE_FUNDS_WITHDRAWN, deriveOrderPaymentState, ledgerTotalsCondition, paymentLedgerTotals, type DisputeLedgerRow, type PaymentLedgerTotals } from "./payment-state";
import { PAYMENT_DISPUTED_REASON, isOpenDispute, orderDisputeLedgerRead, type OrderDisputeLedgerRow } from "./disputes";
import {
    assertOrderPaymentCurrency,
    resolveOrderCurrencySnapshot,
    type OrderCurrencySnapshot,
} from "./order-currency";
import { buildNotificationOutboxInsert, createOrderNotificationOutboxInsertValues, type OrderNotificationType } from "../notifications";
import { readPromotionRefundSnapshot } from "../promotions";
import {
    GIFT_CARD_PAYMENT_METHOD,
    buildGiftCardRefundStatement,
    buildStoreCreditGiftCardStatements,
    deriveGiftCardKeys,
    giftCardExpiryFromMonths,
    giftCardIdsForTenderPayments,
    isGiftCardLedgerError,
    normalizeGiftCardRecipient,
} from "../gift-cards";
import {
    GIFT_CARD_VALUE_SPENT_REASON,
    buildGiftCardClawbackStatements,
    giftCardPurchaseReads,
    giftCardPurchaseState,
    planGiftCardClawback,
    buildClaimTakesRelease,
    buildGiftCardClawbackSettlement,
    giftCardHandoverPending,
    orderHasPurchasedGiftCardsSql,
    type GiftCardClawbackSettlement,
    type GiftCardPurchaseState,
} from "./refund-gift-card-clawback";
import { buildBatchGuard, isBatchGuardError } from "@scalius/database/client";
import { sha256Hex } from "@scalius/shared/hash";
import { allocateRefundAcrossSources, type RefundSourceSettlement } from "@scalius/shared/refund-sources";

export interface RefundRequest {
    orderId: string;
    /** Decimal amount from the HTTP request. If omitted (and no `amountMinor`), the full paid amount is refunded. */
    amount?: number;
    /** The amount in integer minor units of the order currency (the app API); wins over `amount`. */
    amountMinor?: number;
    reason: string;
    /** Refund only payments captured by this payment method (useful for multi-gateway orders). */
    gateway?: string;
    /** Refund only this captured payment (an automatic refund of money that arrived late). */
    sourcePaymentId?: string;
    /**
     * Staff decide to pay back by hand a late payment whose automatic refund
     * failed for a reason that may heal (late-payment.ts marks it `retry`):
     * its share is recorded, not sent to the provider. Needs
     * `manualSettlementConfirmed`; the decision is a line on the order.
     */
    returnLatePaymentByHand?: boolean;
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
    /**
     * Who asks (security audit N1). Store credit turns the refunded money
     * into spendable stored value, so an app or an agent may issue it only
     * for money a provider captured (or gift-card value): a cash-on-delivery
     * or recorded payment is the store's word that money arrived, and only
     * staff may convert it. Omitted means staff (the dashboard route).
     */
    caller?: RefundCaller;
    /**
     * The order lines this refund is for (0172): recorded with the refund in
     * its claim batch and carried by its `refund.*` events, so an app can
     * tell which lines (a seller's, a subscription's) the money was for.
     * Quantities only: `amount` stays the money. Each line at most its
     * quantity less what refunds that did not fail already named.
     */
    lines?: readonly RefundLineInput[];
}

/** One order line a refund is for. */
export interface RefundLineInput {
    orderItemId: string;
    quantity: number;
}

export const REFUND_SETTLEMENTS = ["original", "store_credit"] as const;
export type RefundSettlement = (typeof REFUND_SETTLEMENTS)[number];
/** Who asks for a refund: staff in the dashboard, an installed app, or an agent acting for a staff member. */
export type RefundCaller = "staff" | "app" | "agent";
/** The refusal reason when an app or agent asks for store credit over a COD or recorded payment. */
export const STORE_CREDIT_NEEDS_STAFF_REASON = "store_credit_needs_staff";

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
    /** The refund record (`order_refunds`, the `refund` resource); absent when nothing was refunded. */
    orderRefundId?: string;
    /** The provider refund reference(s), comma-separated. */
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
    /** Unspent value taken back from gift cards the order bought (minor units), and how many cards. */
    giftCardsTakenBack?: { cards: number; amountMinor: number };
    error?: string;
    /** Internal cache signal; API responses must not expose this field. */
    availabilityTransitionVariantIds: string[];
    /** Internal: the customer's notice, committed with the refund (its outbox row exists). */
    refundNotification?: {
        notificationType: RefundCompletionNotificationType;
        dedupeKey: string;
        amount: number;
        refundId?: string;
    };
    /** Internal: the outbox rows the refund committed, for the sender. API responses omit it. */
    notificationOutboxIds?: string[];
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

/**
 * Money staff return by hand and confirm: cash on delivery and recorded
 * payments, and a late payment its provider could not refund (late-payment.ts).
 */
export function isManualSettlementPayment(payment: Pick<OrderPayment, "paymentMethod" | "metadata">): boolean {
    return isManualSettlementMethod(payment.paymentMethod) || latePaymentOf(payment.metadata)?.refund === "manual";
}

function allocationSettlementMode(allocation: Pick<RefundAllocation, "settlementMode" | "sourcePayment">): RefundSettlementMode {
    if (allocation.settlementMode) return allocation.settlementMode;
    if (allocation.sourcePayment.paymentMethod === GIFT_CARD_PAYMENT_METHOD) return "gift_card";
    return isManualSettlementPayment(allocation.sourcePayment) ? "manual_external" : "provider";
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
        refundGroupId: refundAttempts.refundGroupId,
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
    const requestedMinor = params.amountMinor ?? (params.amount === undefined ? undefined : toMinor(params.amount, currency.decimalPlaces));
    if (requestedMinor !== undefined && requestedMinor !== amountMinor) {
        throw new ConflictError("This refund request was already used for a different amount. Reload and try again.");
    }
    const settlement: RefundSettlement = rows.some((row) =>
        parseRefundMetadata(row.metadata).settlementMode === "store_credit") ? "store_credit" : "original";
    if ((params.settlement ?? "original") !== settlement) {
        throw new ConflictError("This refund request was already used for a different refund. Reload and try again.");
    }
    const orderRefundId = rows[0]!.refundGroupId;
    const recordedLines = await db.select({ orderItemId: orderRefundLines.orderItemId, quantity: orderRefundLines.quantity })
        .from(orderRefundLines).where(eq(orderRefundLines.refundId, orderRefundId)).all();
    if (!sameRefundLines(normalizeRefundLines(params.lines), normalizeRefundLines(recordedLines))) {
        throw new ConflictError("This refund request was already used for different order lines. Reload and try again.");
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
                inJsonArray(giftCards.sourceRefundAttemptId, rows.map((row) => row.id)),
            ))
            .get()
        : undefined;
    return {
        success: !failed,
        ...(failed ? { error: failed.lastError ?? "Refund processing failed" } : {}),
        gateway: rows[0]!.gateway,
        orderRefundId,
        refundId: rows.map((row) => row.providerRefundId).filter(Boolean).join(",") || undefined,
        amount: fromMinor(amountMinor, currency.decimalPlaces),
        isFullRefund: order.paymentStatus === PaymentStatus.REFUNDED,
        manualSettlementRecorded: settlement === "original" && rows.some((row) => isManualSettlementMethod(row.gateway)),
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

/** The most order lines one refund names (an order has at most this many lines). */
const MAX_REFUND_LINES = 250;

/** A refund's lines in canonical order (by order line), shape-checked; empty when none were given. */
function normalizeRefundLines(lines: RefundRequest["lines"]): RefundLineInput[] {
    if (!lines || lines.length === 0) return [];
    if (lines.length > MAX_REFUND_LINES) throw new ValidationError(`A refund names at most ${MAX_REFUND_LINES} order lines.`);
    const seen = new Set<string>();
    const normalized = lines.map((line) => {
        const orderItemId = typeof line.orderItemId === "string" ? line.orderItemId.trim() : "";
        if (!orderItemId) throw new ValidationError("Each refund line names an order line.");
        if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
            throw new ValidationError("Each refund line's quantity is a whole number of at least 1.");
        }
        if (seen.has(orderItemId)) throw new ValidationError(`Order line ${orderItemId} is named twice in the refund.`);
        seen.add(orderItemId);
        return { orderItemId, quantity: line.quantity };
    });
    return normalized.sort((left, right) => (left.orderItemId < right.orderItemId ? -1 : left.orderItemId > right.orderItemId ? 1 : 0));
}

/**
 * Each line is one of the order's and within what is left of it: its
 * quantity less what refunds that did not fail already named (the
 * `order_refund_lines_bounds_insert` trigger keeps it so under races) and
 * the units a settlement withheld (their money already went back).
 */
async function assertRefundableLines(db: Database, orderId: string, lines: readonly RefundLineInput[]): Promise<void> {
    if (lines.length === 0) return;
    const ids = lines.map((line) => line.orderItemId);
    const [items, refunded, withheld] = await db.batch([
        db.select({ id: orderItems.id, quantity: orderItems.quantity })
            .from(orderItems)
            .where(and(eq(orderItems.orderId, orderId), inJsonArray(orderItems.id, ids))),
        db.select({ orderItemId: orderRefundLines.orderItemId, quantity: sql<number>`sum(${orderRefundLines.quantity})` })
            .from(orderRefundLines)
            .innerJoin(orderRefunds, eq(orderRefunds.id, orderRefundLines.refundId))
            .where(and(eq(orderRefundLines.orderId, orderId), inJsonArray(orderRefundLines.orderItemId, ids), sql`${orderRefunds.status} <> 'failed'`))
            .groupBy(orderRefundLines.orderItemId),
        db.select({ orderItemId: orderWithheldUnits.orderItemId, quantity: sql<number>`sum(${orderWithheldUnits.quantity})` })
            .from(orderWithheldUnits)
            .where(and(eq(orderWithheldUnits.orderId, orderId), inJsonArray(orderWithheldUnits.orderItemId, ids)))
            .groupBy(orderWithheldUnits.orderItemId),
    ]);
    const quantities = new Map(items.map((item) => [item.id, item.quantity]));
    const already = new Map(refunded.map((row) => [row.orderItemId, Number(row.quantity) || 0]));
    for (const row of withheld) already.set(row.orderItemId, (already.get(row.orderItemId) ?? 0) + (Number(row.quantity) || 0));
    for (const line of lines) {
        const quantity = quantities.get(line.orderItemId);
        if (quantity === undefined) throw new ValidationError(`Order line ${line.orderItemId} is not a line of this order.`);
        const left = quantity - (already.get(line.orderItemId) ?? 0);
        if (line.quantity > left) {
            throw new ValidationError(`Order line ${line.orderItemId} has ${Math.max(0, left)} of ${quantity} left to refund.`);
        }
    }
}

const sameRefundLines = (left: readonly RefundLineInput[], right: readonly RefundLineInput[]) =>
    left.length === right.length && left.every((line, index) =>
        line.orderItemId === right[index]!.orderItemId && line.quantity === right[index]!.quantity);

function normalizePaymentGateway(value: string): string {
    // A gift-card tender is an internal payment: refundable, never dispatched;
    // a recorded payment is refunded by hand (a manual settlement).
    if (isPaymentMethodId(value) || value === GIFT_CARD_PAYMENT_METHOD || value === RECORDED_PAYMENT_METHOD) return value;
    throw new ValidationError(`Unsupported payment gateway: ${String(value)}`);
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
    capturedPayments: ReadonlyArray<Pick<OrderPayment, "id" | "amountMinor">>,
    refundRows: ReadonlyArray<Pick<OrderPayment, "amountMinor" | "metadata">>,
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

/** How a captured payment's money goes back on an original-method refund. */
function sourceSettlement(payment: Pick<OrderPayment, "paymentMethod" | "metadata">): RefundSourceSettlement {
    if (payment.paymentMethod === GIFT_CARD_PAYMENT_METHOD) return "gift_card";
    return isManualSettlementPayment(payment) ? "manual" : "provider";
}

type RefundLedgerRow = Pick<OrderPayment, "id" | "amountMinor" | "metadata" | "paymentMethod" | "paymentType" | "status">;

/**
 * Captured payments in refund order, each with what is still refundable:
 * cash or gateway money goes back first, gift-card tenders last (the buyer
 * gets their money back before their card balance, §14 decision 16). The
 * sort is stable, so each group keeps the newest-first ledger order.
 *
 * What a payment still refunds is what the store holds of it: received,
 * less what was refunded, less what a bank withdrew in a dispute (never
 * below zero). A payment with an open dispute refunds nothing: staff answer
 * the dispute instead (`disputed`).
 */
function orderedRefundSources<T extends Pick<OrderPayment, "id" | "amountMinor" | "paymentMethod" | "metadata">>(
    capturedPayments: readonly T[],
    refundRows: ReadonlyArray<Pick<OrderPayment, "amountMinor" | "metadata">>,
    disputes: readonly OrderDisputeLedgerRow[],
): Array<{ payment: T; settlement: RefundSourceSettlement; refundableMinor: number; disputed: boolean }> {
    const refundedBySource = computeRefundedBySourcePayment(capturedPayments, refundRows);
    const withdrawnBySource = new Map<string, number>();
    const disputedSources = new Set<string>();
    for (const dispute of disputes) {
        if (isOpenDispute(dispute.status)) disputedSources.add(dispute.paymentId);
        if (dispute.funds === DISPUTE_FUNDS_WITHDRAWN) {
            withdrawnBySource.set(dispute.paymentId, (withdrawnBySource.get(dispute.paymentId) ?? 0) + dispute.amountMinor);
        }
    }
    return [...capturedPayments]
        .sort((left, right) =>
            Number(left.paymentMethod === GIFT_CARD_PAYMENT_METHOD) - Number(right.paymentMethod === GIFT_CARD_PAYMENT_METHOD))
        .map((payment) => {
            const heldMinor = Math.max(0, payment.amountMinor - (refundedBySource.get(payment.id) ?? 0) - (withdrawnBySource.get(payment.id) ?? 0));
            const disputed = disputedSources.has(payment.id);
            return {
                payment,
                settlement: sourceSettlement(payment),
                refundableMinor: disputed ? 0 : heldMinor,
                disputed: disputed && heldMinor > 0,
            };
        });
}

export interface RefundSource {
    paymentId: string;
    paymentMethod: string;
    settlement: RefundSourceSettlement;
    refundableMinor: number;
    /** A late payment whose automatic refund failed: staff may return it by hand instead (`returnLatePaymentByHand`). */
    returnableByHand?: true;
}

/**
 * The sources an original-method refund draws from, in the order
 * `processRefund()` allocates it (`allocateRefundAcrossSources`). The
 * dashboard previews a refund's split from them: which part staff pay back by
 * hand and confirm, which part a gateway sends. `ledgerRows` is the order's
 * whole payment ledger, in any order: it is read newest first, id breaking a
 * same-second tie, as `processRefund()` reads it; `disputes` are its
 * disputes (`orderDisputeLedgerRead`): a disputed payment is no source.
 */
export function listRefundSources(
    ledgerRows: ReadonlyArray<RefundLedgerRow & Pick<OrderPayment, "createdAt">>,
    disputes: readonly OrderDisputeLedgerRow[],
): RefundSource[] {
    const newestFirst = [...ledgerRows].sort((left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
    const captured = newestFirst.filter(isCapturedPaymentRow);
    const refunds = newestFirst.filter(isRefundedPaymentRow);
    return orderedRefundSources(captured, refunds, disputes)
        .filter((source) => source.refundableMinor > 0)
        .map(({ payment, settlement, refundableMinor }) => ({
            paymentId: payment.id,
            paymentMethod: payment.paymentMethod,
            settlement,
            refundableMinor,
            ...(latePaymentOf(payment.metadata)?.refund === "retry" ? { returnableByHand: true as const } : {}),
        }));
}

function buildRefundAllocations(params: {
    orderId: string;
    claimVersion: number;
    refundAmountMinor: number;
    capturedPayments: CapturedPayment[];
    refundRows: Array<Pick<OrderPayment, "amountMinor" | "metadata">>;
    disputes: readonly OrderDisputeLedgerRow[];
    currency: OrderCurrencySnapshot;
}): RefundAllocation[] {
    const sources = orderedRefundSources(params.capturedPayments, params.refundRows, params.disputes);
    const { shares, unallocatedMinor } = allocateRefundAcrossSources(sources, params.refundAmountMinor);

    if (unallocatedMinor > 0 && sources.some((source) => source.disputed)) {
        // Money a disputed payment still holds would be needed: staff answer the dispute instead.
        throw new ValidationError(
            "A dispute is open on this order's payment. Answer the dispute instead of refunding it; once it is decided, refund what the store still holds.",
            {
                reason: PAYMENT_DISPUTED_REASON,
                maxRefundMinor: sources.reduce((sum, source) => sum + source.refundableMinor, 0),
            },
        );
    }
    if (unallocatedMinor > 0) {
        throw new ValidationError("Refund amount exceeds refundable captured payment balance", {
            requestedAmount: fromMinor(params.refundAmountMinor, params.currency.decimalPlaces),
            remainingUnallocatedAmount: fromMinor(unallocatedMinor, params.currency.decimalPlaces),
        });
    }

    if (shares.length === 0) {
        throw new NotFoundError("No refundable payment record found for this order");
    }

    return shares.map(({ source: { payment: sourcePayment }, amountMinor }, index) => ({
        id: getRefundClaimId(params.orderId, params.claimVersion - 1, index),
        sourcePayment,
        amountMinor,
        idempotencyKey: buildRefundIdempotencyKey(params.orderId, sourcePayment.id, params.claimVersion),
        refundReference: buildRefundReference(params.orderId, sourcePayment.id, params.claimVersion, index),
        index,
    }));
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
        // Omitted without lines, for the same reason.
        lines: params.request.lines?.length ? normalizeRefundLines(params.request.lines) : undefined,
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
    /** The notices this finalization committed (their outbox rows exist; recording them again is a no-op). */
    refundNotifications: RefundNotificationFact[];
    /** Their outbox rows, for the caller to hand to the sender (the scheduled drain sends them otherwise). */
    notificationOutboxIds: string[];
    availabilityTransitionVariantIds: string[];
}

function isCapturedPaymentRow(payment: Pick<OrderPayment, "paymentType" | "status">): boolean {
    return payment.paymentType !== "refund" && payment.status === PaymentRecordStatus.SUCCEEDED;
}

function isRefundedPaymentRow(payment: Pick<OrderPayment, "paymentType" | "status">): boolean {
    return payment.paymentType === "refund" && payment.status === PaymentRecordStatus.REFUNDED;
}

/** The `refund_recorded` timeline line of the attempts a finalization announces: one id per set, so a re-run adds nothing. */
async function refundRecordedEventId(orderId: string, attemptIds: readonly string[]): Promise<string> {
    const key = `refund-attempts:${[...attemptIds].sort().join(",")}`;
    return `oev_k${(await sha256Hex(`order-event\0${orderId}\0refund_recorded\0${key}`)).slice(0, 32)}`;
}

/** The outbox row of a refund's customer notice, fixed by its dedupe key so any caller can send it by id. */
export async function refundNotificationOutboxId(dedupeKey: string): Promise<string> {
    return `ono_refund_${(await sha256Hex(dedupeKey)).slice(0, 32)}`;
}

/**
 * Settles accepted refund attempts: the refund payments and the attempts
 * become refunded and the order's money and status follow, in one batch per
 * order guarded on the order's version and on the attempts still having the
 * status read. The same batch writes, for the attempts no earlier settlement
 * announced, the order's `refund_recorded` timeline line and the customer's
 * notice outbox row, and, for an order that bought gift cards, the settlement
 * of each refund it ends (`buildGiftCardClawbackSettlement`, guarded on every
 * attempt of that refund still having the status read). Every path that
 * settles a refund (the request, the reconciliation sweep, staff's check, an
 * import from the provider) runs it, so each gets the line, the notice and
 * the settlement exactly once. A batch that loses its guard re-reads and
 * tries again (an attempt finished meanwhile is left as it is). Stock of a
 * fully refunded, cancelled order is released in that batch, behind its
 * guard on the order's version. Stock the location refuses to take back
 * (when the release is prepared or in its batch) never stops the money: the
 * batch records the money and the cancel without it, with a `stock_held`
 * timeline line naming the refusal (its reason code and SKUs), and the stock
 * stays held until staff put it back from the order (the cancel's stock
 * applied again); nothing after the commit throws.
 * `actorUserId` is the staff member the line and the settlement name.
 */
export async function finalizeAcceptedRefundAttemptIds(
    db: Database,
    attemptIds: string[],
    options: { actorUserId?: string | null } = {},
): Promise<FinalizeAcceptedRefundAttemptsResult> {
    const uniqueAttemptIds = [...new Set(attemptIds.filter(Boolean))];
    const result: FinalizeAcceptedRefundAttemptsResult = {
        orderIds: [],
        finalizedAttemptIds: [],
        refundNotifications: [],
        notificationOutboxIds: [],
        availabilityTransitionVariantIds: [],
    };
    if (uniqueAttemptIds.length === 0) return result;

    const attempts = await readFinalizeAttempts(db, uniqueAttemptIds);
    if (attempts.length !== uniqueAttemptIds.length) {
        throw new NotFoundError("One or more refund attempts could not be found for reconciliation.");
    }
    // Validate every immutable order/payment currency before mutating refund rows.
    const orderIds = [...new Set(attempts.map((attempt) => attempt.orderId))];
    const reads = new Map<string, FinalizeOrderRead>();
    for (const orderId of orderIds) {
        reads.set(orderId, await readFinalizeOrder(db, orderId, attempts.filter((attempt) => attempt.orderId === orderId)));
    }

    const availabilityTransitionVariantIds = new Set<string>();
    const actor = options.actorUserId
        ? { type: "admin" as const, id: options.actorUserId }
        : { type: "system" as const, id: null };
    for (const orderId of orderIds) {
        let orderAttempts = attempts.filter((attempt) => attempt.orderId === orderId);
        let read = reads.get(orderId)!;
        // Why the location refused the stock, once it did: the batch then records the money without it.
        let stockHeld: StockHeldRefusal | null = null;
        for (let round = 0; ; round += 1) {
            const { order, currency, paymentRows, disputeRows } = read;
            const paymentState = deriveOrderPaymentState({
                totalAmountMinor: order.totalAmountMinor,
                deferred: order.paymentTermsDays !== null,
                ledger: paymentLedgerTotals(paymentRows, disputeRows),
            });
            const nextOrderStatus = getOrderStatusAfterRefund(order.status, paymentState.isFullRefund);
            const shouldReleaseInventory = paymentState.isFullRefund
                && (nextOrderStatus === OrderStatus.CANCELLED || order.status === OrderStatus.CANCELLED);

            // The attempts this finalization announces (none an earlier one announced).
            const announced = orderAttempts.filter((attempt) => !attempt.refundedAt);
            const announcement = announced.length > 0
                ? await buildRefundAnnouncement(db, {
                    orderId,
                    attempts: announced,
                    isFullRefund: paymentState.isFullRefund,
                    currency,
                    actorUserId: options.actorUserId ?? null,
                })
                : null;
            const settlements: GiftCardClawbackSettlement[] = [];
            if (order.hasPurchasedGiftCards) {
                for (const refundGroupId of new Set(orderAttempts.map((attempt) => attempt.refundGroupId))) {
                    settlements.push(await buildGiftCardClawbackSettlement(db, {
                        orderId,
                        refundGroupId,
                        outcomes: new Map(orderAttempts
                            .filter((attempt) => attempt.refundGroupId === refundGroupId)
                            .map((attempt) => [attempt.id, "refunded" as const])),
                        actor,
                    }));
                }
            }
            // The stock of the cancel moves in the cancel's batch, behind its guard on the order's version.
            let inventory: Awaited<ReturnType<typeof prepareInventoryForStatusChange>> | null = null;
            if (shouldReleaseInventory && stockHeld === null) {
                try {
                    inventory = await prepareInventoryForStatusChange(db, orderId, OrderStatus.CANCELLED);
                } catch (error: unknown) {
                    stockHeld = stockRefusal(error);
                    if (stockHeld === null) throw error;
                }
            }
            const stockHeldLine = shouldReleaseInventory && stockHeld !== null
                ? db.insert(orderEvents).values({
                    id: await stockHeldEventId(orderId, orderAttempts.map((attempt) => attempt.id)),
                    orderId,
                    kind: "stock_held",
                    body: stockHeld.detail,
                    data: JSON.stringify({ status: nextOrderStatus ?? order.status, reason: stockHeld.reason, skus: stockHeld.skus }),
                    actorId: null,
                    createdAt: sql`unixepoch()`,
                }).onConflictDoNothing({ target: orderEvents.id })
                : null;
            const guard = sql.join([
                sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${orderId} AND ${orders.version} = ${order.version})`,
                // The rows as read: the money written below is their state once these refunds settle.
                ledgerTotalsCondition(orderId, read.readTotals),
                attemptsStillAsRead(orderAttempts),
                ...settlements.map((settlement) => settlement.guard),
            ], sql` AND `);

            try {
                await db.batch([
                    buildBatchGuard(db, guard, REFUND_FINALIZE_CONFLICT),
                    db.update(orderPayments).set({
                        status: PaymentRecordStatus.REFUNDED,
                        updatedAt: sql`unixepoch()`,
                    }).where(inJsonArray(orderPayments.id, orderAttempts.map((attempt) => attempt.refundPaymentId))),
                    db.update(orders).set({
                        paidAmountMinor: paymentState.paidAmountMinor,
                        balanceDueMinor: paymentState.balanceDueMinor,
                        paymentStatus: paymentState.paymentStatus,
                        ...(nextOrderStatus ? { status: nextOrderStatus } : {}),
                        version: sql`${orders.version} + 1`,
                        updatedAt: sql`unixepoch()`,
                    }).where(and(eq(orders.id, orderId), eq(orders.version, order.version))),
                    // Refunded in the same write, so a sibling ending at once sees it (or loses its guard).
                    db.update(refundAttempts).set({
                        status: "refunded",
                        claimId: null,
                        claimExpiresAt: null,
                        refundedAt: sql`coalesce(${refundAttempts.refundedAt}, unixepoch())`,
                        updatedAt: sql`unixepoch()`,
                    }).where(inJsonArray(refundAttempts.id, orderAttempts.map((attempt) => attempt.id))),
                    ...(announcement?.statements ?? []),
                    ...settlements.flatMap((settlement) => settlement.statements),
                    ...(inventory?.statements ?? []),
                    ...(stockHeldLine ? [stockHeldLine] : []),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
                ] as any);
            } catch (error: unknown) {
                const refusal = inventory?.translateError(error);
                if (refusal) {
                    stockHeld = stockRefusal(refusal) ?? { reason: "refused", detail: String(refusal), skus: [] };
                    continue;
                }
                if (!isBatchGuardError(error, REFUND_FINALIZE_CONFLICT) && !isOrderInventoryConflictError(error)) throw error;
                if (round >= FINALIZE_CONFLICT_RETRIES) {
                    throw new ConflictError("Refund settlement was recorded, but local order reconciliation lost a concurrent update.");
                }
                // Something moved: read again; an attempt another run finished is no longer this one's to finish.
                orderAttempts = (await readFinalizeAttempts(db, orderAttempts.map((attempt) => attempt.id)))
                    .filter((attempt) => attempt.status !== "refunded");
                if (orderAttempts.length === 0) break;
                read = await readFinalizeOrder(db, orderId, orderAttempts);
                continue;
            }
            if (inventory) {
                for (const variantId of inventory.availabilityTransitionVariantIds) availabilityTransitionVariantIds.add(variantId);
                await inventory.afterCommit();
            }
            result.orderIds.push(orderId);
            result.finalizedAttemptIds.push(...orderAttempts.map((attempt) => attempt.id));
            if (announcement) {
                result.refundNotifications.push(announcement.notification);
                result.notificationOutboxIds.push(announcement.outboxId);
            }
            break;
        }
    }
    result.availabilityTransitionVariantIds = [...availabilityTransitionVariantIds];
    return result;
}

/** How many times a settlement batch that lost its guard re-reads and tries again. */
const FINALIZE_CONFLICT_RETRIES = 2;

interface StockHeldRefusal {
    reason: StockHeldReason;
    /** The refusal as the server words it (the timeline line's body, for the API and audit). */
    detail: string;
    skus: string[];
}

/** Why a stock release was refused (a location short of units, stock that moved, another refusal), or null for any other error. */
function stockRefusal(error: unknown): StockHeldRefusal | null {
    if (!(error instanceof AppError) || error.status >= 500) return null;
    const shortfalls = (error.details as { shortfalls?: Array<{ sku?: unknown }> } | undefined)?.shortfalls;
    const skus = Array.isArray(shortfalls)
        ? [...new Set(shortfalls.map((item) => item.sku).filter((sku): sku is string => typeof sku === "string"))].slice(0, 10)
        : [];
    const reason: StockHeldReason = error.code === "inventory_location_shortfall" ? "location_short" : error.status === 409 ? "stock_changed" : "refused";
    return { reason, detail: error.message, skus };
}

async function stockHeldEventId(orderId: string, attemptIds: readonly string[]): Promise<string> {
    const key = `refund-attempts:${[...attemptIds].sort().join(",")}`;
    return `oev_k${(await sha256Hex(`order-event\0${orderId}\0stock_held\0${key}`)).slice(0, 32)}`;
}

async function readFinalizeAttempts(db: Database, attemptIds: readonly string[]) {
    return db
        .select({
            id: refundAttempts.id,
            orderId: refundAttempts.orderId,
            refundGroupId: refundAttempts.refundGroupId,
            refundPaymentId: refundAttempts.refundPaymentId,
            providerRefundId: refundAttempts.providerRefundId,
            amountMinor: refundAttempts.amountMinor,
            currency: refundAttempts.currency,
            gateway: refundAttempts.gateway,
            reason: refundAttempts.reason,
            metadata: refundAttempts.metadata,
            status: refundAttempts.status,
            refundedAt: refundAttempts.refundedAt,
        })
        .from(refundAttempts)
        .where(inJsonArray(refundAttempts.id, attemptIds));
}

type FinalizeAttempt = Awaited<ReturnType<typeof readFinalizeAttempts>>[number];

interface FinalizeOrderRead {
    order: {
        id: string;
        totalAmountMinor: number;
        paymentTermsDays: number | null;
        status: string;
        version: number;
        currencyCode: string;
        currencyDecimalPlaces: number;
        hasPurchasedGiftCards: number;
    };
    currency: OrderCurrencySnapshot;
    /** The ledger as it reads once these attempts' refund payments are refunded. */
    paymentRows: Array<Pick<OrderPayment, "paymentType" | "status" | "amountMinor">>;
    /** The order's disputes: money a bank withdrew is not the store's to keep. */
    disputeRows: DisputeLedgerRow[];
    /** The ledger's totals as read, before them. */
    readTotals: PaymentLedgerTotals;
}

async function readFinalizeOrder(db: Database, orderId: string, orderAttempts: readonly FinalizeAttempt[]): Promise<FinalizeOrderRead> {
    const order = await db
        .select({
            id: orders.id,
            totalAmountMinor: orders.totalAmountMinor,
            paymentTermsDays: orders.paymentTermsDays,
            status: orders.status,
            version: orders.version,
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            hasPurchasedGiftCards: orderHasPurchasedGiftCardsSql(orderId),
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();
    if (!order) {
        throw new NotFoundError(`Order ${orderId} not found while reconciling refund attempts.`);
    }
    const currency = resolveOrderCurrencySnapshot(order);
    for (const attempt of orderAttempts) {
        assertOrderPaymentCurrency(attempt.currency, currency, "Refund attempt");
    }
    const [ledgerRows, disputeRows] = await db.batch([
        db.select({
            id: orderPayments.id,
            paymentType: orderPayments.paymentType,
            status: orderPayments.status,
            amountMinor: orderPayments.amountMinor,
            currency: orderPayments.currency,
        })
            .from(orderPayments)
            .where(eq(orderPayments.orderId, orderId)),
        orderDisputeLedgerRead(db, orderId),
    ]);
    for (const payment of ledgerRows) {
        assertOrderPaymentCurrency(payment.currency, currency, "Order payment ledger");
    }
    const refunding = new Set(orderAttempts.map((attempt) => attempt.refundPaymentId));
    return {
        order,
        currency,
        readTotals: paymentLedgerTotals(ledgerRows, disputeRows),
        disputeRows,
        paymentRows: ledgerRows.map((payment) => ({
            paymentType: payment.paymentType,
            status: refunding.has(payment.id) ? PaymentRecordStatus.REFUNDED : payment.status,
            amountMinor: payment.amountMinor,
        })),
    };
}

/**
 * The attempts still have the status they were read with (explicit aliases:
 * no outer column leaks in). Objects read by name: PostgreSQL's JSON path
 * profile takes `$.name` paths only.
 */
function attemptsStillAsRead(attempts: ReadonlyArray<{ id: string; status: string }>): SQL {
    const read = JSON.stringify(attempts.map((attempt) => ({ id: attempt.id, status: attempt.status })));
    return sql`(SELECT count(*) FROM ${refundAttempts} AS ra JOIN json_each(${read}) AS seen
        ON json_extract(seen.value, '$.id') = ra.id AND json_extract(seen.value, '$.status') = ra.status) = ${attempts.length}`;
}

/** Batch-guard marker: the order moved since finalization read it. */
const REFUND_FINALIZE_CONFLICT = "refund_finalize_conflict";

/**
 * The timeline line and the customer's notice for refund attempts a
 * finalization announces, as statements for its batch. Ids and last 4 only:
 * a store-credit card's code never enters either.
 */
async function buildRefundAnnouncement(
    db: Database,
    input: {
        orderId: string;
        attempts: ReadonlyArray<{ id: string; amountMinor: number; providerRefundId: string | null; gateway: string; reason: string | null; metadata: string | null }>;
        isFullRefund: boolean;
        currency: OrderCurrencySnapshot;
        actorUserId: string | null;
    },
): Promise<{ statements: unknown[]; notification: RefundCompletionNotificationFact; outboxId: string }> {
    const attemptIds = input.attempts.map((attempt) => attempt.id);
    const amountMinor = input.attempts.reduce((sum, attempt) => sum + attempt.amountMinor, 0);
    const amount = fromMinor(amountMinor, input.currency.decimalPlaces);
    const refundId = input.attempts.map((attempt) => attempt.providerRefundId).filter(Boolean).join(",") || undefined;
    const gateways = [...new Set(input.attempts.map((attempt) => attempt.gateway))];
    const storeCreditAttemptIds = input.attempts
        .filter((attempt) => parseRefundMetadata(attempt.metadata).settlementMode === "store_credit")
        .map((attempt) => attempt.id);
    const storeCredit = storeCreditAttemptIds.length > 0
        ? await db.select({ id: giftCards.id, last4: giftCards.codeLast4 }).from(giftCards)
            .where(and(eq(giftCards.source, "refund"), inJsonArray(giftCards.sourceRefundAttemptId, storeCreditAttemptIds)))
            .get()
        : undefined;
    const notificationType: RefundCompletionNotificationType = input.isFullRefund ? "order_refunded" : "order_partially_refunded";
    const dedupeKey = buildReconciledRefundNotificationDedupeKey(input.orderId, attemptIds, input.isFullRefund);
    const outboxId = await refundNotificationOutboxId(dedupeKey);
    const outbox = {
        ...createOrderNotificationOutboxInsertValues({
            orderId: input.orderId,
            notificationType,
            dedupeKey,
            source: "refund-finalized",
            data: {
                amount,
                ...(gateways.length === 1 ? { gateway: gateways[0] } : {}),
                ...(refundId ? { refundId } : {}),
                ...(storeCredit ? { settlement: "store_credit", storeCreditLast4: storeCredit.last4 } : {}),
            },
        }),
        id: outboxId,
    };
    const reason = input.attempts.find((attempt) => attempt.reason?.trim())?.reason?.trim() ?? null;
    const eventData = JSON.stringify({
        amount,
        full: input.isFullRefund,
        ...(storeCredit ? { settlement: "store_credit", giftCardId: storeCredit.id, giftCardLast4: storeCredit.last4 } : {}),
    });
    // A staff account only; an agent, app or the sweep records no name.
    const actor = input.actorUserId
        ? sql`(SELECT ${user.id} FROM ${user} WHERE ${user.id} = ${input.actorUserId})`
        : null;
    return {
        statements: [
            db.insert(orderEvents).values({
                id: await refundRecordedEventId(input.orderId, attemptIds),
                orderId: input.orderId,
                kind: "refund_recorded",
                body: reason,
                data: eventData,
                actorId: actor,
                createdAt: sql`unixepoch()`,
            }).onConflictDoNothing({ target: orderEvents.id }),
            db.insert(notificationOutbox).values(outbox).onConflictDoNothing({ target: notificationOutbox.dedupeKey }),
        ],
        notification: { orderId: input.orderId, notificationType, dedupeKey, amount, ...(refundId ? { refundId } : {}) },
        outboxId,
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
    if (isManualSettlementPayment(allocation.sourcePayment)) return null;
    return allocation.sourcePayment.providerSecondaryRef ?? allocation.sourcePayment.providerRef ?? null;
}

/** The statuses the request holds an attempt in under its claim (the refund group id). */
const REQUEST_HELD_STATUSES = ["pending", "processing"] as const;

/** The attempt still carries the request's claim in one of `statuses` (the WHERE of each of its writes). */
function heldByRequest(attemptId: string, refundGroupId: string, statuses: readonly string[] = REQUEST_HELD_STATUSES): SQL {
    return and(
        eq(refundAttempts.id, attemptId),
        eq(refundAttempts.claimId, refundGroupId),
        inArray(refundAttempts.status, [...statuses]),
    )!;
}

/**
 * Start the provider call of a pending attempt, under the request's live
 * claim only. Reconciliation releases a pending attempt whose lease ran out
 * (as never sent): a request that stalled that long changes nothing here and
 * stops, so a released attempt is never sent after staff refund again.
 */
async function markRefundAttemptProcessing(
    db: Database,
    allocation: RefundAllocation,
    refundGroupId: string,
): Promise<void> {
    const started = await db.update(refundAttempts).set({
        status: "processing",
        attempts: sql`${refundAttempts.attempts} + 1`,
        claimExpiresAt: sql`unixepoch() + ${REFUND_ATTEMPT_LEASE_SECONDS}`,
        lastError: null,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        heldByRequest(getRefundAttemptId(allocation), refundGroupId, ["pending"]),
        sql`${refundAttempts.claimExpiresAt} > unixepoch()`,
    )).returning({ id: refundAttempts.id });
    if (started.length === 0) throw new RefundAttemptClaimLostError();
}

/**
 * The provider accepted the allocation: its refund payment row and its
 * attempt record that together, under the request's claim. Reconciliation
 * that took the attempt over meanwhile owns it: nothing is written.
 */
async function markRefundAllocationAccepted(
    db: Database,
    allocation: CompletedRefundAllocation,
    refundGroupId: string,
    refundMetadata: string,
): Promise<void> {
    const attemptId = getRefundAttemptId(allocation);
    const isManualSettlement = allocationSettlementMode(allocation) === "manual_external";
    // Each statement carries the claim: the attempt's update reports whether it
    // still held it; the refund row moves only in the same case (it is read first).
    const results = await db.batch([
        db.update(orderPayments).set({
            status: PaymentRecordStatus.REFUNDED,
            // Refund rows never copy the source provider_ref: UNIQUE(provider,
            // provider_ref) identifies captures. The refund id lives in metadata.
            metadata: refundMetadata,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orderPayments.id, allocation.id),
            eq(orderPayments.status, PaymentRecordStatus.PENDING),
            refundAttemptHeldCondition(attemptId, refundGroupId, ["processing"]),
        )),
        db.update(refundAttempts).set({
            providerRefundId: allocation.refundId ?? null,
            providerStatus: acceptedProviderStatus(allocation),
            responsePayload: isManualSettlement
                ? JSON.stringify({ settlementMode: "manual_external" })
                : JSON.stringify({ refundId: allocation.refundId ?? null }),
            updatedAt: sql`unixepoch()`,
        }).where(heldByRequest(attemptId, refundGroupId, ["processing"])).returning({ id: refundAttempts.id }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ] as any) as unknown as [unknown, Array<{ id: string }>];
    if (results[1].length === 0) throw new RefundAttemptClaimLostError();
}

async function markRefundAttemptsReconcileRequired(
    db: Database,
    allocations: CompletedRefundAllocation[],
    refundGroupId: string,
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
        // Still the request's: a settlement that committed before the error keeps its attempts refunded.
        }).where(heldByRequest(getRefundAttemptId(allocation), refundGroupId, ["processing"]))
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
        /** The refund's gift-card settlement: its guard leads the batch, its writes follow the failures. */
        settlement?: GiftCardClawbackSettlement;
    },
): Promise<void> {
    if (params.allocations.length === 0) return;

    // A settlement assumes every one of these attempts ends here: it commits
    // only while the request still holds them all. Without one, each attempt
    // the request still holds ends; one reconciliation took is left to it.
    const held = sql.join(params.allocations.map((allocation) =>
        refundAttemptHeldCondition(getRefundAttemptId(allocation), params.groupId, REQUEST_HELD_STATUSES)), sql` AND `);
    try {
    await db.batch([
        ...(params.settlement ? [
            buildBatchGuard(db, held, REFUND_ATTEMPT_CLAIM_LOST),
            buildBatchGuard(db, params.settlement.guard, REFUND_FINALIZE_CONFLICT),
        ] : []),
        ...params.allocations.flatMap((allocation) => [
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
        }).where(and(
            eq(orderPayments.id, allocation.id),
            eq(orderPayments.status, PaymentRecordStatus.PENDING),
            refundAttemptHeldCondition(getRefundAttemptId(allocation), params.groupId, REQUEST_HELD_STATUSES),
        )),
        db.update(refundAttempts).set({
            status: "failed",
            providerStatus: "rejected",
            claimId: null,
            claimExpiresAt: null,
            lastError: serializeRefundAttemptError(params.error),
            failedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }).where(heldByRequest(getRefundAttemptId(allocation), params.groupId)),
        ]),
        ...(params.settlement?.statements ?? []),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ] as any);
    } catch (error: unknown) {
        // Reconciliation took one over: it settles the refund's gift cards (its backstop).
        if (isBatchGuardError(error, REFUND_ATTEMPT_CLAIM_LOST)) return;
        throw error;
    }
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
        currency: OrderCurrencySnapshot;
    },
): Promise<void> {
    if (params.allocations.length === 0) return;

    const originalError = isProviderRefundOutcomeUnknownError(params.error)
        ? params.error.originalError
        : params.error;
    // The buyer hears once that the refund is processing, with the move into
    // provider_unknown (reconciliation never repeats it on a later probe).
    const processing = buildRefundStateNotificationFact({
        orderId: params.request.orderId,
        refundGroupId: params.groupId,
        notificationType: "refund_processing",
        amountMinor: params.allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0),
        currency: params.currency,
    });
    const processingOutbox = {
        ...createOrderNotificationOutboxInsertValues({
            orderId: processing.orderId,
            notificationType: processing.notificationType,
            dedupeKey: processing.dedupeKey,
            source: "refund-provider-unknown",
            data: { amount: processing.amount },
        }),
        id: await refundNotificationOutboxId(processing.dedupeKey),
    };

    await db.batch([
        db.insert(notificationOutbox).values(processingOutbox).onConflictDoNothing({ target: notificationOutbox.dedupeKey }),
        ...params.allocations.flatMap((allocation) => [
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
        }).where(and(
            eq(orderPayments.id, allocation.id),
            eq(orderPayments.status, PaymentRecordStatus.PENDING),
            refundAttemptHeldCondition(getRefundAttemptId(allocation), params.groupId, REQUEST_HELD_STATUSES),
        )),
        db.update(refundAttempts).set({
            status: "provider_unknown",
            providerStatus: "unknown",
            claimId: null,
            claimExpiresAt: null,
            nextProbeAt: sql`unixepoch()`,
            lastError: serializeRefundAttemptError(originalError),
            updatedAt: sql`unixepoch()`,
        }).where(heldByRequest(getRefundAttemptId(allocation), params.groupId)),
        ]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    ] as any);
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
    encryptionKey: string | undefined,
    providers: PaymentProvidersSource | undefined,
): Promise<string | undefined> {
    if (isManualSettlementPayment(payment)) return undefined;
    const gateways = await paymentProvidersFor(providers, payment.paymentMethod);
    const gateway = gateways.get(payment.paymentMethod);
    if (!gateway?.refund) throw new ValidationError(`Unsupported refund gateway: ${payment.paymentMethod}`);
    const settings = await gateway.loadSettings(db, encryptionKey);
    if (!settings) throw new ServiceUnavailableError(`${gateway.label} is not configured`);
    if (settings.credentialErrors?.length) throw new ServiceUnavailableError(`${gateway.label} credentials are not readable`);
    // Turning a gateway off stops new payments only: money it took is
    // refunded while its credentials can reach the provider. One that cannot
    // says why (an app gateway: "Activate … in Apps to use it.").
    if (!canOperateExistingPayments(gateway, settings)) {
        throw new ServiceUnavailableError(gateway.readiness(settings).blockedReason ?? `${gateway.label} cannot be reached with its saved credentials`);
    }
    if (!payment.providerRef) throw new ValidationError(`No ${gateway.label} payment reference found on payment record`);
    if (!Number.isSafeInteger(refundAmountMinor) || refundAmountMinor <= 0) {
        throw new ValidationError(`${gateway.label} refund must resolve to a positive provider amount.`);
    }

    // A refund is asked for exactly, through the one payment amount codec; a
    // wire form that cannot carry it is refused before the call.
    const encoded = gateways.encodeAmount(gateway.id, refundAmountMinor, currency.code);
    if (encoded.roundingMinor !== 0) {
        throw new ValidationError(`${gateway.label} cannot refund this exact amount in ${currency.code}.`);
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new AbortController();
    try {
        const result = await Promise.race([
            gateway.refund({
                providerRef: payment.providerRef,
                secondaryRef: payment.providerSecondaryRef,
                amountMinor: refundAmountMinor,
                currency: currency.code,
                wireAmount: encoded.wire,
                reason: params.reason,
                idempotencyKey: providerMetadata.idempotencyKey,
                reference: providerMetadata.refundReference,
                metadata: providerMetadata,
            }, { settings, signal: deadline.signal }),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    deadline.abort();
                    reject(new Error(`Refund provider did not settle within ${REFUND_PROVIDER_DEADLINE_MS}ms`));
                }, REFUND_PROVIDER_DEADLINE_MS);
            }),
        ]);
        return result.refundId;
    } catch (error: unknown) {
        // Adapters validate their inputs before any network call.
        if (error instanceof ValidationError) throw error;
        // A port error that is certain the provider did nothing ends the attempt.
        const failure = providerErrorOf(error);
        if (failure && !failure.uncertain) throw new ValidationError(failure.message);
        throw new ProviderRefundOutcomeUnknownError(error);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function getCompletedRefundIds(allocations: CompletedRefundAllocation[]): string | undefined {
    return allocations.map((allocation) => allocation.refundId).filter(Boolean).join(",") || undefined;
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
const REFUND_CLAIM_CONFLICT = "refund_claim_conflict";
const REFUND_LINES_CONFLICT = "refund_lines_withheld_conflict";

/** Every named line still has room: units named by refunds that did not fail, this one's included, plus withheld units. */
function refundLinesFitCondition(orderId: string, lines: readonly RefundLineInput[]): SQL {
    return sql`NOT EXISTS (
        SELECT 1 FROM ${orderItems} AS line
        WHERE line.order_id = ${orderId}
          AND line.id IN (SELECT value FROM json_each(${JSON.stringify(lines.map((item) => item.orderItemId))}))
          AND (SELECT coalesce(sum(rl.quantity), 0) FROM ${orderRefundLines} AS rl
               INNER JOIN ${orderRefunds} AS r ON r.id = rl.refund_id
               WHERE rl.order_item_id = line.id AND r.status <> 'failed')
            + (SELECT coalesce(sum(w.quantity), 0) FROM ${orderWithheldUnits} AS w WHERE w.order_item_id = line.id) > line.quantity
    )`;
}
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
            customerPhone: string | null;
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
 * What a refund of `refundMinor` (the order's currency) gives back to the
 * card a gift-card tender debited, in the card's own currency (MARKETS-DESIGN
 * step 6): the same share of the debit (the tender's settlement), rounded
 * down, so all refunds together never credit more than was debited. A card
 * in the order's currency gets the refund as it is.
 */
export function giftCardRefundCreditMinor(
    tender: Pick<CapturedPayment, "amountMinor" | "currency" | "settlementCurrency" | "settlementAmountMinor">,
    refundMinor: number,
): number {
    if (!tender.settlementCurrency || tender.settlementCurrency === tender.currency || tender.amountMinor <= 0) return refundMinor;
    const credit = Number((BigInt(refundMinor) * BigInt(tender.settlementAmountMinor)) / BigInt(tender.amountMinor));
    if (credit <= 0) {
        throw new ValidationError("This refund is too small to credit back to the gift card in its currency. Refund more, or issue store credit.");
    }
    return credit;
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
/**
 * The most a refund naming no lines may give back (minor units) while the
 * gift cards the order bought bound it, by the same plan `processRefund`
 * refuses with; null when the order bought none or the bound leaves the whole
 * paid amount refundable. The dashboard offers it before any refusal.
 */
export async function previewGiftCardRefundLimitMinor(
    db: Database,
    orderId: string,
    payments: ReadonlyArray<Pick<OrderPayment, "paymentType" | "status" | "amountMinor">>,
    disputes: readonly OrderDisputeLedgerRow[],
): Promise<number | null> {
    const order = await db.select({
        paymentStatus: orders.paymentStatus,
        status: orders.status,
        paymentTermsDays: orders.paymentTermsDays,
        paidAmountMinor: orders.paidAmountMinor,
        buysGiftCards: orderHasPurchasedGiftCardsSql(orderId),
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order || !Number(order.buysGiftCards) || order.paidAmountMinor <= 0) return null;
    const [items, refundedUnits, cards, spent] = await db.batch(giftCardPurchaseReads(db, orderId));
    const plan = planGiftCardClawback({
        state: giftCardPurchaseState(items, refundedUnits, cards, spent),
        refundLines: [],
        receivedMinor: paymentLedgerTotals(payments, disputes).receivedMinor - paymentLedgerTotals(payments, disputes).withdrawnMinor,
        refundedBeforeMinor: paymentLedgerTotals(payments, disputes).returnedMinor,
        refundMinor: order.paidAmountMinor,
        // A refund of everything paid, as processRefund reads it.
        closesOrder: !giftCardHandoverPending(order, !(order.paymentTermsDays !== null && order.paymentStatus === PaymentStatus.PARTIAL)),
    });
    return plan.shortfallMinor > 0 ? Math.max(0, order.paidAmountMinor - plan.shortfallMinor) : null;
}

export async function processRefund(
    db: Database,
    params: RefundRequest,
    encryptionKey?: string,
    /** The request's gateways (built-in and app providers); built-in ones alone by default. */
    providers?: PaymentProvidersSource,
): Promise<RefundResult> {
    // 1. Fetch order (include version for CAS to prevent concurrent refund races)
    const order = await db
        .select({
            id: orders.id,
            paidAmountMinor: orders.paidAmountMinor,
            paymentStatus: orders.paymentStatus,
            paymentMethod: orders.paymentMethod,
            paymentTermsDays: orders.paymentTermsDays,
            status: orders.status,
            inventoryAction: orders.inventoryAction,
            version: orders.version,
            shipmentClaimId: orders.shipmentClaimId,
            shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
            // The claim's own attempt row: an expired claim with none (or a failed one) does not lock.
            shipmentClaimShipmentStatus: shipmentClaimShipmentStatusSql(),
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
            discountAmountMinor: orders.discountAmountMinor,
            customerName: orders.customerName,
            customerEmail: orders.customerEmail,
            customerPhone: orders.customerPhone,
            accountOwnerCustomerId: orders.accountOwnerCustomerId,
            // The order id is bound as a value: an outer column would bind to the line's own id here.
            buysGiftCards: sql<number>`EXISTS (SELECT 1 FROM ${orderItems} WHERE ${orderItems.orderId} = ${params.orderId} AND ${orderItems.fulfillmentType} = 'gift_card')`,
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
    const refundLines = normalizeRefundLines(params.lines);
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
    // An order that bought gift cards reads them with its ledger (one call): a
    // refund takes their unspent value back (refund-gift-card-clawback.ts).
    const ledgerRead = db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, params.orderId))
        // Newest first, id breaking a same-second tie: the refund order `listRefundSources()` previews.
        .orderBy(desc(orderPayments.createdAt), desc(orderPayments.id));
    let paymentLedgerRows: Awaited<typeof ledgerRead>;
    let disputes: OrderDisputeLedgerRow[];
    let giftCardState: GiftCardPurchaseState = { lines: [], cards: [] };
    if (order.buysGiftCards) {
        const [ledger, disputeRows, items, refundedUnits, cards, spent] = await db.batch([
            ledgerRead,
            orderDisputeLedgerRead(db, params.orderId),
            ...giftCardPurchaseReads(db, params.orderId),
        ]);
        paymentLedgerRows = ledger;
        disputes = disputeRows;
        giftCardState = giftCardPurchaseState(items, refundedUnits, cards, spent);
    } else {
        [paymentLedgerRows, disputes] = await db.batch([ledgerRead, orderDisputeLedgerRead(db, params.orderId)]);
    }
    const ledgerTotals = paymentLedgerTotals(paymentLedgerRows, disputes);
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
    if (params.amountMinor !== undefined && (!Number.isSafeInteger(params.amountMinor) || params.amountMinor <= 0)) {
        throw new ValidationError("Refund amount must be a whole number of minor units greater than zero");
    }
    const refundAmount = params.amountMinor !== undefined
        ? params.amountMinor
        : params.amount === undefined
        ? paidAmount
        // A merchant-entered refund is on the store's price increment (in the order's currency).
        : toStoreMinor(params.amount, orderPricePolicy(currency, await readStoreCurrency(db)));

    if (refundAmount <= 0) {
        throw new ValidationError("Refund amount must be greater than zero");
    }

    if (refundAmount > paidAmount) {
        const display = (minor: number) => fromMinor(minor, currency.decimalPlaces);
        throw new ValidationError(
            `Refund amount (${display(refundAmount)}) exceeds paid amount (${display(paidAmount)})`
        );
    }
    await assertRefundableLines(db, params.orderId, refundLines);

    // A partly paid invoice still owes the rest after its payments go back.
    const isFullRefund = refundAmount >= paidAmount
        && !(order.paymentTermsDays !== null && order.paymentStatus === PaymentStatus.PARTIAL);

    // Gift cards the order bought: the refund takes back their unspent value,
    // and never gives back value the buyer already spent from them.
    const giftCardClawback = planGiftCardClawback({
        state: giftCardState,
        refundLines,
        // What the store still received: a bank's dispute withdrawal is not its money.
        receivedMinor: ledgerTotals.receivedMinor - ledgerTotals.withdrawnMinor,
        refundedBeforeMinor: ledgerTotals.returnedMinor,
        refundMinor: refundAmount,
        // Units not issued yet count only while the handover will still issue them.
        closesOrder: !giftCardHandoverPending(order, isFullRefund),
    });
    if (giftCardClawback.shortfallMinor > 0) {
        const display = (minor: number) => fromMinor(minor, currency.decimalPlaces);
        const maxMinor = Math.max(0, refundAmount - giftCardClawback.shortfallMinor);
        const why = [
            giftCardClawback.spentMinor > 0 ? `${display(giftCardClawback.spentMinor)} of the gift cards this order bought was already spent` : null,
            giftCardClawback.unissuedMinor > 0 ? `${display(giftCardClawback.unissuedMinor)} in gift cards is still to be issued (name those units in the refund lines to cancel them)` : null,
        ].filter(Boolean).join(", and ");
        throw new ValidationError(
            `This refund gives back more than the order kept: ${why}. Refund at most ${display(maxMinor)}.`,
            {
                reason: GIFT_CARD_VALUE_SPENT_REASON,
                maxRefundAmount: display(maxMinor),
                // Integer minor units: clients word the refusal in their own language.
                maxRefundMinor: maxMinor,
                spentMinor: giftCardClawback.spentMinor,
                unissuedMinor: giftCardClawback.unissuedMinor,
            },
        );
    }

    const capturedPayments = paymentLedgerRows
        .filter((payment) =>
            payment.paymentType !== "refund" &&
            payment.status === PaymentRecordStatus.SUCCEEDED
        )
        .map((payment) => ({
            ...payment,
            paymentMethod: normalizePaymentGateway(payment.paymentMethod),
        }))
        .filter((payment) => !params.gateway || payment.paymentMethod === params.gateway)
        .filter((payment) => !params.sourcePaymentId || payment.id === params.sourcePaymentId);

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
        disputes,
        currency,
    });
    if (settlement === "store_credit" && (params.caller ?? "staff") !== "staff"
        && allocations.some((allocation) => isManualSettlementPayment(allocation.sourcePayment))) {
        // Store credit over money no provider captured would mint a live
        // gift card from a claim (an app's own "bank transfer").
        throw new ValidationError(
            "Store credit for a cash-on-delivery or recorded payment can only be issued by staff in the dashboard. Refund it to the original payment instead.",
            { reason: STORE_CREDIT_NEEDS_STAFF_REASON },
        );
    }
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
    // Staff decided to return a late payment by hand that the provider could still refund once it heals.
    const returnedByHand = params.returnLatePaymentByHand === true
        ? allocations.filter((allocation) => latePaymentOf(allocation.sourcePayment.metadata)?.refund === "retry")
        : [];
    if (params.returnLatePaymentByHand === true && returnedByHand.length === 0) {
        throw new ValidationError("Only a late payment its provider could not refund can be returned by hand instead.");
    }
    for (const allocation of returnedByHand) allocation.settlementMode = "manual_external";
    // Wrapped until the batch: a query builder resolved through a promise would run on its own.
    const decisions = (await Promise.all(returnedByHand.map((allocation) => latePaymentEventStatement(db, {
        orderId: params.orderId,
        paymentId: allocation.sourcePayment.id,
        refund: "by_hand",
        data: { amount: fromMinor(allocation.amountMinor, currency.decimalPlaces), decidedBy: params.actorUserId ?? null },
        when: sql`1 = 1`,
    })))).map((decision) => decision.statement);
    const hasManualCodAllocation = allocations.some(
        (allocation) => allocationSettlementMode(allocation) === "manual_external",
    );
    if (hasManualCodAllocation && params.manualSettlementConfirmed !== true) {
        throw new ValidationError(
            "Confirm that the customer has already received the refund by hand (cash or transfer) before recording it.",
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
    // A guard evaluates the claim predicate first and fails the whole batch,
    // so the refund rows, attempts and any card money commit only with the
    // claim: a lost claim leaves nothing behind to clean up.
    const ledgerReason = refundLedgerReason(params.reason);
    try {
        await db.batch([
            buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${claimCondition})`, REFUND_CLAIM_CONFLICT),
            // The guarded order claim must execute before this transaction creates
            // its own active refund rows. D1 batches are sequential: placing this
            // statement after the inserts makes the no-active-refund predicate see
            // and reject the claim's own rows.
            db.update(orders).set({
                version: claimVersion,
                updatedAt: sql`unixepoch()`,
            }).where(claimCondition),
            // The refund record and its lines come before its attempts:
            // `refund.created` fires on the first attempt with every line written.
            db.insert(orderRefunds).values({
                id: refundGroupId,
                orderId: params.orderId,
                currency: currency.code,
                amountMinor: refundAmount,
                settlement,
                createdAt: sql`unixepoch()`,
                updatedAt: sql`unixepoch()`,
            }),
            ...refundLines.map((line, index) => db.insert(orderRefundLines).values({
                id: `${refundGroupId}_line_${index + 1}`,
                refundId: refundGroupId,
                orderId: params.orderId,
                orderItemId: line.orderItemId,
                quantity: line.quantity,
                createdAt: sql`unixepoch()`,
            })),
            // The lines' bounds trigger counts named units only: a settlement that withheld units
            // since the lines were read must leave room too (named + withheld <= the line's quantity).
            ...(refundLines.length > 0 ? [buildBatchGuard(db, refundLinesFitCondition(params.orderId, refundLines), REFUND_LINES_CONFLICT)] : []),
            ...allocations.flatMap((allocation) => {
                const mode = allocationSettlementMode(allocation);
                const internal = isInternalSettlement(mode);
                return [
                    db.insert(orderPayments).values({
                        id: allocation.id,
                        orderId: params.orderId,
                        amountMinor: allocation.amountMinor,
                        currency: currency.code,
                        // Refunds are made in the presentment currency (D2).
                        ...presentedSettlement(allocation.amountMinor, currency.code),
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
                        // The card's own currency: its share of the tender's debit.
                        amountMinor: giftCardRefundCreditMinor(allocation.sourcePayment, allocation.amountMinor),
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
            // Staff's decision to return a late payment by hand, on the order with the refund.
            ...decisions,
            // The bought cards' value goes back with the money, after the attempt it names.
            ...buildGiftCardClawbackStatements(db, {
                plan: giftCardClawback,
                orderId: params.orderId,
                refundAttemptId: getRefundAttemptId(allocations[0]!),
                actor,
            }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        ] as any);
    } catch (error: unknown) {
        if (giftCardClawback.clawbacks.length > 0 && isGiftCardLedgerError(error)) {
            // A card the order bought was spent between the read and the claim: nothing was written.
            throw new ConflictError("A gift card this order bought was used while the refund was being recorded. Reload and try again.");
        }
        if (isBatchGuardError(error, REFUND_LINES_CONFLICT)) {
            // Name the line that no longer fits, as the read before the claim does.
            await assertRefundableLines(db, params.orderId, refundLines);
            throw new ConflictError("The order's lines changed while this refund was prepared; review them and try again.");
        }
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
            // Paid back by hand (cash on delivery, recorded, or a late payment staff return): nothing is sent.
            const refundId = allocationSettlementMode(allocation) === "manual_external" ? undefined : await dispatchRefund(
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
                providers,
            );

            const completedAllocation = { ...allocation, refundId };
            await markRefundAllocationAccepted(db, completedAllocation, refundGroupId, buildRefundMetadata({
                request: params,
                allocation,
                groupId: refundGroupId,
                claimVersion,
                allocationCount: allocations.length,
                status: "refunded",
                refundId,
            }));
            completedAllocations.push(completedAllocation);
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
                currency,
            });
        } else {
            // When these failures end the refund (nothing went back), what it
            // took from the order's gift cards is settled in the same batch;
            // when some allocations went through, their finalization settles.
            // The failures are written whatever the settlement planning does.
            const failure = {
                request: params,
                allocations: unresolvedAllocations,
                groupId: refundGroupId,
                claimVersion,
                allocationCount: allocations.length,
                error,
            };
            let written = false;
            let planned = true;
            for (let round = 0; giftCardClawback.clawbacks.length > 0 && !written && round <= FINALIZE_CONFLICT_RETRIES; round += 1) {
                const settlement = await buildGiftCardClawbackSettlement(db, {
                    orderId: params.orderId,
                    refundGroupId,
                    outcomes: new Map(unresolvedAllocations.map((allocation) => [getRefundAttemptId(allocation), "failed"] as const)),
                    actor,
                }).catch((settleError: unknown) => {
                    console.error("[refund-service] Gift card settlement of a failed refund could not be planned:", settleError instanceof Error ? settleError.name : "error");
                    return null;
                });
                if (!settlement) {
                    planned = false;
                    break;
                }
                try {
                    await markRefundAllocationsFailed(db, { ...failure, settlement });
                    written = true;
                } catch (writeError: unknown) {
                    if (isBatchGuardError(writeError, REFUND_FINALIZE_CONFLICT)) continue;
                    console.error("[refund-service] Gift card settlement of a failed refund could not be written:", writeError instanceof Error ? writeError.name : "error");
                    break;
                }
            }
            if (!written && !planned && completedAllocations.length === 0) {
                // Nothing went back and the settlement couldn't be planned: the
                // claim's own takes (known here) go back with the failures.
                await markRefundAllocationsFailed(db, {
                    ...failure,
                    settlement: buildClaimTakesRelease(db, {
                        orderId: params.orderId,
                        refundGroupId,
                        firstAttemptId: getRefundAttemptId(allocations[0]!),
                        clawbacks: giftCardClawback.clawbacks,
                        actor,
                    }),
                }).then(() => { written = true; }, (releaseError: unknown) => {
                    console.error("[refund-service] The claim's gift card takes are left to the reconciliation backstop:", releaseError instanceof Error ? releaseError.name : "error");
                });
            }
            // The failures are written whatever the settlement did (the backstop settles what's left).
            if (!written) await markRefundAllocationsFailed(db, failure);
        }

        const completedAmount = completedAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
        const display = (minor: number) => fromMinor(minor, currency.decimalPlaces);
        if (completedAmount > 0) {
            let finalizedResult: FinalizeAcceptedRefundAttemptsResult;
            try {
                finalizedResult = await finalizeAcceptedRefundAttemptIds(
                    db,
                    completedAllocations.map((allocation) => getRefundAttemptId(allocation)),
                    { actorUserId: params.actorUserId ?? null },
                );
            } catch (finalizeError: unknown) {
                await markRefundAttemptsReconcileRequired(db, completedAllocations, refundGroupId, finalizeError);
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

    let finalized: FinalizeAcceptedRefundAttemptsResult;
    try {
        // Its batch writes the timeline line and the customer's notice with the money.
        finalized = await finalizeAcceptedRefundAttemptIds(
            db,
            completedAllocations.map((allocation) => getRefundAttemptId(allocation)),
            { actorUserId: params.actorUserId ?? null },
        );
    } catch (finalizeError: unknown) {
        await markRefundAttemptsReconcileRequired(db, completedAllocations, refundGroupId, finalizeError);
        throw finalizeError;
    }
    const refundNotification = finalized.refundNotifications[0] as RefundCompletionNotificationFact | undefined;
    const storeCreditCard = storeCredit
        ? await db.select({ last4: giftCards.codeLast4 }).from(giftCards).where(eq(giftCards.id, storeCredit.giftCardId)).get()
        : undefined;

    return {
        success: true,
        gateway: resultGateway,
        orderRefundId: refundGroupId,
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
        ...(giftCardClawback.clawbacks.length > 0 ? {
            giftCardsTakenBack: {
                cards: giftCardClawback.clawbacks.length,
                amountMinor: giftCardClawback.clawbacks.reduce((sum, clawback) => sum + clawback.amountMinor, 0),
            },
        } : {}),
        availabilityTransitionVariantIds: finalized.availabilityTransitionVariantIds,
        notificationOutboxIds: finalized.notificationOutboxIds,
        ...(refundNotification ? {
            refundNotification: {
                notificationType: refundNotification.notificationType,
                dedupeKey: refundNotification.dedupeKey,
                amount: refundNotification.amount,
                refundId: refundNotification.refundId,
            },
        } : {}),
    };
}
