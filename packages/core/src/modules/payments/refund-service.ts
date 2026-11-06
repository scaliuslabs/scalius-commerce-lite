// src/modules/payments/refund-service.ts
// Gateway-agnostic refund orchestrator.
// Allocates a refund across the order's captured payments, claims it locally,
// then dispatches each allocation through its gateway adapter (gateways/port.ts).

import { inJsonArray } from "../../utils/in-json-array";
import { orderPricePolicy, readGiftCardSettings, toStoreMinor } from "../settings";
import { readStoreCurrency } from "../markets";
import { eq, sql, desc, and } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
    orders,
    orderItems,
    orderPayments,
    orderRefundLines,
    orderRefunds,
    refundAttempts,
    giftCards,
    paymentPlans,
    PaymentStatus,
    OrderStatus,
    PaymentRecordStatus,
    PaymentPlanStatus,
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
import { applyInventoryForStatusChangeWithImpact } from "../inventory";
import type { Database } from "@scalius/database/client";
import { NotFoundError, ValidationError, ConflictError, ServiceUnavailableError } from "@scalius/core/errors";
import {
  ACTIVE_REFUND_ATTEMPT_STATUSES,
  assertNoActivePaymentSessionAttempt,
  assertNoActiveRefundAttempt,
  assertNoActiveShipmentClaim,
  canTransitionTo,
  noActivePaymentSessionAttemptForOrderIdCondition,
  noActiveRefundAttemptForOrderIdCondition,
  REFUND_IN_PROGRESS_MESSAGE,
} from "../order-kernel";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { computeOrderPaymentState } from "./payment-state";
import {
    assertOrderPaymentCurrency,
    resolveOrderCurrencySnapshot,
    type OrderCurrencySnapshot,
} from "./order-currency";
import { buildNotificationOutboxInsert, type OrderNotificationType } from "../notifications";
import { readPromotionRefundSnapshot } from "../promotions";
import {
    GIFT_CARD_PAYMENT_METHOD,
    buildGiftCardRefundStatement,
    buildStoreCreditGiftCardStatements,
    deriveGiftCardKeys,
    giftCardExpiryFromMonths,
    giftCardIdsForTenderPayments,
    normalizeGiftCardRecipient,
} from "../gift-cards";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { sha256Hex } from "@scalius/shared/hash";
import { allocateRefundAcrossSources, type RefundSourceSettlement } from "@scalius/shared/refund-sources";
import { deriveRuntimeSecret, readMasterSecret, RUNTIME_SECRET_PURPOSES } from "@scalius/shared/runtime-secrets";
import type { MasterSecretEnvironment } from "@scalius/shared/runtime-secrets";

export interface RefundRequest {
    orderId: string;
    /** Decimal amount from the HTTP request. If omitted (and no `amountMinor`), the full paid amount is refunded. */
    amount?: number;
    /** The amount in integer minor units of the order currency (the app API); wins over `amount`. */
    amountMinor?: number;
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
    return isManualSettlementMethod(allocation.sourcePayment.paymentMethod) ? "manual_external" : "provider";
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
 * `order_refund_lines_bounds_insert` trigger keeps it so under races).
 */
async function assertRefundableLines(db: Database, orderId: string, lines: readonly RefundLineInput[]): Promise<void> {
    if (lines.length === 0) return;
    const ids = lines.map((line) => line.orderItemId);
    const [items, refunded] = await db.batch([
        db.select({ id: orderItems.id, quantity: orderItems.quantity })
            .from(orderItems)
            .where(and(eq(orderItems.orderId, orderId), inJsonArray(orderItems.id, ids))),
        db.select({ orderItemId: orderRefundLines.orderItemId, quantity: sql<number>`sum(${orderRefundLines.quantity})` })
            .from(orderRefundLines)
            .innerJoin(orderRefunds, eq(orderRefunds.id, orderRefundLines.refundId))
            .where(and(eq(orderRefundLines.orderId, orderId), inJsonArray(orderRefundLines.orderItemId, ids), sql`${orderRefunds.status} <> 'failed'`))
            .groupBy(orderRefundLines.orderItemId),
    ]);
    const quantities = new Map(items.map((item) => [item.id, item.quantity]));
    const already = new Map(refunded.map((row) => [row.orderItemId, Number(row.quantity) || 0]));
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

/** Derives the HMAC key for refund metadata integrity. No module-level cache to comply with source policy. */
export async function getRefundHmacKey(env: MasterSecretEnvironment | null | undefined): Promise<string | null> {
    const master = readMasterSecret(env);
    if (!master) return null;
    return deriveRuntimeSecret(master, RUNTIME_SECRET_PURPOSES.REFUND_METADATA_HMAC);
}

/** Computes HMAC-SHA256 of the metadata payload. */
export async function computeRefundMetadataHmac(
    env: MasterSecretEnvironment | null | undefined,
    payload: string,
): Promise<string | null> {
    const key = await getRefundHmacKey(env);
    if (!key) return null;
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payload));
    return btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Verifies HMAC-SHA256 of the metadata payload. */
export async function verifyRefundMetadataHmac(
    env: MasterSecretEnvironment | null | undefined,
    payload: string,
    hmac: string | undefined,
): Promise<boolean> {
    if (!hmac || !/^[A-Za-z0-9_-]{43}$/.test(hmac)) return false;
    const key = await getRefundHmacKey(env);
    if (!key) return false;
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key),
        { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signature = Uint8Array.from(atob(hmac.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
    return crypto.subtle.verify("HMAC", cryptoKey, signature, encoder.encode(payload));
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
function sourceSettlement(paymentMethod: string): RefundSourceSettlement {
    if (paymentMethod === GIFT_CARD_PAYMENT_METHOD) return "gift_card";
    return isManualSettlementMethod(paymentMethod) ? "manual" : "provider";
}

type RefundLedgerRow = Pick<OrderPayment, "id" | "amountMinor" | "metadata" | "paymentMethod" | "paymentType" | "status">;

/**
 * Captured payments in refund order, each with what is still refundable:
 * cash or gateway money goes back first, gift-card tenders last (the buyer
 * gets their money back before their card balance, §14 decision 16). The
 * sort is stable, so each group keeps the newest-first ledger order.
 */
function orderedRefundSources<T extends Pick<OrderPayment, "id" | "amountMinor" | "paymentMethod">>(
    capturedPayments: readonly T[],
    refundRows: ReadonlyArray<Pick<OrderPayment, "amountMinor" | "metadata">>,
): Array<{ payment: T; settlement: RefundSourceSettlement; refundableMinor: number }> {
    const refundedBySource = computeRefundedBySourcePayment(capturedPayments, refundRows);
    return [...capturedPayments]
        .sort((left, right) =>
            Number(left.paymentMethod === GIFT_CARD_PAYMENT_METHOD) - Number(right.paymentMethod === GIFT_CARD_PAYMENT_METHOD))
        .map((payment) => ({
            payment,
            settlement: sourceSettlement(payment.paymentMethod),
            refundableMinor: Math.max(0, payment.amountMinor - (refundedBySource.get(payment.id) ?? 0)),
        }));
}

export interface RefundSource {
    paymentId: string;
    paymentMethod: string;
    settlement: RefundSourceSettlement;
    refundableMinor: number;
}

/**
 * The sources an original-method refund draws from, in the order
 * `processRefund()` allocates it (`allocateRefundAcrossSources`). The
 * dashboard previews a refund's split from them: which part staff pay back by
 * hand and confirm, which part a gateway sends. `ledgerRows` is the order's
 * whole payment ledger, in any order: it is read newest first, id breaking a
 * same-second tie, as `processRefund()` reads it.
 */
export function listRefundSources(ledgerRows: ReadonlyArray<RefundLedgerRow & Pick<OrderPayment, "createdAt">>): RefundSource[] {
    const newestFirst = [...ledgerRows].sort((left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
    const captured = newestFirst.filter(isCapturedPaymentRow);
    const refunds = newestFirst.filter(isRefundedPaymentRow);
    return orderedRefundSources(captured, refunds)
        .filter((source) => source.refundableMinor > 0)
        .map(({ payment, settlement, refundableMinor }) => ({
            paymentId: payment.id,
            paymentMethod: payment.paymentMethod,
            settlement,
            refundableMinor,
        }));
}

function buildRefundAllocations(params: {
    orderId: string;
    claimVersion: number;
    refundAmountMinor: number;
    capturedPayments: CapturedPayment[];
    refundRows: Array<Pick<OrderPayment, "amountMinor" | "metadata">>;
    currency: OrderCurrencySnapshot;
}): RefundAllocation[] {
    const { shares, unallocatedMinor } = allocateRefundAcrossSources(
        orderedRefundSources(params.capturedPayments, params.refundRows),
        params.refundAmountMinor,
    );

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
    refundNotifications: RefundNotificationFact[];
    availabilityTransitionVariantIds: string[];
}

function isCapturedPaymentRow(payment: Pick<OrderPayment, "paymentType" | "status">): boolean {
    return payment.paymentType !== "refund" && payment.status === PaymentRecordStatus.SUCCEEDED;
}

function isRefundedPaymentRow(payment: Pick<OrderPayment, "paymentType" | "status">): boolean {
    return payment.paymentType === "refund" && payment.status === PaymentRecordStatus.REFUNDED;
}

export function computePaymentStateFromLedger(params: {
    totalAmountMinor: number;
    /** An invoice (net terms) order: money it was never paid stays owed. */
    deferred?: boolean;
    payments: Array<Pick<OrderPayment, "paymentType" | "status" | "amountMinor">>;
    /** A deferred (invoice) order: its terms days, null for any other order. */
    paymentTermsDays?: number | null;
}) {
    const capturedAmount = params.payments
        .filter(isCapturedPaymentRow)
        .reduce((sum, payment) => sum + payment.amountMinor, 0);
    const refundedAmount = params.payments
        .filter(isRefundedPaymentRow)
        .reduce((sum, payment) => sum + payment.amountMinor, 0);

    // A part-paid invoice: giving back what was received leaves the rest
    // still owed (goods may already be delivered). Its balance is the total
    // less what it keeps, and only the merchant closes it (cancel), never a
    // refund.
    const deferred = params.deferred === true
        || (params.paymentTermsDays !== null && params.paymentTermsDays !== undefined);
    if (deferred && refundedAmount > 0 && capturedAmount < params.totalAmountMinor) {
        return {
            isFullRefund: false,
            ...computeOrderPaymentState({
                totalAmountMinor: params.totalAmountMinor,
                paidAmountMinor: Math.max(0, capturedAmount - refundedAmount),
            }),
        };
    }
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
    /** Master secret (SCALIUS_SECRET) for verifying signed refund metadata. */
    masterSecret?: string,
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
            sourcePaymentId: refundAttempts.sourcePaymentId,
            amountMinor: refundAttempts.amountMinor,
            currency: refundAttempts.currency,
            metadata: refundAttempts.metadata,
        })
        .from(refundAttempts)
        .where(inJsonArray(refundAttempts.id, uniqueAttemptIds));

    if (attempts.length !== uniqueAttemptIds.length) {
        throw new NotFoundError("One or more refund attempts could not be found for reconciliation.");
    }

    // Never commit a signed refund when its integrity cannot be verified.
    // In particular, recovery must not mark the attempt terminal while leaving
    // a refunded manual deposit plan eligible for fulfilment.
    for (const attempt of attempts) {
        const metadata = parseRefundMetadata(attempt.metadata);
        if (Object.hasOwn(metadata, "_hmac")) {
            const { _hmac, ...payload } = metadata;
            const env = masterSecret ? { SCALIUS_SECRET: masterSecret } : null;
            if (typeof _hmac !== "string" || !await verifyRefundMetadataHmac(env, JSON.stringify(payload), _hmac)) {
                throw new ValidationError("Refund metadata integrity verification failed.");
            }
        }
    }

    const refundPaymentIds = attempts.map((attempt) => attempt.refundPaymentId);
    const refundPaymentIdSet = new Set(refundPaymentIds);
    const reconciliationByOrder = new Map<string, {
        order: {
            id: string;
            totalAmountMinor: number;
            paymentTermsDays: number | null;
            status: string;
            version: number;
            currencyCode: string;
            currencyDecimalPlaces: number;
        };
        currency: OrderCurrencySnapshot;
        paymentRows: Array<Pick<OrderPayment, "paymentType" | "status" | "amountMinor">>;
        paymentState: ReturnType<typeof computePaymentStateFromLedger>;
        nextOrderStatus: string | undefined;
        shouldReleaseInventory: boolean;
    }>();

    // Read orders, payment ledger, and manual COD deposit plans. Compute
    // payment state per order before any mutation so all values are ready
    // for the atomic batch.
    const refundedDepositsByOrder = new Map<string, number>();
    const manualPlansByOrder = new Map<string, { id: string; depositAmountMinor: number; status: string; kind: string } | null>();
    for (const orderId of new Set(attempts.map((attempt) => attempt.orderId))) {
        const order = await db
            .select({
                id: orders.id,
                totalAmountMinor: orders.totalAmountMinor,
                paymentTermsDays: orders.paymentTermsDays,
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
                paymentMethod: orderPayments.paymentMethod,
            })
            .from(orderPayments)
            .where(eq(orderPayments.orderId, orderId));
        for (const payment of ledgerRows) {
            assertOrderPaymentCurrency(payment.currency, currency, "Order payment ledger");
        }
        // Source identity is a durable column, not caller-editable metadata. This
        // also recovers legacy unsigned attempts without trusting their flags.
        const depositRefundAmount = orderAttempts.reduce((sum, attempt) => {
            const source = ledgerRows.find((payment) => payment.id === attempt.sourcePaymentId);
            const refund = ledgerRows.find((payment) => payment.id === attempt.refundPaymentId);
            if (!source || source.paymentType !== "deposit"
                || source.status !== PaymentRecordStatus.SUCCEEDED
                || !isManualSettlementMethod(source.paymentMethod)) return sum;
            if (!refund || refund.paymentType !== "refund" || refund.amountMinor !== attempt.amountMinor
                || attempt.amountMinor !== source.amountMinor) {
                throw new ValidationError("Manual deposit refund allocation does not match its source payment.");
            }
            return sum + attempt.amountMinor;
        }, 0);
        refundedDepositsByOrder.set(orderId, depositRefundAmount);
        const paymentRows = ledgerRows.map((payment) => ({
            paymentType: payment.paymentType,
            status: refundPaymentIdSet.has(payment.id)
                ? PaymentRecordStatus.REFUNDED
                : payment.status,
            amountMinor: payment.amountMinor,
        }));
        const paymentState = computePaymentStateFromLedger({
            totalAmountMinor: order.totalAmountMinor,
            deferred: order.paymentTermsDays !== null,
            payments: paymentRows,
            paymentTermsDays: order.paymentTermsDays,
        });
        const nextOrderStatus = getOrderStatusAfterRefund(order.status, paymentState.isFullRefund);
        const shouldReleaseInventory =
            paymentState.isFullRefund &&
            (nextOrderStatus === OrderStatus.CANCELLED || order.status === OrderStatus.CANCELLED);

        reconciliationByOrder.set(orderId, {
            order,
            currency,
            paymentRows,
            paymentState,
            nextOrderStatus,
            shouldReleaseInventory,
        });

        // Read the manual-kind payment plan once, before the batch, so it can
        // be guarded and updated atomically.
        const plan = await db
            .select({
                id: paymentPlans.id,
                depositAmountMinor: paymentPlans.depositAmountMinor,
                status: paymentPlans.status,
                kind: paymentPlans.kind,
            })
            .from(paymentPlans)
            .where(and(
                eq(paymentPlans.orderId, orderId),
                eq(paymentPlans.kind, "manual"),
            ))
            .get();
        manualPlansByOrder.set(orderId, plan ?? null);
    }

    // ---- Atomic batch: all order/payment/plan writes in one D1 transaction ----
    const batchStatements: BatchItem<"sqlite">[] = [];

    // Guard 1: order version CAS — each order must still be at the version we read.
    for (const [orderId, reconciliation] of reconciliationByOrder) {
        const { order } = reconciliation;
        batchStatements.push(
            buildBatchGuard(
                db,
                sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${eq(orders.id, orderId)} AND ${eq(orders.version, order.version)})`,
                "REFUND_FINALIZE_ORDER_CONFLICT",
            ),
        );
    }

    // Guard 2: the manual deposit plan must retain the paid status we read.
    for (const [orderId, plan] of manualPlansByOrder) {
        if (plan && (plan.status === PaymentPlanStatus.DEPOSIT_PAID || plan.status === PaymentPlanStatus.COMPLETED)) {
            batchStatements.push(
                buildBatchGuard(
                    db,
                    sql`EXISTS (SELECT 1 FROM ${paymentPlans} WHERE ${eq(paymentPlans.orderId, orderId)} AND ${eq(paymentPlans.kind, "manual")} AND ${eq(paymentPlans.status, plan.status)})`,
                    "REFUND_FINALIZE_PLAN_CONFLICT",
                ),
            );
        }
    }

    // orderPayments → REFUNDED (bulk, all refunded payments at once).
    batchStatements.push(
        db.update(orderPayments).set({
            status: PaymentRecordStatus.REFUNDED,
            updatedAt: sql`unixepoch()`,
        }).where(inJsonArray(orderPayments.id, refundPaymentIds)),
    );

    // Per-order: orders CAS update (paid/balance/paymentStatus/status/version).
    for (const [orderId, reconciliation] of reconciliationByOrder) {
        const { order, paymentState, nextOrderStatus } = reconciliation;
        batchStatements.push(
            db.update(orders).set({
                paidAmountMinor: paymentState.paidAmountMinor,
                balanceDueMinor: paymentState.balanceDueMinor,
                paymentStatus: paymentState.paymentStatus,
                ...(nextOrderStatus ? { status: nextOrderStatus } : {}),
                version: sql`${orders.version} + 1`,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orders.id, orderId),
                eq(orders.version, order.version),
            )),
        );
    }

    // Cancel from the accepted allocation's durable source relationship, not
    // its metadata marker. Historical unsigned attempts use the same proof;
    // stripping a signature cannot turn another source into a deposit.
    for (const orderId of reconciliationByOrder.keys()) {
        const plan = manualPlansByOrder.get(orderId);
        const refundedDeposit = refundedDepositsByOrder.get(orderId) ?? 0;
        if (plan && refundedDeposit > 0 && refundedDeposit !== plan.depositAmountMinor) {
            throw new ValidationError("Manual deposit refund must equal the full deposit amount.");
        }
        const manualDepositRefund = refundedDeposit > 0;
        if (plan && plan.kind === "manual" && (plan.status === PaymentPlanStatus.DEPOSIT_PAID || plan.status === PaymentPlanStatus.COMPLETED) && manualDepositRefund) {
            batchStatements.push(
                db.update(paymentPlans).set({
                    status: PaymentPlanStatus.CANCELLED,
                    cancelledAt: sql`unixepoch()`,
                    updatedAt: sql`unixepoch()`,
                }).where(and(
                    eq(paymentPlans.id, plan.id),
                    eq(paymentPlans.status, plan.status),
                )),
            );
        }
    }

    // refundAttempts → "refunded" (bulk).
    batchStatements.push(
        db.update(refundAttempts).set({
            status: "refunded",
            claimId: null,
            claimExpiresAt: null,
            refundedAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }).where(inJsonArray(refundAttempts.id, uniqueAttemptIds)),
    );

    await safeBatch(db, batchStatements);

    // ---- Inventory release: separate from the atomic batch ----
    // applyInventoryForStatusChangeWithImpact calls safeBatch() internally and
    // cannot be nested inside an outer db.batch(). If it fails, the order and
    // plan are already finalized; fulfilment guards block progression regardless
    // of inventory state. A subsequent shipment reconciliation
    // (reconcile.ts → reconcileInventoryForStatus → applyInventoryForStatusChangeWithImpact)
    // can retry the failed release through a reachable execution path.
    const finalizedOrderIds = new Set<string>();
    const availabilityTransitionVariantIds = new Set<string>();
    for (const [orderId, reconciliation] of reconciliationByOrder) {
        if (reconciliation.shouldReleaseInventory) {
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
    }

    // Refund notifications (derived from attempts, no DB writes needed).
    const refundNotifications: RefundNotificationFact[] = [];
    for (const orderId of reconciliationByOrder.keys()) {
        const orderAttempts = attempts.filter((attempt) => attempt.orderId === orderId);
        const reconciliation = reconciliationByOrder.get(orderId)!;
        const { currency } = reconciliation;
        const notificationAttemptIds = orderAttempts.map((attempt) => attempt.id);
        const notificationRefundIds = orderAttempts
            .map((attempt) => attempt.providerRefundId)
            .filter((refundId): refundId is string => Boolean(refundId));
        refundNotifications.push({
            orderId,
            notificationType: reconciliation.paymentState.isFullRefund ? "order_refunded" : "order_partially_refunded",
            dedupeKey: buildReconciledRefundNotificationDedupeKey(
                orderId,
                notificationAttemptIds,
                reconciliation.paymentState.isFullRefund,
            ),
            amount: fromMinor(
                orderAttempts.reduce((sum, attempt) => sum + attempt.amountMinor, 0),
                currency.decimalPlaces,
            ),
            refundId: notificationRefundIds.join(",") || undefined,
        });
    }

    return {
        orderIds: [...finalizedOrderIds],
        finalizedAttemptIds: uniqueAttemptIds,
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

/** Builds refund attempt metadata with optional HMAC integrity protection. */
export async function buildRefundAttemptMetadata(params: {
    request: RefundRequest;
    allocation: RefundAllocation;
    groupId: string;
    claimVersion: number;
    allocationCount: number;
    /** Durable flag: true when this refund fully repays a manual COD deposit.
     * Survives async finalization, retries and crash recovery — not just an
     * in-memory parameter that would be lost across process restarts. */
    manualDepositRefund?: boolean;
    /** Master secret for HMAC derivation. Optional; if not provided, no HMAC is added. */
    masterSecret?: string;
}): Promise<string> {
    const mode = allocationSettlementMode(params.allocation);
    const payload = {
        reason: params.request.reason,
        gateway: params.allocation.sourcePayment.paymentMethod,
        ...(isInternalSettlement(mode) ? {
            settlementMode: mode,
            giftCardId: params.allocation.giftCardId,
        } : mode === "manual_external" ? {
            settlementMode: "manual_external",
            manualSettlementConfirmed: params.request.manualSettlementConfirmed === true,
        } : {}),
        ...(params.manualDepositRefund === true ? { manualDepositRefund: true } : {}),
        refundGroupId: params.groupId,
        claimVersion: params.claimVersion,
        sourcePaymentId: params.allocation.sourcePayment.id,
        sourcePaymentType: params.allocation.sourcePayment.paymentType,
        allocationIndex: params.allocation.index,
        allocationCount: params.allocationCount,
    };
    // Add HMAC if master secret is provided
    if (params.masterSecret) {
        const trimmedSecret = params.masterSecret.trim();
        const key = await deriveRuntimeSecret(trimmedSecret, RUNTIME_SECRET_PURPOSES.REFUND_METADATA_HMAC);
        const encoder = new TextEncoder();
        const cryptoKey = await crypto.subtle.importKey(
            "raw",
            encoder.encode(key),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
        );
        const payloadStr = JSON.stringify(payload);
        const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payloadStr));
        const hmac = btoa(String.fromCharCode(...new Uint8Array(signature)))
            .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
        return JSON.stringify({ ...payload, _hmac: hmac });
    }
    return JSON.stringify(payload);
}

async function buildRefundAttemptInsert(params: {
    request: RefundRequest;
    allocation: RefundAllocation;
    groupId: string;
    claimVersion: number;
    allocationCount: number;
    requestHash: string;
    currency: string;
    manualDepositRefund?: boolean;
    masterSecret?: string;
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
        metadata: await buildRefundAttemptMetadata({
            request: params.request,
            allocation: params.allocation,
            groupId: params.groupId,
            claimVersion: params.claimVersion,
            allocationCount: params.allocationCount,
            manualDepositRefund: params.manualDepositRefund,
            masterSecret: params.masterSecret,
        }),
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
    if (isManualSettlementMethod(allocation.sourcePayment.paymentMethod)) return null;
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
    encryptionKey: string | undefined,
    providers: PaymentProvidersSource | undefined,
): Promise<string | undefined> {
    if (isManualSettlementMethod(payment.paymentMethod)) return undefined;
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
const REFUND_CLAIM_CONFLICT = "refund_claim_conflict";
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
export async function processRefund(
    db: Database,
    params: RefundRequest,
    encryptionKey?: string,
    /** The request's gateways (built-in and app providers); built-in ones alone by default. */
    providers?: PaymentProvidersSource,
    /** The master secret (SCALIUS_SECRET) for deriving HMAC keys. Optional; if not provided, HMAC is not used. */
    masterSecret?: string,
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
    const paymentLedgerRows = await db
        .select()
        .from(orderPayments)
        .where(eq(orderPayments.orderId, params.orderId))
        // Newest first, id breaking a same-second tie: the refund order `listRefundSources()` previews.
        .orderBy(desc(orderPayments.createdAt), desc(orderPayments.id));
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
    if (settlement === "store_credit" && (params.caller ?? "app") !== "staff"
        && allocations.some((allocation) => isManualSettlementMethod(allocation.sourcePayment.paymentMethod))) {
        // Store credit over money no provider captured would mint a live
        // gift card from a claim (an app's own "bank transfer").
        throw new ValidationError(
            "Store credit for a cash-on-delivery or recorded payment can only be issued by staff in the dashboard. Refund it to the original payment instead.",
            { reason: STORE_CREDIT_NEEDS_STAFF_REASON },
        );
    }
    // A manual COD deposit plan must exist and be DEPOSIT_PAID for this to be
    // a deposit refund. Reading the plan here (before the claim batch) also
    // lets us validate against plan.depositAmountMinor instead of
    // order.paidAmountMinor, which may include COD balance payments collected
    // after the deposit.
    const manualDepositPlan = await db
        .select({
            id: paymentPlans.id,
            depositAmountMinor: paymentPlans.depositAmountMinor,
            status: paymentPlans.status,
        })
        .from(paymentPlans)
        .where(and(
            eq(paymentPlans.orderId, params.orderId),
            eq(paymentPlans.kind, "manual"),
        ))
        .get();
    const depositAllocations = allocations.filter((allocation) =>
        allocation.sourcePayment.paymentType === "deposit"
            && isManualSettlementMethod(allocation.sourcePayment.paymentMethod),
    );
    const totalDepositRefundAmount = depositAllocations.reduce((sum, a) => sum + a.amountMinor, 0);
    const hasManualCodAllocation = manualDepositPlan !== undefined
        && (manualDepositPlan.status === PaymentPlanStatus.DEPOSIT_PAID || manualDepositPlan.status === PaymentPlanStatus.COMPLETED)
        && depositAllocations.length > 0;
    // Any manual settlement allocation on a manual COD order requires confirmation.
    const hasManualAllocationOnManualCod = manualDepositPlan !== undefined
        && (manualDepositPlan.status === PaymentPlanStatus.DEPOSIT_PAID || manualDepositPlan.status === PaymentPlanStatus.COMPLETED)
        && allocations.some((allocation) => isManualSettlementMethod(allocation.sourcePayment.paymentMethod));
    // A manual COD deposit can only be refunded in full — the total amount
    // allocated to the deposit must exactly equal the plan's depositAmountMinor.
    // This prevents partial deposit refunds and double-counting across attempts.
    // Validate the amount first so partial refunds are rejected on amount
    // regardless of settlement type.
    if (hasManualCodAllocation && manualDepositPlan && totalDepositRefundAmount !== manualDepositPlan.depositAmountMinor) {
        throw new ValidationError(
            "Partial refunds of a manual COD deposit are not supported. The deposit allocation must equal the full deposit amount.",
        );
    }
    if (hasManualAllocationOnManualCod && params.manualSettlementConfirmed !== true) {
        throw new ValidationError(
            "Confirm that the customer has already received the refund by hand (cash or transfer) before recording it.",
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

    // Pre-compute refund attempt metadata with HMAC for all allocations.
    // This must be done before the batch since HMAC derivation is async.
    const refundAttemptMetadata = await Promise.all(
        allocations.map((allocation) =>
            buildRefundAttemptMetadata({
                request: params,
                allocation,
                groupId: refundGroupId,
                claimVersion,
                allocationCount: allocations.length,
                manualDepositRefund: hasManualCodAllocation
                    && allocation.sourcePayment.paymentType === "deposit"
                    && isManualSettlementMethod(allocation.sourcePayment.paymentMethod),
                masterSecret,
            })
        )
    );
    const refundAttemptMetadataByAllocationId = new Map(
        allocations.map((allocation, index) => [allocation.id, refundAttemptMetadata[index]!])
    );

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
            ...allocations.flatMap((allocation) => {
                const mode = allocationSettlementMode(allocation);
                const internal = isInternalSettlement(mode);
                const attemptId = getRefundAttemptId(allocation);
                const attemptKey = getRefundAttemptKeyForRequest(params, allocation);
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
                    db.insert(refundAttempts).values({
                        id: attemptId,
                        attemptKey,
                        refundGroupId,
                        orderId: params.orderId,
                        sourcePaymentId: allocation.sourcePayment.id,
                        refundPaymentId: allocation.id,
                        gateway: allocation.sourcePayment.paymentMethod,
                        amountMinor: allocation.amountMinor,
                        currency: currency.code,
                        reason: params.reason,
                        requestHash: refundRequestHash,
                        providerIdempotencyKey: allocation.idempotencyKey,
                        refundReference: allocation.refundReference,
                        allocationIndex: allocation.index,
                        allocationCount: allocations.length,
                        sourceTransactionId: getRefundAttemptSourceTransactionId(allocation),
                        ...(internal
                            ? {
                                status: "processing" as const,
                                attempts: 1,
                                providerStatus: INTERNAL_REFUND_PROVIDER_STATUSES[mode],
                                responsePayload: JSON.stringify({ settlementMode: mode, giftCardId: allocation.giftCardId ?? null }),
                            }
                            : { status: "pending" as const }),
                        claimId: refundGroupId,
                        claimExpiresAt: sql`unixepoch() + ${REFUND_ATTEMPT_LEASE_SECONDS}`,
                        metadata: refundAttemptMetadataByAllocationId.get(allocation.id)!,
                        createdAt: sql`unixepoch()`,
                        updatedAt: sql`unixepoch()`,
                    }),
                    // Credit back to the tender's card, keyed by the attempt key (G5).
                    ...(mode === "gift_card" ? [buildGiftCardRefundStatement(db, {
                        giftCardId: allocation.giftCardId!,
                        // The card's own currency: its share of the tender's debit.
                        amountMinor: giftCardRefundCreditMinor(allocation.sourcePayment, allocation.amountMinor),
                        orderId: params.orderId,
                        orderPaymentId: allocation.id,
                        refundAttemptId: attemptId,
                        idempotencyKey: attemptKey,
                        actor,
                        reason: ledgerReason,
                    })] : []),
                ];
            }),
            // One new card for the whole refund, after the attempt it belongs to.
            ...(storeCredit?.statements ?? []),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        ] as any);
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
                providers,
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
                    masterSecret,
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
            masterSecret,
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
        availabilityTransitionVariantIds,
        refundNotification: {
            notificationType: refundNotification.notificationType,
            dedupeKey: refundNotification.dedupeKey,
            amount: refundNotification.amount,
            refundId: refundNotification.refundId,
        },
    };
}
