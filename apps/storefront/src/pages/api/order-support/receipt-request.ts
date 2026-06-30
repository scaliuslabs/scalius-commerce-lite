import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";

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

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonResponse({ success: false, error: "Cross-origin cookie request denied" }, 403);
  }

  try {
    const payload = await request.json().catch(() => null);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return jsonResponse({ success: false, error: "Invalid support request." }, 400);
    }

    const orderId = stringField(payload as Record<string, unknown>, "orderId");
    const receiptToken = stringField(payload as Record<string, unknown>, "receiptToken");
    const type = stringField(payload as Record<string, unknown>, "type");
    const reason = stringField(payload as Record<string, unknown>, "reason");
    const message = stringField(payload as Record<string, unknown>, "message");

    if (!orderId || !receiptToken || !SUPPORT_REQUEST_TYPES.has(type)) {
      return jsonResponse({ success: false, error: "Invalid private receipt support request." }, 400);
    }

    const response = await fetchWithRetry(
      createApiUrl(`/orders/receipt/${encodeURIComponent(orderId)}/support-requests`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: receiptToken,
          type,
          reason,
          message: message || null,
        }),
      },
      0,
      RECEIPT_SUPPORT_TIMEOUT_MS,
      true,
    );

    const text = await response.text();
    return new Response(text || JSON.stringify({ success: response.ok }), {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[order-support/receipt-request] Error:", error);
    return jsonResponse({ success: false, error: "Support request failed. Please try again." }, 500);
  }
};
