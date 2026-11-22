import type { APIRoute } from "astro";
import { apiFetch } from "@/lib/api/transport";
import type { OrderReceipt } from "@/lib/api/types";
import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";
import { isDigitalLinePreparing } from "@/lib/order-success-state";

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
    typeof candidate.paymentStatus !== "string" ||
    typeof candidate.buyerView?.kind !== "string"
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
    // The poll needs only the order's kind; whether a payment would start is
    // decided (gateway and settings reads) only when the page asks (`retry=1`).
    const recovery = url.searchParams.get("retry") === "1" ? "include" : "omit";
    const response = await apiFetch(
      `/orders/receipt/${encodeURIComponent(orderId)}?paymentRecovery=${recovery}`,
      {
        headers: { "X-Receipt-Token": receiptToken },
        cache: "no-store",
      },
      { retries: 1, timeout: RECEIPT_STATUS_TIMEOUT_MS, auth: false },
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
        // The kind the API decided, as the receipt page drew it.
        state: order.buyerView.kind,
        updatedAt: order.updatedAt ?? null,
        // Whether a retry is still offered, and the session route's own code when it is not.
        ...(recovery === "include" ? {
          retry: {
            canRetryPayment: order.buyerView.paymentAction === "retry",
            refusal: order.paymentRecovery?.refusal ?? null,
          },
        } : {}),
        // The receipt checks back until its paid downloads are delivered.
        downloadsPreparing: (order.items ?? []).some((line) => isDigitalLinePreparing(line, order)),
      },
    }, 200);
  } catch (error) {
    console.error("[order-receipt/status] Status check failed:", error);
    return jsonResponse({ success: false, error: "Receipt status is temporarily unavailable." }, 503);
  }
};
