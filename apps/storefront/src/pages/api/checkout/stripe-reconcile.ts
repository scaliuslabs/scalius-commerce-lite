import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";

const STRIPE_RECONCILE_TIMEOUT_MS = 15_000;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function readOrderId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const orderId = (value as Record<string, unknown>).orderId;
  return typeof orderId === "string" ? orderId.trim() : "";
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return json({ error: "Cross-origin cookie request denied" }, 403);
  }

  const payload = await request.json().catch(() => null);
  const orderId = readOrderId(payload);
  const receiptToken = readOrderReceiptCookie(request.headers.get("cookie"), orderId);
  if (!orderId || !receiptToken) {
    return json({ error: "Private receipt proof is missing for this order." }, 400);
  }

  try {
    const response = await fetchWithRetry(
      createApiUrl("/payment/stripe/reconcile"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, receiptToken }),
        cache: "no-store",
      },
      0,
      STRIPE_RECONCILE_TIMEOUT_MS,
      false,
    );
    const responseBody = await response.json().catch(() => ({
      error: "Stripe payment verification is temporarily unavailable.",
    }));
    return json(responseBody, response.status);
  } catch (error) {
    console.error(
      "[checkout/stripe-reconcile] Error:",
      error instanceof Error ? error.message : error,
    );
    return json({ error: "Stripe payment verification is temporarily unavailable." }, 503);
  }
};
