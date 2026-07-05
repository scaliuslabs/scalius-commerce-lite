import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";
import { createOrderReceiptCookieHeader } from "@/lib/order-receipt-cookie";

const PAYMENT_RECOVERY_TIMEOUT_MS = 8_000;

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

function buildCleanReceiptUrl(orderId: string, redirectParams: Record<string, unknown> | undefined): string {
  const params = new URLSearchParams({ orderId });
  const payment = typeof redirectParams?.payment === "string" ? redirectParams.payment : "";
  const result = typeof redirectParams?.result === "string" ? redirectParams.result : "";
  const paymentType = typeof redirectParams?.paymentType === "string" ? redirectParams.paymentType : "";
  const depositAmount = redirectParams?.depositAmount;

  if (payment) params.set("payment", payment);
  if (result) params.set("result", result);
  if (paymentType) params.set("paymentType", paymentType);
  if (typeof depositAmount === "number" && Number.isFinite(depositAmount)) {
    params.set("depositAmount", String(depositAmount));
  }

  return `/order-success?${params.toString()}`;
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonResponse({ success: false, error: "Cross-origin cookie request denied" }, 403);
  }

  try {
    const payload = await request.json().catch(() => null);
    if (!isRecord(payload)) {
      return jsonResponse({ success: false, error: "Invalid recovery verification." }, 400);
    }

    const orderId = stringField(payload, "orderId");
    const channel = stringField(payload, "channel");
    const code = stringField(payload, "code");
    if (!orderId || !channel || !code) {
      return jsonResponse({ success: false, error: "Enter the verification code to continue." }, 400);
    }

    const response = await fetchWithRetry(
      createApiUrl("/orders/payment-recovery/verify-otp"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, channel, code }),
        cache: "no-store",
      },
      0,
      PAYMENT_RECOVERY_TIMEOUT_MS,
      true,
    );

    const json = await response.json().catch(() => ({}) as Record<string, unknown>);
    const data = isRecord(json.data) ? json.data : json;
    if (!response.ok || !isRecord(data)) {
      const error = isRecord(json.error) && typeof json.error.message === "string"
        ? json.error.message
        : "Verification failed. Please request a new code and try again.";
      return jsonResponse({ success: false, error }, response.status);
    }

    const receiptToken = typeof data.receiptToken === "string" ? data.receiptToken : "";
    const recoveredOrderId = typeof data.orderId === "string" ? data.orderId : orderId;
    if (!receiptToken || recoveredOrderId !== orderId) {
      return jsonResponse({
        success: false,
        error: "Receipt recovery could not be completed. Please request a new code.",
      }, 502);
    }

    const cookie = createOrderReceiptCookieHeader(recoveredOrderId, receiptToken);
    const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
    if (cookie) headers.append("Set-Cookie", cookie);

    return new Response(JSON.stringify({
      success: true,
      redirectUrl: buildCleanReceiptUrl(recoveredOrderId, isRecord(data.redirectParams) ? data.redirectParams : undefined),
    }), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("[payment-recovery/verify] Error:", error);
    return jsonResponse({ success: false, error: "Verification failed. Please try again." }, 500);
  }
};
