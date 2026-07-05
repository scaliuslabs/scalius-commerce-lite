import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";

const PAYMENT_RECOVERY_TIMEOUT_MS = 8_000;
const GENERIC_MESSAGE =
  "If this order is eligible for payment recovery, a verification code will be sent to the buyer contact.";

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

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonResponse({ success: false, error: "Cross-origin cookie request denied" }, 403);
  }

  try {
    const payload = await request.json().catch(() => null);
    if (!isRecord(payload)) {
      return jsonResponse({ success: false, error: "Invalid recovery request." }, 400);
    }

    const orderId = stringField(payload, "orderId");
    const channel = stringField(payload, "channel");
    if (!orderId) {
      return jsonResponse({ success: true, message: GENERIC_MESSAGE });
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
      const error = isRecord(json.error) && typeof json.error.message === "string"
        ? json.error.message
        : "Could not request a verification code. Please try again.";
      return jsonResponse({ success: false, error }, response.status);
    }

    return jsonResponse({ success: true, message: GENERIC_MESSAGE });
  } catch (error) {
    console.error("[payment-recovery/send-code] Error:", error);
    return jsonResponse({ success: false, error: "Could not request a verification code. Please try again." }, 500);
  }
};
