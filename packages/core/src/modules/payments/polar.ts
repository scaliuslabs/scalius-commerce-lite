// src/modules/payments/polar.ts
// SDK wrapper for the Polar.sh payment gateway.
// Pattern mirrors stripe.ts / sslcommerz.ts — thin wrappers around API calls.

import { Polar } from "@polar-sh/sdk";
import { Webhook } from "standardwebhooks";
import { and, eq, sql } from "drizzle-orm";
import { orders, OrderStatus, PaymentStatus } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { PolarSettings } from "./gateway-settings";
import type { CreatePolarCheckoutParams, PolarCheckoutResult, PolarRefundParams, PolarRefundResult } from "./types";
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
import { getDecimalPlaces } from "@scalius/shared/currency";
import { roundPrice } from "@scalius/shared/price-utils";

// ---------------------------------------------------------------------------
// Client factory (one instance per set of credentials)
// ---------------------------------------------------------------------------

let _cachedClient: Polar | null = null;
let _cachedClientKey: string | null = null;

function getPolarClient(settings: PolarSettings): Polar {
    const server = settings.sandbox ? "sandbox" : "production";
    const clientKey = `${server}:${settings.accessToken}`;

    // Reuse client if credentials haven't changed
    if (_cachedClient && _cachedClientKey === clientKey) {
        return _cachedClient;
    }

    _cachedClient = new Polar({
        accessToken: settings.accessToken,
        server,
    });
    _cachedClientKey = clientKey;
    return _cachedClient;
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
                ...(params.cancelUrl ? { cancelUrl: params.cancelUrl } : {}),
                metadata: {
                    orderId: params.orderId,
                    paymentType: params.paymentType,
                    ...(params.metadata ?? {}),
                },
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
            reason: params.reason as "fraudulent" | "customer_request" | "duplicate" | "other" | "service_disruption" | "satisfaction_guarantee" | "dispute_prevention",
            comment: params.comment,
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
    /** Cumulative refunded amount from Polar, in smallest currency unit (cents). */
    amountRefunded: number;
    /** Original total amount from Polar, in smallest currency unit (cents). */
    totalAmount: number;
    currency: string;
    /** Polar order status: "refunded" (full) or "partially_refunded". */
    polarStatus: string;
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
): Promise<{ success: boolean; error?: string }> {
    try {
        const order = await db
            .select({
                id: orders.id,
                paidAmount: orders.paidAmount,
                paymentStatus: orders.paymentStatus,
                totalAmount: orders.totalAmount,
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
            return { success: false, error: `Order ${params.orderId} not found` };
        }
        if (hasActiveShipmentClaim(order)) {
            return { success: false, error: SHIPMENT_CLAIM_CONFLICT_MESSAGE };
        }

        const isFullRefund = params.polarStatus === "refunded";
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
            return { success: true };
        }

        if (
            isFullRefund &&
            order.paymentStatus === PaymentStatus.REFUNDED &&
            !shouldChangeOrderStatus
        ) {
            return { success: true };
        }

        // For currency-converted payments (e.g. BDT→USD), the refunded amount from
        // Polar is in the gateway currency (USD cents), but order.paidAmount is in
        // store currency (BDT). Use the ratio of refunded/total to calculate the
        // local-currency refund amount. This works universally regardless of whether
        // currency conversion happened (ratio is the same in any currency).
        let newPaidAmount: number;
        if (isFullRefund) {
            newPaidAmount = 0;
        } else if (params.totalAmount > 0) {
            const refundRatio = params.amountRefunded / params.totalAmount;
            const localRefundAmount = roundPrice((order.paidAmount ?? 0) * refundRatio);
            newPaidAmount = roundPrice(Math.max(0, (order.paidAmount ?? 0) - localRefundAmount));
        } else {
            // Fallback: direct conversion (only correct when currencies match)
            const decimals = getDecimalPlaces(params.currency);
            const refundedMajor = roundPrice(params.amountRefunded / Math.pow(10, decimals));
            newPaidAmount = roundPrice(Math.max(0, (order.paidAmount ?? 0) - refundedMajor));
        }

        const newPaymentStatus = isFullRefund
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIAL;

        const updateValues = {
            paidAmount: isFullRefund ? 0 : newPaidAmount,
            paymentStatus: newPaymentStatus,
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

        // On pre-fulfillment full refund, release reservations (mirrors refund-service.ts behavior).
        // Shipped/delivered/completed refunds do NOT auto-restore stock; returns own that transition.
        if (isFullRefund && shouldReleaseInventoryForWebhookRefund(order.status, nextOrderStatus)) {
            await applyInventoryForStatusChange(db, params.orderId, OrderStatus.CANCELLED);
        }

        return { success: true };
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
