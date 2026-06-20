// src/pages/api/checkout/stripe-intent.ts
// Server-side proxy: creates a Stripe PaymentIntent via the backend.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { fetchWithRetry, createApiUrl } from "@/lib/api/client";
import {
  getPaymentSessionApiErrorMessage,
  PAYMENT_SESSION_PROXY_TIMEOUT_MS,
  paymentSessionProxyErrorResponse,
} from "@/lib/checkout/payment-session-proxy";

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(JSON.stringify({ error: "Cross-origin cookie request denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await request.json();

    const res = await fetchWithRetry(
      createApiUrl("/payment/stripe/intent"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      0,
      PAYMENT_SESSION_PROXY_TIMEOUT_MS,
      true,
    );

    const json = await res.json() as { success?: boolean; data?: Record<string, unknown>; error?: unknown };

    if (!res.ok) {
      const errMsg = getPaymentSessionApiErrorMessage(json, "Payment initialization failed");
      return new Response(JSON.stringify({ error: errMsg }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Unwrap { success, data } envelope — checkout page reads fields directly
    return new Response(JSON.stringify(json.data || json), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    console.error("[checkout/stripe-intent] Error:", err);
    return paymentSessionProxyErrorResponse(err);
  }
};
