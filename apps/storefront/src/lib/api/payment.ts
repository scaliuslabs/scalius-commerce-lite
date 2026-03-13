// src/lib/api/payment.ts
// Storefront-side payment gateway integrations.

import { createApiUrl, fetchWithRetry } from "./client";

export interface StripeIntentResult {
  clientSecret: string;
  paymentIntentId: string;
  publishableKey: string;
}

export interface SSLCommerzSessionResult {
  gatewayUrl: string;
  sessionKey: string;
}

/**
 * Create a Stripe PaymentIntent for a given order.
 */
export async function createStripeIntent(orderId: string, amount: number, currency = "bdt"): Promise<StripeIntentResult> {
  const res = await fetchWithRetry(createApiUrl("/payment/stripe/intent"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, amount, currency, type: "full" }),
  });

  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(err.error || "Failed to create payment intent");
  }

  const data = await res.json() as any;
  return {
    clientSecret: data.clientSecret,
    paymentIntentId: data.paymentIntentId,
    publishableKey: data.publishableKey,
  };
}

/**
 * Initialize SSLCommerz payment session and get redirect URL.
 */
export async function initSSLCommerzPayment(
  orderId: string,
  amount: number,
  customerName: string,
  customerEmail: string,
  customerPhone: string,
  successUrl: string,
  failUrl: string,
  cancelUrl: string,
  currency = "BDT",
): Promise<SSLCommerzSessionResult> {
  const res = await fetchWithRetry(createApiUrl("/payment/sslcommerz/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderId,
      amount,
      currency,
      customerName,
      customerEmail,
      customerPhone,
      successUrl,
      failUrl,
      cancelUrl,
    }),
  });

  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(err.error || "Failed to initialize payment");
  }

  const data = await res.json() as any;
  return { gatewayUrl: data.gatewayUrl, sessionKey: data.sessionKey };
}
