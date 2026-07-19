import type { APIRoute } from "astro";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";
import type { OrderReceipt } from "@/lib/api/types";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";
import { getOrderSuccessStateKind } from "@/lib/order-success-state";

const RECEIPT_STATUS_TIMEOUT_MS = 5_000;
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function readReceipt(payload: unknown): OrderReceipt | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const envelope = payload as { data?: { order?: unknown } };
  const order = envelope.data?.order;
  if (!order || typeof order !== "object" || Array.isArray(order)) return null;

  const candidate = order as Partial<OrderReceipt>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.paymentMethod !== "string" ||
    typeof candidate.paymentStatus !== "string"
  ) {
    return null;
  }

  return candidate as OrderReceipt;
}

export const GET: APIRoute = async ({ request, url }) => {
  const orderId = url.searchParams.get("orderId")?.trim() ?? "";
  if (!ORDER_ID_PATTERN.test(orderId)) {
    return jsonResponse({ success: false, error: "Invalid receipt reference." }, 400);
  }

  const receiptToken = readOrderReceiptCookie(request.headers.get("cookie"), orderId);
  if (!receiptToken) {
    return jsonResponse({ success: false, error: "Receipt status is unavailable." }, 404);
  }

  try {
    const response = await fetchWithRetry(
      createApiUrl(`/orders/receipt/${encodeURIComponent(orderId)}`),
      {
        headers: { "X-Receipt-Token": receiptToken },
        cache: "no-store",
      },
      1,
      RECEIPT_STATUS_TIMEOUT_MS,
      false,
    );

    if (!response.ok) {
      return jsonResponse(
        { success: false, error: "Receipt status is temporarily unavailable." },
        response.status === 404 ? 404 : 503,
      );
    }

    const order = readReceipt(await response.json());
    if (!order || order.id !== orderId) {
      return jsonResponse({ success: false, error: "Receipt status response was invalid." }, 502);
    }

    return jsonResponse({
      success: true,
      data: {
        state: getOrderSuccessStateKind(order),
        updatedAt: order.updatedAt ?? null,
      },
    }, 200);
  } catch (error) {
    console.error("[order-receipt/status] Status check failed:", error);
    return jsonResponse({ success: false, error: "Receipt status is temporarily unavailable." }, 503);
  }
};
