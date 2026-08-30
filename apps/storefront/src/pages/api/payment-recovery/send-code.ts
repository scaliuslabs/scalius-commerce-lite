import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";

const PAYMENT_RECOVERY_TIMEOUT_MS = 8_000;
const ACCEPTED_RESULT_CODE = "PAYMENT_RECOVERY_CODE_REQUEST_ACCEPTED";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function apiErrorCode(payload: unknown, fallback: string): string {
  if (!isRecord(payload) || !isRecord(payload.error)) return fallback;
  return typeof payload.error.code === "string" && payload.error.code.trim()
    ? payload.error.code.trim()
    : fallback;
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonResponse({ success: false, errorCode: "PAYMENT_RECOVERY_REQUEST_DENIED" }, 403);
  }

  try {
    const payload = await request.json().catch(() => null);
    if (!isRecord(payload)) {
      return jsonResponse({ success: false, errorCode: "PAYMENT_RECOVERY_INVALID_REQUEST" }, 400);
    }

    const orderId = stringField(payload, "orderId");
    const channel = stringField(payload, "channel");
    if (!orderId) {
      return jsonResponse({ success: true, resultCode: ACCEPTED_RESULT_CODE });
    }

    const response = await fetchWithRetry(
      createApiUrl("/orders/payment-recovery/send-otp"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          ...(channel ? { channel } : {}),
        }),
        cache: "no-store",
      },
      0,
      PAYMENT_RECOVERY_TIMEOUT_MS,
      false,
    );

    const json = await response.json().catch(() => ({}) as Record<string, unknown>);
    if (!response.ok) {
      return jsonResponse({
        success: false,
        errorCode: apiErrorCode(json, "PAYMENT_RECOVERY_SEND_FAILED"),
      }, response.status);
    }

    return jsonResponse({ success: true, resultCode: ACCEPTED_RESULT_CODE });
  } catch (error) {
    console.error("[payment-recovery/send-code] Error:", error);
    return jsonResponse({ success: false, errorCode: "PAYMENT_RECOVERY_SEND_FAILED" }, 500);
  }
};
