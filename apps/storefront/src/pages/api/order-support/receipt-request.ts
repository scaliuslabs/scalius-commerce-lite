import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { apiFetch } from "@/lib/api/transport";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";
import { payloadTooLargeResponse, readBoundedJson } from "@/lib/bounded-body";
import { relayApiAnswer } from "@/lib/rate-limited";

const RECEIPT_SUPPORT_TIMEOUT_MS = 8_000;
const SUPPORT_REQUEST_TYPES = new Set(["cancel_pre_shipment", "return", "refund"]);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The largest honest request, from the API's schema for the route
 * (`POST /orders/receipt/{id}/support-requests`): a 500-character reason and a
 * 1,000-character message, each character up to six bytes once JSON-escaped,
 * and 100 return lines of a 64-character id and a count, plus the envelope.
 */
const RECEIPT_SUPPORT_REQUEST_MAX_BYTES = (500 + 1_000) * 6 + 100 * 96 + 1_024;

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonResponse({ success: false, error: "Cross-origin cookie request denied" }, 403);
  }

  try {
    const body = await readBoundedJson(request, RECEIPT_SUPPORT_REQUEST_MAX_BYTES);
    if (!body.ok && body.reason === "too_large") return payloadTooLargeResponse();
    const payload = body.ok ? body.value : null;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return jsonResponse({ success: false, error: "Invalid support request." }, 400);
    }

    const orderId = stringField(payload as Record<string, unknown>, "orderId");
    const type = stringField(payload as Record<string, unknown>, "type");
    const reason = stringField(payload as Record<string, unknown>, "reason");
    const message = stringField(payload as Record<string, unknown>, "message");
    // A return's lines: ids and counts only (the API checks them against the order).
    const rawItems = (payload as Record<string, unknown>).items;
    const items = Array.isArray(rawItems)
      ? rawItems.slice(0, 100).flatMap((item) => {
          const line = item as Record<string, unknown> | null;
          return line && typeof line.orderItemId === "string" && Number.isInteger(line.quantity)
            ? [{ orderItemId: line.orderItemId.slice(0, 64), quantity: line.quantity as number }]
            : [];
        })
      : [];
    const receiptToken = readOrderReceiptCookie(request.headers.get("cookie"), orderId);

    if (!orderId || !SUPPORT_REQUEST_TYPES.has(type)) {
      return jsonResponse({ success: false, error: "Invalid private receipt support request." }, 400);
    }
    if (!receiptToken) {
      return jsonResponse({
        success: false,
        error: "Private receipt proof is missing for this order. Please reopen the receipt from this browser and try again.",
      }, 400);
    }

    const response = await apiFetch(
      `/orders/receipt/${encodeURIComponent(orderId)}/support-requests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: receiptToken,
          type,
          reason,
          message: message || null,
          ...(items.length > 0 ? { items } : {}),
        }),
      },
      { retries: 0, timeout: RECEIPT_SUPPORT_TIMEOUT_MS, auth: true },
    );

    const text = await response.text();
    return relayApiAnswer(response, text || JSON.stringify({ success: response.ok }), {
      "Content-Type": response.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-store",
    });
  } catch (error) {
    console.error("[order-support/receipt-request] Error:", error);
    return jsonResponse({ success: false, error: "Support request failed. Please try again." }, 500);
  }
};
