// src/lib/payment/polar.ts
// SDK wrapper for the Polar.sh payment gateway.
// Pattern mirrors stripe.ts / sslcommerz.ts — thin wrappers around API calls.

import { Polar } from "@polar-sh/sdk";
import { Webhook } from "standardwebhooks";
import type { PolarSettings } from "./gateway-settings";
import type { CreatePolarCheckoutParams, PolarCheckoutResult, PolarRefundParams, PolarRefundResult } from "./types";

// ---------------------------------------------------------------------------
// Client factory (one instance per set of credentials)
// ---------------------------------------------------------------------------

let _cachedClient: Polar | null = null;
let _cachedToken: string | null = null;

function getPolarClient(settings: PolarSettings): Polar {
    // Reuse client if credentials haven't changed
    if (_cachedClient && _cachedToken === settings.accessToken) {
        return _cachedClient;
    }

    _cachedClient = new Polar({
        accessToken: settings.accessToken,
        server: settings.sandbox ? "sandbox" : "production",
    });
    _cachedToken = settings.accessToken;
    return _cachedClient;
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

        const checkout = await client.checkouts.create({
            products: [settings.productId],
            prices: {
                [settings.productId]: [
                    {
                        amountType: "fixed",
                        priceAmount: params.amount, // Already in cents
                        priceCurrency: params.currency as any, // Cast: Polar SDK expects PresentmentCurrency enum
                    },
                ],
            },
            successUrl: params.successUrl,
            metadata: {
                orderId: params.orderId,
                paymentType: params.paymentType,
                ...(params.metadata ?? {}),
            },
            ...(params.customerEmail ? { customerEmail: params.customerEmail } : {}),
            ...(params.customerName ? { customerName: params.customerName } : {}),
        });

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
    } catch (error) {
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
            reason: params.reason as any,
            comment: params.comment,
        });

        return {
            success: true,
            refundId: refund.id,
        };
    } catch (error) {
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
    } catch (error) {
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
