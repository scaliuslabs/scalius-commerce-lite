// src/pages/api/checkout/stripe-intent.ts
// Server-side proxy: creates a Stripe PaymentIntent via the public backend route.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { fetchWithRetry, createApiUrl } from "@/lib/api/client";
import {
  getPaymentSessionApiErrorMessage,
  PAYMENT_SESSION_PROXY_TIMEOUT_MS,
  paymentSessionProxyErrorResponse,
  paymentSessionProxySuccessResponse,
} from "@/lib/checkout/payment-session-proxy";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function stripBrowserProof(payload: Record<string, unknown>): Record<string, unknown> {
  const safePayload = { ...payload };
  delete safePayload.receiptToken;
  delete safePayload.receipt_token;
  delete safePayload.token;
  return safePayload;
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(JSON.stringify({ error: "Cross-origin cookie request denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await request.json().catch(() => null);
    if (!isRecord(payload)) {
      return jsonError("Invalid payment request.", 400);
    }

    const orderId = stringField(payload, "orderId");
    const receiptToken = readOrderReceiptCookie(request.headers.get("cookie"), orderId);
    if (!orderId || !receiptToken) {
      return jsonError("Private receipt proof is missing for this order. Please reopen the receipt from this browser and try again.", 400);
    }

    const res = await fetchWithRetry(
      createApiUrl("/payment/stripe/intent"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...stripBrowserProof(payload),
          orderId,
          receiptToken,
        }),
        cache: "no-store",
      },
      0,
      PAYMENT_SESSION_PROXY_TIMEOUT_MS,
      false,
    );

    const json = await res.json() as { success?: boolean; data?: Record<string, unknown>; error?: unknown };

    if (!res.ok) {
      const errMsg = getPaymentSessionApiErrorMessage(json, "Payment initialization failed");
      return new Response(JSON.stringify({ error: errMsg }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return paymentSessionProxySuccessResponse(res, json);
  } catch (err: unknown) {
    console.error("[checkout/stripe-intent] Error:", err);
    return paymentSessionProxyErrorResponse(err);
  }
};
