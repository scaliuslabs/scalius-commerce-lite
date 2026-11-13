import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";

import { resolveBackendTarget } from "@/lib/api/transport";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";
import { FORM_REQUEST_MAX_BYTES, payloadTooLargeResponse, readBoundedJson } from "@/lib/bounded-body";
import { relayApiAnswer } from "@/lib/rate-limited";

export const prerender = false;

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonResponse({ success: false, error: "Cross-origin cookie request denied" }, 403);
  }

  const body = await readBoundedJson(request, FORM_REQUEST_MAX_BYTES);
  if (!body.ok && body.reason === "too_large") return payloadTooLargeResponse();
  const payload = (body.ok ? body.value : null) as { orderId?: unknown } | null;
  const orderId = typeof payload?.orderId === "string" ? payload.orderId.trim() : "";
  if (!ORDER_ID_PATTERN.test(orderId)) {
    return jsonResponse({ success: false, error: "Invalid receipt reference." }, 400);
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const receiptToken = readOrderReceiptCookie(cookieHeader, orderId);
  if (!receiptToken) {
    return jsonResponse({
      success: false,
      error: "Private receipt proof is missing. Reopen this receipt in the checkout browser.",
    }, 404);
  }

  const target = resolveBackendTarget(
    `/api/v1/customer-auth/orders/${encodeURIComponent(orderId)}/claim-receipt`,
  );
  if (!target) {
    return jsonResponse({ success: false, error: "Account service is temporarily unavailable." }, 503);
  }

  try {
    const response = await target.fetch(target.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "X-Receipt-Token": receiptToken,
      },
      body: "{}",
    });
    const body = await response.text();
    return relayApiAnswer(response, body || JSON.stringify({ success: response.ok }), {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    });
  } catch (error) {
    console.error("[order-receipt/claim-account] Account claim failed:", error);
    return jsonResponse({ success: false, error: "Order could not be saved right now. Please try again." }, 503);
  }
};
