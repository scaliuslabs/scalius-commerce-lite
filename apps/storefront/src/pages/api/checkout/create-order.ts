// src/pages/api/checkout/create-order.ts
// Server-side proxy: keeps checkout same-origin while calling the public,
// proof/origin-guarded backend order and payment-session routes.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { isPaymentMethodIdShape } from "@/lib/payment-method-id";
import { apiFetch } from "@/lib/api/transport";
import type { CreateOrderPayload } from "@/lib/api/types";
import { createOrder } from "../../../lib/api/orders";
import { getCheckoutErrorMessage } from "../../../lib/checkout/error-messages";
import {
  getPaymentSessionApiErrorMessage,
  getPaymentSessionProcessingMessage,
  getPaymentSessionProxyExceptionMessage,
  isPaymentSessionProcessingPayload,
  PAYMENT_SESSION_PROXY_TIMEOUT_MS,
} from "../../../lib/checkout/payment-session-proxy";
import {
  ENDED_CUSTOMER_SESSION_COOKIES,
  getCustomerSessionTokenFromCookie,
} from "../../../lib/customer-session-cookie";
import {
  createOrderReceiptCookieHeader,
  createOrderReceiptFinalizeCookieHeader,
} from "../../../lib/order-receipt-cookie";

type CheckoutCreateOrderPayload = CreateOrderPayload & {
  initialPaymentSession?: unknown;
};

type InitialPaymentSessionResult =
  | { session: Record<string, unknown>; error?: never }
  | { session?: never; error: string };

/**
 * Every payment method except cash on delivery and a gift-card-paid order
 * (nothing left to collect) is an online gateway id: a built-in one or an
 * app provider's `<plugin id>:<provider id>`.
 */
function isOnlinePaymentMethod(value: unknown): value is string {
  return isPaymentMethodIdShape(value) && value !== "cod" && value !== "gift_card";
}

async function createInitialPaymentSession(
  paymentMethod: string,
  orderId: string,
  receiptToken: string,
): Promise<InitialPaymentSessionResult> {
  try {
    const res = await apiFetch(
      `/payment/${paymentMethod}/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, receiptToken }),
        cache: "no-store",
      },
      { retries: 0, timeout: PAYMENT_SESSION_PROXY_TIMEOUT_MS, auth: false },
    );
    const json = await res.json() as { success?: boolean; data?: Record<string, unknown>; error?: unknown };

    if (!res.ok) {
      return {
        error: getPaymentSessionApiErrorMessage(json, "Payment session creation failed"),
      };
    }

    const unwrapped = json.data || json;
    if (res.status === 202 || isPaymentSessionProcessingPayload(unwrapped)) {
      return {
        error: getPaymentSessionProcessingMessage(unwrapped),
      };
    }

    return {
      session: {
        gateway: paymentMethod,
        ...unwrapped,
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
      return new Response(JSON.stringify({
        success: false,
        error: getCheckoutErrorMessage(result.error),
        errorCode: result.errorCode,
        details: result.details,
      }), {
        status: result.status && result.status >= 400 ? result.status : 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const responseData: Record<string, unknown> = {
      id: result.orderId,
      totalAmount: result.totalAmount,
      paymentMethod: result.paymentMethod,
    };

    if (!result.orderId || !result.receiptToken) {
      return new Response(JSON.stringify({
        success: false,
        error: "Order receipt proof missing. Please contact support before retrying payment.",
      }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      initialPaymentSession === true &&
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

    const headers = new Headers({ "Content-Type": "application/json" });
    // The order was placed as a guest's: the ended session's cookies go.
    if (result.customerSessionEnded) {
      for (const cookie of ENDED_CUSTOMER_SESSION_COOKIES) headers.append("Set-Cookie", cookie);
    }
    const receiptCookie = createOrderReceiptCookieHeader(result.orderId, result.receiptToken);
    if (receiptCookie) {
      headers.append("Set-Cookie", receiptCookie);
    }
    const finalizeCookie = createOrderReceiptFinalizeCookieHeader(result.orderId);
    if (finalizeCookie) {
      headers.append("Set-Cookie", finalizeCookie);
    }

    return new Response(JSON.stringify({
      success: true,
      data: responseData,
    }), {
      status: 200,
      headers,
    });
  } catch (err: unknown) {
    console.error("[checkout/create-order] Error:", err);
    return new Response(JSON.stringify({ success: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
