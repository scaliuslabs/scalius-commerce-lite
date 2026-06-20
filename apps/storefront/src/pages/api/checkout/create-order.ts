// src/pages/api/checkout/create-order.ts
// Server-side proxy: creates an order in the backend using the service API token.
// The API_TOKEN is only available server-side, never exposed to the browser.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { createOrder } from "../../../lib/api/orders";
import { getCheckoutErrorMessage } from "../../../lib/checkout/error-messages";
import { getCustomerSessionTokenFromCookie } from "../../../lib/customer-session-cookie";

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return new Response(JSON.stringify({ success: false, error: "Cross-origin cookie request denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload = (await request.json()) as import("@/lib/api/types").CreateOrderPayload;
    const customerSessionToken = getCustomerSessionTokenFromCookie(request.headers.get("cookie"));

    const result = await createOrder(payload, { customerSessionToken });

    if (!result.success) {
      return new Response(JSON.stringify({
        success: false,
        error: getCheckoutErrorMessage(result.error),
        details: result.details,
      }), {
        status: result.status && result.status >= 400 ? result.status : 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        id: result.orderId,
        receiptToken: result.receiptToken,
        totalAmount: result.totalAmount,
        paymentMethod: result.paymentMethod,
      }
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
