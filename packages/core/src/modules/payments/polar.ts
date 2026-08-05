// src/modules/payments/polar.ts
// SDK wrapper for the Polar.sh payment gateway.
// Pattern mirrors stripe.ts / sslcommerz.ts — thin wrappers around API calls.

import { Polar } from "@polar-sh/sdk";
import { Webhook } from "standardwebhooks";
import { and, eq, sql } from "drizzle-orm";
import {
    orderPayments,
    orders,
    OrderStatus,
    PaymentRecordStatus,
    PaymentStatus,
    type OrderPayment,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { PolarSettings } from "./gateway-settings";
import type {
    CreatePolarCheckoutParams,
    FindReusablePolarCheckoutParams,
    PolarCheckoutResult,
    PolarRefundParams,
    PolarRefundResult,
} from "./types";
import type {
  PaymentProvider,
  CreatePaymentParams,
  CreatePaymentResult,
  RefundParams,
  RefundResult,
  WebhookPayload,
} from "./provider";
import { ServiceUnavailableError, ValidationError } from "@scalius/core/errors";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import { canTransitionTo } from "../orders/order-state-machine";
import { hasActiveShipmentClaim, SHIPMENT_CLAIM_CONFLICT_MESSAGE } from "../orders/shipment-claim";
import { computeOrderPaymentState } from "./payment-state";
import {
    assertOrderPaymentCurrency,
    orderMoneyEqual,
    resolveOrderCurrencySnapshot,
    roundOrderMoney,
    type OrderCurrencySnapshot,
} from "./order-currency";

// ---------------------------------------------------------------------------
// Request-scoped client factory
// ---------------------------------------------------------------------------

const POLAR_CHECKOUT_RECOVERY_LIMIT = 100;
const POLAR_ATTEMPT_METADATA_KEY = "scaliusPaymentAttemptKey";

function getPolarClient(settings: PolarSettings): Polar {
    const server = settings.sandbox ? "sandbox" : "production";
    return new Polar({
        accessToken: settings.accessToken,
        server,
    });
}

function isProviderTimeoutError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    if (!error || typeof error !== "object") return false;
    const maybeError = error as { name?: unknown; message?: unknown; code?: unknown };
    const name = typeof maybeError.name === "string" ? maybeError.name.toLowerCase() : "";
    const code = typeof maybeError.code === "string" ? maybeError.code.toLowerCase() : "";
    const message = typeof maybeError.message === "string" ? maybeError.message.toLowerCase() : "";
    return (
        name.includes("timeout") ||
        name.includes("abort") ||
        code.includes("timeout") ||
        code.includes("abort") ||
        message.includes("timed out") ||
        message.includes("timeout") ||
        message.includes("aborted")
    );
}

// ---------------------------------------------------------------------------
// Create Checkout Session
// ---------------------------------------------------------------------------

/**
 * Create a Polar checkout session with ad-hoc pricing.
 *
 * Polar requires a Product to exist on their platform. We use ad-hoc pricing
 * to pass our exact order amount for each checkout — the product is just a
 * container that satisfies Polar's API requirement.
 */
export async function createPolarCheckout(
    settings: PolarSettings,
    params: CreatePolarCheckoutParams
): Promise<PolarCheckoutResult> {
    try {
        const client = getPolarClient(settings);

        const checkout = await client.checkouts.create(
            {
                products: [settings.productId],
                prices: {
                    [settings.productId]: [
                        {
                            amountType: "fixed",
                            priceAmount: params.amount, // Already in cents
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Polar SDK expects PresentmentCurrency enum
                            priceCurrency: params.currency as any, // Cast: Polar SDK expects PresentmentCurrency enum
                        },
                    ],
                },
                successUrl: params.successUrl,
                ...(params.cancelUrl ? { returnUrl: params.cancelUrl } : {}),
                metadata: {
                    orderId: params.orderId,
                    paymentType: params.paymentType,
                    ...(params.idempotencyKey ? { [POLAR_ATTEMPT_METADATA_KEY]: params.idempotencyKey } : {}),
                    ...(params.metadata ?? {}),
                },
                ...(params.customerId ? { externalCustomerId: params.customerId } : {}),
                ...(params.customerEmail ? { customerEmail: params.customerEmail } : {}),
                ...(params.customerName ? { customerName: params.customerName } : {}),
            },
            {
                retries: { strategy: "none" },
                ...(params.requestTimeoutMs ? { timeoutMs: params.requestTimeoutMs } : {}),
                ...(params.signal ? { signal: params.signal } : {}),
            },
        );

        if (!checkout.url) {
            return {
                success: false,
                error: "Polar did not return a checkout URL",
            };
        }

        return {
            success: true,
            checkoutUrl: checkout.url,
            checkoutId: checkout.id,
        };
    } catch (error: unknown) {
        if (isProviderTimeoutError(error, params.signal)) {
            return {
                success: false,
                error: "Polar did not respond before the payment timeout. Please try again.",
                timedOut: true,
            };
        }
        console.error("[Polar] Error creating checkout session:", error);
        return {
            success: false,
            error:
                error instanceof Error ? error.message : "Unknown Polar API error",
        };
    }
}

export async function findReusablePolarCheckout(
    settings: PolarSettings,
    params: FindReusablePolarCheckoutParams,
): Promise<PolarCheckoutResult | null> {
    try {
        const client = getPolarClient(settings);
        const pageIterator = await client.checkouts.list(
            {
                productId: params.productId,
                status: "open",
                limit: POLAR_CHECKOUT_RECOVERY_LIMIT,
                sorting: ["-created_at"],
                ...(params.customerId ? { externalCustomerId: params.customerId } : {}),
                ...(!params.customerId && params.customerEmail ? { query: params.customerEmail } : {}),
            },
            {
                retries: { strategy: "none" },
                ...(params.requestTimeoutMs ? { timeoutMs: params.requestTimeoutMs } : {}),
                ...(params.signal ? { signal: params.signal } : {}),
            },
        );

        for await (const page of pageIterator) {
            for (const checkout of page.result.items) {
                if (!isReusablePolarCheckout(checkout, params)) continue;
                return {
                    success: true,
                    checkoutUrl: checkout.url,
                    checkoutId: checkout.id,
                    recovered: true,
                };
            }
            break;
        }

        return null;
    } catch (error: unknown) {
        if (isProviderTimeoutError(error, params.signal)) {
            return {
                success: false,
                error: "Polar checkout recovery did not respond before the payment timeout. Please try again.",
                timedOut: true,
            };
        }
        console.error("[Polar] Error looking up reusable checkout session:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown Polar checkout recovery error",
        };
    }
}

function isReusablePolarCheckout(
    checkout: {
        id?: string;
        url?: string;
        amount?: number;
        currency?: string;
        productId?: string | null;
        metadata?: Record<string, unknown>;
    },
    params: FindReusablePolarCheckoutParams,
): checkout is { id: string; url: string; metadata: Record<string, unknown> } {
    const metadata = checkout.metadata ?? {};
    return (
        Boolean(checkout.id) &&
        Boolean(checkout.url) &&
        checkout.productId === params.productId &&
        checkout.amount === params.amount &&
        checkout.currency?.toLowerCase() === params.currency.toLowerCase() &&
        metadata[POLAR_ATTEMPT_METADATA_KEY] === params.idempotencyKey &&
        metadata.orderId === params.orderId &&
        metadata.paymentType === params.paymentType
    );
}

// ---------------------------------------------------------------------------
// Create Refund
// ---------------------------------------------------------------------------

/**
 * Creates a refund in Polar.
 * Refunds the specified amount, or the full amount if omitted.
 */
export async function createPolarRefund(
    settings: PolarSettings,
    params: PolarRefundParams
): Promise<PolarRefundResult> {
    try {
        const client = getPolarClient(settings);

        const refund = await client.refunds.create({
            orderId: params.polarOrderId,
            amount: params.amount,
            reason: params.reason ?? "customer_request",
            comment: params.comment,
            metadata: params.metadata,
        });

        return {
            success: true,
            refundId: refund.id,
        };
    } catch (error: unknown) {
        console.error("[Polar] Error creating refund:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown Polar API error",
        };
    }
}

export interface PolarRefundSnapshot {
    id: string;
    status: string;
    amount: number;
    currency: string;
    orderId: string;
    metadata: Record<string, string | number | boolean>;
}

export async function listPolarRefunds(
    settings: PolarSettings,
    filters: { id?: string; orderId?: string; limit?: number },
): Promise<{ success: boolean; refunds?: PolarRefundSnapshot[]; error?: string }> {
    try {
        const client = getPolarClient(settings);
        const limit = Math.max(1, Math.min(100, Math.floor(filters.limit ?? 10)));
        const refunds: PolarRefundSnapshot[] = [];
        const pageIterator = await client.refunds.list({
            ...(filters.id ? { id: filters.id } : {}),
            ...(filters.orderId ? { orderId: filters.orderId } : {}),
            limit,
        });

        for await (const page of pageIterator) {
            for (const refund of page.result.items) {
                refunds.push({
                    id: refund.id,
                    status: refund.status,
                    amount: refund.amount,
                    currency: refund.currency,
                    orderId: refund.orderId,
                    metadata: refund.metadata,
                });
                if (refunds.length >= limit) break;
            }
            if (refunds.length >= limit) break;
        }

        return { success: true, refunds };
    } catch (error: unknown) {
        console.error("[Polar] Error listing refunds:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown Polar API error",
        };
    }
}
// ---------------------------------------------------------------------------

/**
 * Verify and parse a Polar webhook payload.
 *
 * Polar uses the standardwebhooks library for signature verification.
 * The webhook secret must be base64-encoded before passing to the Webhook
 * constructor (Polar provides a raw string starting with `polar_whs_`).
 */
export function verifyPolarWebhook(
    rawBody: string,
    headers: Record<string, string>,
    webhookSecret: string
): { verified: true; payload: PolarWebhookPayload } | { verified: false; error: string } {
    try {
        // Polar docs: the secret must be base64-encoded before use
        const base64Secret = btoa(webhookSecret);
        const wh = new Webhook(base64Secret);
        const payload = wh.verify(rawBody, headers) as PolarWebhookPayload;

        return { verified: true, payload };
    } catch (error: unknown) {
        return {
            verified: false,
            error: error instanceof Error ? error.message : "Webhook verification failed",
        };
    }
}

// ---------------------------------------------------------------------------
// Webhook Types
// ---------------------------------------------------------------------------

export interface PolarWebhookPayload {
    id?: string;
    type: string;
    data: {
        id: string;
        status: string;
        metadata?: Record<string, string>;
        amount?: number;
        currency?: string;
        customer_email?: string;
        [key: string]: unknown;
    };
}

// ---------------------------------------------------------------------------
// Webhook-driven refund processing
// ---------------------------------------------------------------------------

const PRE_FULFILLMENT_REFUND_STATUSES = new Set<string>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.CONFIRMED,
]);

function getOrderStatusAfterWebhookRefund(currentStatus: string, isFullRefund: boolean): string | undefined {
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

function shouldReleaseInventoryForWebhookRefund(currentStatus: string, nextStatus: string | undefined): boolean {
    return nextStatus === OrderStatus.CANCELLED && PRE_FULFILLMENT_REFUND_STATUSES.has(currentStatus);
}

export interface PolarWebhookRefundParams {
    orderId: string;
    /** Polar checkout/order id that maps to the local succeeded Polar payment row. */
    polarCheckoutId: string;
    /** Cumulative refunded amount from Polar, in smallest currency unit (cents). */
    amountRefunded: number;
    /** Original total amount from Polar, in smallest currency unit (cents). */
    totalAmount: number;
    currency: string;
    /** Polar order status: "refunded" (full) or "partially_refunded". */
    polarStatus: string;
}

export interface PolarWebhookRefundNotification {
    notificationType: "order_refunded" | "order_partially_refunded";
    dedupeKey: string;
    data: {
        gateway: "polar";
        polarStatus: string;
        amountRefunded: number;
        totalAmount: number;
        currency: string;
        localRefundAmount: number;
    };
}

export type PolarWebhookRefundResult =
    | { success: true; notification?: PolarWebhookRefundNotification }
    | { success: false; error: string };

type PolarPaymentLedgerRow = Pick<
    OrderPayment,
    "id" | "amount" | "currency" | "paymentMethod" | "paymentType" | "status" | "polarCheckoutId" | "metadata"
>;

function parsePaymentMetadata(metadata: string | null): Record<string, unknown> {
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

function isCapturedPaymentRow(payment: Pick<OrderPayment, "paymentType" | "status">): boolean {
    return payment.paymentType !== "refund" && payment.status === PaymentRecordStatus.SUCCEEDED;
}

function isRefundedPaymentRow(payment: Pick<OrderPayment, "paymentType" | "status">): boolean {
    return payment.paymentType === "refund" && payment.status === PaymentRecordStatus.REFUNDED;
}

function isRefundForSourcePayment(
    refund: Pick<OrderPayment, "paymentType" | "status" | "metadata">,
    sourcePaymentId: string,
): boolean {
    if (!isRefundedPaymentRow(refund)) return false;
    return parsePaymentMetadata(refund.metadata).sourcePaymentId === sourcePaymentId;
}

function computeLedgerPaymentState(params: {
    totalAmount: number;
    payments: Array<Pick<OrderPayment, "paymentType" | "status" | "amount">>;
    pendingRefundAmount?: number;
    currency: OrderCurrencySnapshot;
}) {
    const capturedAmount = roundOrderMoney(params.payments
        .filter(isCapturedPaymentRow)
        .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0), params.currency);
    const refundedAmount = roundOrderMoney(params.payments
        .filter(isRefundedPaymentRow)
        .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0) + (params.pendingRefundAmount ?? 0), params.currency);
    const paidAmount = roundOrderMoney(Math.max(0, capturedAmount - refundedAmount), params.currency);
    const isFullRefund = capturedAmount > 0 && (
        orderMoneyEqual(paidAmount, 0, params.currency) || refundedAmount >= capturedAmount
    );

    if (isFullRefund) {
        return {
            capturedAmount,
            refundedAmount,
            isFullRefund,
            paidAmount: 0,
            balanceDue: roundOrderMoney(params.totalAmount, params.currency),
            paymentStatus: PaymentStatus.REFUNDED,
        };
    }

    return {
        capturedAmount,
        refundedAmount,
        isFullRefund,
        ...computeOrderPaymentState({
            totalAmount: params.totalAmount,
            paidAmount,
            paymentStatus: paidAmount < capturedAmount ? PaymentStatus.PARTIAL : undefined,
            currency: params.currency,
        }),
    };
}

function buildPolarExternalRefundPaymentId(params: PolarWebhookRefundParams): string {
    const safeOrderId = params.orderId.replace(/[^A-Za-z0-9_-]/g, "");
    const safeCheckoutId = params.polarCheckoutId.replace(/[^A-Za-z0-9_-]/g, "");
    const safeCurrency = params.currency.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    return `refund_polar_external_${safeOrderId}_${safeCheckoutId}_${params.amountRefunded}_${safeCurrency}`.slice(0, 240);
}

function buildPolarExternalRefundMetadata(params: {
    sourcePayment: PolarPaymentLedgerRow;
    webhook: PolarWebhookRefundParams;
    localRefundAmount: number;
}): string {
    return JSON.stringify({
        source: "polar_webhook",
        gateway: "polar",
        sourcePaymentId: params.sourcePayment.id,
        sourcePaymentType: params.sourcePayment.paymentType,
        sourceTransactionId: params.sourcePayment.polarCheckoutId,
        polarCheckoutId: params.webhook.polarCheckoutId,
        polarStatus: params.webhook.polarStatus,
        amountRefunded: params.webhook.amountRefunded,
        totalAmount: params.webhook.totalAmount,
        gatewayCurrency: params.webhook.currency.toLowerCase(),
        localRefundAmount: params.localRefundAmount,
        providerOutcome: "accepted",
    });
}

function isConstraintError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /unique|constraint|duplicate/i.test(message);
}

function buildPolarWebhookRefundNotification(
    params: PolarWebhookRefundParams,
    localRefundAmount: number,
    isFullRefund: boolean,
): PolarWebhookRefundNotification {
    const currency = params.currency.toLowerCase();
    const dedupeKey = isFullRefund
        ? `polar-refund:${params.orderId}:full`
        : `polar-refund:${params.orderId}:partial:${params.amountRefunded}:${params.totalAmount}:${currency}`;

    return {
        notificationType: isFullRefund ? "order_refunded" : "order_partially_refunded",
        dedupeKey,
        data: {
            gateway: "polar",
            polarStatus: params.polarStatus,
            amountRefunded: params.amountRefunded,
            totalAmount: params.totalAmount,
            currency,
            localRefundAmount,
        },
    };
}

/**
 * Process a Polar `order.refunded` webhook event.
 *
 * Unlike admin-initiated refunds (which go through refund-service.ts and call
 * the Polar API), this handles refunds that originate FROM Polar (e.g. Polar
 * dashboard refund, dispute auto-refund). The refund has already happened on
 * Polar's side — we just need to update our DB state.
 *
 * 1. Converts the cumulative refunded amount from smallest currency unit to
 *    major unit.
 * 2. Updates order.paidAmount, order.paymentStatus, and order.status when the
 *    order state machine allows a refund/cancel transition.
 * 3. On pre-fulfillment full refund: releases inventory via applyInventoryForStatusChange().
 *
 * Idempotent: uses the Polar order status to determine the correct state.
 * If our order is already marked as REFUNDED, this is a no-op.
 */
export async function processPolarWebhookRefund(
    db: Database,
    params: PolarWebhookRefundParams,
): Promise<PolarWebhookRefundResult> {
    try {
        const order = await db
            .select({
                id: orders.id,
                paidAmount: orders.paidAmount,
                balanceDue: orders.balanceDue,
                paymentStatus: orders.paymentStatus,
                totalAmount: orders.totalAmount,
                status: orders.status,
                inventoryAction: orders.inventoryAction,
                version: orders.version,
                shipmentClaimId: orders.shipmentClaimId,
                shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
                currencyCode: orders.currencyCode,
                currencyDecimalPlaces: orders.currencyDecimalPlaces,
            })
            .from(orders)
            .where(eq(orders.id, params.orderId))
            .get();

        if (!order) {
            return { success: false, error: `Order ${params.orderId} not found` };
        }
        const currency = resolveOrderCurrencySnapshot(order);
        if (hasActiveShipmentClaim(order)) {
            return { success: false, error: SHIPMENT_CLAIM_CONFLICT_MESSAGE };
        }

        const paymentRows = await db
            .select({
                id: orderPayments.id,
                amount: orderPayments.amount,
                currency: orderPayments.currency,
                paymentMethod: orderPayments.paymentMethod,
                paymentType: orderPayments.paymentType,
                status: orderPayments.status,
                polarCheckoutId: orderPayments.polarCheckoutId,
                metadata: orderPayments.metadata,
            })
            .from(orderPayments)
            .where(eq(orderPayments.orderId, params.orderId));
        for (const payment of paymentRows) {
            assertOrderPaymentCurrency(payment.currency, currency, "Polar order payment");
        }

        const sourcePayment = paymentRows.find((payment) =>
            payment.paymentMethod === "polar" &&
            payment.paymentType !== "refund" &&
            payment.polarCheckoutId === params.polarCheckoutId
        );
        if (!sourcePayment) {
            return { success: false, error: `Polar payment ${params.polarCheckoutId} was not found for order ${params.orderId}` };
        }
        if (sourcePayment.status !== PaymentRecordStatus.SUCCEEDED) {
            return { success: false, error: `Polar payment ${params.polarCheckoutId} is not confirmed yet` };
        }

        const sourceRefundedAmount = roundOrderMoney(paymentRows
            .filter((payment) => isRefundForSourcePayment(payment, sourcePayment.id))
            .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0), currency);
        const sourcePaymentAmount = roundOrderMoney(Number(sourcePayment.amount ?? 0), currency);
        const isSourceFullyRefunded = params.polarStatus === "refunded";
        let sourceTargetRefundedAmount: number;
        if (isSourceFullyRefunded) {
            sourceTargetRefundedAmount = sourcePaymentAmount;
        } else if (params.totalAmount > 0) {
            sourceTargetRefundedAmount = roundOrderMoney(
                sourcePaymentAmount * (params.amountRefunded / params.totalAmount),
                currency,
            );
        } else {
            return { success: false, error: "Polar partial refund webhook did not include the original total amount" };
        }
        sourceTargetRefundedAmount = Math.min(sourcePaymentAmount, Math.max(0, sourceTargetRefundedAmount));
        const localRefundAmount = roundOrderMoney(
            Math.max(0, sourceTargetRefundedAmount - sourceRefundedAmount),
            currency,
        );
        const paymentState = computeLedgerPaymentState({
            totalAmount: order.totalAmount,
            payments: paymentRows,
            pendingRefundAmount: localRefundAmount,
            currency,
        });
        const isFullRefund = paymentState.isFullRefund;
        const nextOrderStatus = getOrderStatusAfterWebhookRefund(order.status, isFullRefund);
        const shouldChangeOrderStatus = Boolean(nextOrderStatus && nextOrderStatus !== order.status);

        // Already fully refunded and any allowed order-status transition is complete.
        if (
            isFullRefund &&
            order.paymentStatus === PaymentStatus.REFUNDED &&
            order.status === OrderStatus.CANCELLED &&
            order.inventoryAction !== "deducted" &&
            !shouldChangeOrderStatus
        ) {
            await applyInventoryForStatusChange(db, params.orderId, OrderStatus.CANCELLED);
            return {
                success: true,
                notification: buildPolarWebhookRefundNotification(params, order.paidAmount ?? 0, isFullRefund),
            };
        }

        if (
            isFullRefund &&
            order.paymentStatus === PaymentStatus.REFUNDED &&
            !shouldChangeOrderStatus
        ) {
            return {
                success: true,
                notification: buildPolarWebhookRefundNotification(params, order.paidAmount ?? 0, isFullRefund),
            };
        }

        const refundPaymentId = buildPolarExternalRefundPaymentId(params);
        const existingRefundPayment = paymentRows.find((payment) => payment.id === refundPaymentId);
        const pendingSourceRefund = paymentRows.find((payment) =>
            payment.id !== refundPaymentId &&
            payment.paymentType === "refund" &&
            payment.status === PaymentRecordStatus.PENDING &&
            parsePaymentMetadata(payment.metadata).sourcePaymentId === sourcePayment.id
        );
        if (pendingSourceRefund) {
            return { success: false, error: "A previous Polar external refund is still being reconciled; retry required" };
        }
        if (localRefundAmount <= 0 && !shouldChangeOrderStatus) {
            return { success: true };
        }
        if (localRefundAmount > 0) {
            if (existingRefundPayment) {
                if (!orderMoneyEqual(Number(existingRefundPayment.amount ?? 0), localRefundAmount, currency)) {
                    return { success: false, error: "Existing Polar external refund row amount does not match the webhook refund target" };
                }
            } else {
                try {
                    await db.insert(orderPayments).values({
                        id: refundPaymentId,
                        orderId: params.orderId,
                        amount: localRefundAmount,
                        currency: sourcePayment.currency,
                        paymentMethod: "polar",
                        paymentType: "refund",
                        status: PaymentRecordStatus.PENDING,
                        polarCheckoutId: params.polarCheckoutId,
                        metadata: buildPolarExternalRefundMetadata({
                            sourcePayment,
                            webhook: params,
                            localRefundAmount,
                        }),
                        createdAt: sql`unixepoch()`,
                        updatedAt: sql`unixepoch()`,
                    });
                } catch (error: unknown) {
                    if (isConstraintError(error)) {
                        return { success: false, error: "Polar external refund is already being reconciled; retry required" };
                    }
                    throw error;
                }
            }
        }

        const updateValues = {
            paidAmount: paymentState.paidAmount,
            balanceDue: paymentState.balanceDue,
            paymentStatus: paymentState.paymentStatus,
            ...(shouldChangeOrderStatus ? { status: nextOrderStatus } : {}),
            version: sql`${orders.version} + 1`,
            updatedAt: sql`unixepoch()`,
        };

        const updateResult = await db
            .update(orders)
            .set(updateValues)
            .where(and(
                eq(orders.id, params.orderId),
                eq(orders.version, order.version),
            ))
            .returning({ id: orders.id });

        if (updateResult.length === 0) {
            return { success: false, error: "Order was modified concurrently while applying Polar refund; retry required" };
        }

        if (localRefundAmount > 0) {
            const refundUpdateResult = await db.update(orderPayments).set({
                status: PaymentRecordStatus.REFUNDED,
                updatedAt: sql`unixepoch()`,
            }).where(and(
                eq(orderPayments.id, refundPaymentId),
                eq(orderPayments.status, PaymentRecordStatus.PENDING),
            )).returning({ id: orderPayments.id });

            if (refundUpdateResult.length === 0) {
                return { success: false, error: "Polar external refund row could not be finalized; retry required" };
            }
        }

        // On pre-fulfillment full refund, release reservations (mirrors refund-service.ts behavior).
        // Shipped/delivered/completed refunds do NOT auto-restore stock; returns own that transition.
        if (isFullRefund && shouldReleaseInventoryForWebhookRefund(order.status, nextOrderStatus)) {
            await applyInventoryForStatusChange(db, params.orderId, OrderStatus.CANCELLED);
        }

        return {
            success: true,
            notification: buildPolarWebhookRefundNotification(params, localRefundAmount, isFullRefund),
        };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Polar webhook refund processing error";
        console.error(`[Polar] Webhook refund error for order ${params.orderId}:`, err);
        return { success: false, error: message };
    }
}

// ---------------------------------------------------------------------------
// PaymentProvider implementation
// ---------------------------------------------------------------------------

/**
 * Polar PaymentProvider implementation.
 * Wraps the existing Polar functions behind the unified PaymentProvider interface.
 */
export class PolarProvider implements PaymentProvider {
    readonly type = "polar" as const;
    readonly name = "Polar";

    constructor(private readonly settings: PolarSettings) {}

    async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
        if (!params.successUrl) {
            throw new ValidationError("Polar requires a successUrl");
        }

        const result = await createPolarCheckout(this.settings, {
            orderId: params.orderId,
            amount: params.amount,
            currency: params.currency,
            productId: this.settings.productId,
            paymentType: params.paymentType,
            successUrl: params.successUrl,
            customerName: params.customerName,
            customerEmail: params.customerEmail,
            metadata: params.metadata,
        });

        if (!result.success) {
            throw new ServiceUnavailableError(result.error ?? "Failed to create Polar checkout");
        }

        return {
            transactionId: result.checkoutId,
            redirectUrl: result.checkoutUrl,
        };
    }

    async createRefund(params: RefundParams): Promise<RefundResult> {
        if (!params.transactionId) {
            throw new ValidationError("Polar order ID is required for refunds");
        }

        const reason = params.reason === "duplicate"
            ? "duplicate" as const
            : params.reason === "fraudulent"
                ? "fraudulent" as const
                : "customer_request" as const;

        if (!params.amount || params.amount <= 0) {
            throw new ValidationError("Polar requires an explicit positive refund amount");
        }

        const result = await createPolarRefund(this.settings, {
            polarOrderId: params.transactionId,
            amount: params.amount,
            reason,
            comment: params.metadata?.comment,
            metadata: params.metadata,
        });

        if (!result.success) {
            throw new ServiceUnavailableError(result.error ?? "Failed to create Polar refund");
        }

        return { refundId: result.refundId };
    }

    async verifyWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookPayload> {
        const result = verifyPolarWebhook(rawBody, headers, this.settings.webhookSecret);

        if (!result.verified) {
            throw new ValidationError(result.error ?? "Invalid Polar webhook signature");
        }

        return {
            eventType: result.payload.type,
            data: result.payload.data as Record<string, unknown>,
        };
    }
}
