// src/pages/api/checkout/sslcommerz-session.ts
// Server-side proxy: initializes an SSLCommerz payment session via the backend.

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
    const payload = await request.json() as Record<string, unknown>;
    console.log("[checkout/sslcommerz-session] Requesting session for order:", payload.orderId);

    const res = await fetchWithRetry(
      createApiUrl("/payment/sslcommerz/session"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      0,     // retries; hosted session creation is explicit-user-action only
      PAYMENT_SESSION_PROXY_TIMEOUT_MS,
      true,  // requiresAuth
    );

    const json = await res.json() as { success?: boolean; data?: Record<string, unknown>; error?: unknown };

    if (!res.ok) {
      const errMsg = getPaymentSessionApiErrorMessage(json, "Payment session creation failed");
      console.error("[checkout/sslcommerz-session] Backend error:", res.status, errMsg);
      return new Response(JSON.stringify({ error: errMsg }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const unwrapped = json.data || json;
    console.log("[checkout/sslcommerz-session] Session created, gatewayUrl present:", !!(unwrapped as Record<string, unknown>).gatewayUrl);
    return new Response(JSON.stringify(unwrapped), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    console.error("[checkout/sslcommerz-session] Proxy error:", err);
    return paymentSessionProxyErrorResponse(err);
  }
};
