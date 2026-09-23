// Server-side proxy for every payment gateway: creates (or replays) the
// buyer's payment session through the public backend route. The private
// receipt proof comes from the httpOnly cookie, never from the browser body.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { apiFetch } from "@/lib/api/transport";
import {
  getPaymentSessionApiErrorMessage,
  PAYMENT_SESSION_PROXY_TIMEOUT_MS,
  paymentSessionProxyErrorResponse,
  paymentSessionProxySuccessResponse,
} from "@/lib/checkout/payment-session-proxy";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";

const GATEWAY_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const POST: APIRoute = async ({ request, params }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonError("Cross-origin cookie request denied", 403);
  }
  const gateway = params.gateway ?? "";
  if (!GATEWAY_ID.test(gateway) || gateway === "cod") {
    return jsonError("Unsupported payment method.", 404);
  }

  try {
    const payload = await request.json().catch(() => null);
    if (!isRecord(payload)) {
      return jsonError("Invalid payment request.", 400);
    }

    const orderId = typeof payload.orderId === "string" ? payload.orderId.trim() : "";
    const receiptToken = readOrderReceiptCookie(request.headers.get("cookie"), orderId);
    if (!orderId || !receiptToken) {
      return jsonError("Private receipt proof is missing for this order. Please reopen the receipt from this browser and try again.", 400);
    }

    const safePayload = { ...payload };
    delete safePayload.receiptToken;
    delete safePayload.receipt_token;
    delete safePayload.token;
    const res = await apiFetch(
      `/payment/${gateway}/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...safePayload, orderId, receiptToken }),
        cache: "no-store",
      },
      // retries: 0; payment session creation is explicit-user-action only
      { retries: 0, timeout: PAYMENT_SESSION_PROXY_TIMEOUT_MS, auth: false },
    );

    const json = await res.json() as { success?: boolean; data?: Record<string, unknown>; error?: unknown };
    if (!res.ok) {
      console.error("[checkout/payment-session] Backend error status:", res.status);
      return new Response(JSON.stringify({ error: getPaymentSessionApiErrorMessage(json, "Payment session creation failed") }), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    return paymentSessionProxySuccessResponse(res, json);
  } catch (err: unknown) {
    console.error("[checkout/payment-session] Proxy error:", err instanceof Error ? err.name : "unknown");
    return paymentSessionProxyErrorResponse(err);
  }
};
