// src/pages/api/checkout/create-order.ts
// Server-side proxy: creates an order in the backend using the service API token.
// The API_TOKEN is only available server-side, never exposed to the browser.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";
import type { CreateOrderPayload } from "@/lib/api/types";
import { createOrder } from "../../../lib/api/orders";
import { getCheckoutErrorMessage } from "../../../lib/checkout/error-messages";
import {
  getPaymentSessionApiErrorMessage,
  getPaymentSessionProxyExceptionMessage,
  PAYMENT_SESSION_PROXY_TIMEOUT_MS,
} from "../../../lib/checkout/payment-session-proxy";
import { getCustomerSessionTokenFromCookie } from "../../../lib/customer-session-cookie";

const CUSTOMER_COOKIE_CLEAR_HEADERS = [
  "cs_tok=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
  "cs_auth=; Max-Age=0; Path=/; SameSite=Lax; Secure",
];

type OnlinePaymentMethod = "stripe" | "sslcommerz" | "polar";

type CheckoutCreateOrderPayload = CreateOrderPayload & {
  initialPaymentSession?: unknown;
};

type InitialPaymentSessionResult =
  | { session: Record<string, unknown>; error?: never }
  | { session?: never; error: string };

const PAYMENT_SESSION_ENDPOINTS: Record<OnlinePaymentMethod, string> = {
  stripe: "/payment/stripe/intent",
  sslcommerz: "/payment/sslcommerz/session",
  polar: "/payment/polar/session",
};

function isOnlinePaymentMethod(value: unknown): value is OnlinePaymentMethod {
  return value === "stripe" || value === "sslcommerz" || value === "polar";
}

async function createInitialPaymentSession(
  paymentMethod: OnlinePaymentMethod,
  orderId: string,
  receiptToken: string,
): Promise<InitialPaymentSessionResult> {
  try {
    const res = await fetchWithRetry(
      createApiUrl(PAYMENT_SESSION_ENDPOINTS[paymentMethod]),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, receiptToken }),
      },
      0,
      PAYMENT_SESSION_PROXY_TIMEOUT_MS,
      true,
    );
    const json = await res.json() as { success?: boolean; data?: Record<string, unknown>; error?: unknown };

    if (!res.ok) {
      return {
        error: getPaymentSessionApiErrorMessage(json, "Payment session creation failed"),
      };
    }

    return {
      session: {
        gateway: paymentMethod,
        ...(json.data || json),
      },
    };
  } catch (error: unknown) {
    console.error("[checkout/create-order] Initial payment session error:", error);
    return { error: getPaymentSessionProxyExceptionMessage(error) };
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(JSON.stringify({ success: false, error: "Cross-origin cookie request denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const rawPayload = (await request.json()) as CheckoutCreateOrderPayload;
    const { initialPaymentSession, ...payload } = rawPayload;
    const customerSessionToken = getCustomerSessionTokenFromCookie(request.headers.get("cookie"));

    const result = await createOrder(payload, { customerSessionToken });

    if (!result.success) {
      const headers = new Headers({ "Content-Type": "application/json" });
      if (result.errorCode === "CUSTOMER_SESSION_STALE") {
        for (const cookie of CUSTOMER_COOKIE_CLEAR_HEADERS) {
          headers.append("Set-Cookie", cookie);
        }
      }

      return new Response(JSON.stringify({
        success: false,
        error: getCheckoutErrorMessage(result.error),
        errorCode: result.errorCode,
        details: result.details,
      }), {
        status: result.status && result.status >= 400 ? result.status : 400,
        headers,
      });
    }

    const responseData: Record<string, unknown> = {
      id: result.orderId,
      receiptToken: result.receiptToken,
      totalAmount: result.totalAmount,
      paymentMethod: result.paymentMethod,
    };
    if (
      initialPaymentSession === true &&
      result.orderId &&
      result.receiptToken &&
      isOnlinePaymentMethod(result.paymentMethod)
    ) {
      const sessionResult = await createInitialPaymentSession(
        result.paymentMethod,
        result.orderId,
        result.receiptToken,
      );
      if (sessionResult.session) {
        responseData.initialPaymentSession = sessionResult.session;
      } else {
        responseData.initialPaymentSessionError = sessionResult.error;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      data: responseData,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    console.error("[checkout/create-order] Error:", err);
    return new Response(JSON.stringify({ success: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
