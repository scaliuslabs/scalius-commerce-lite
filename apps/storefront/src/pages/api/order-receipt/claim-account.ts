import type { APIRoute } from "astro";
import { env as cfEnv } from "cloudflare:workers";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";

import { readOrderReceiptCookie } from "@/lib/order-receipt-cookie";

export const prerender = false;

const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export const POST: APIRoute = async ({ request }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonResponse({ success: false, error: "Cross-origin cookie request denied" }, 403);
  }

  const payload = await request.json().catch(() => null) as { orderId?: unknown } | null;
  const orderId = typeof payload?.orderId === "string" ? payload.orderId.trim() : "";
  if (!ORDER_ID_PATTERN.test(orderId)) {
    return jsonResponse({ success: false, error: "Invalid receipt reference." }, 400);
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  const receiptToken = readOrderReceiptCookie(cookieHeader, orderId);
  if (!receiptToken) {
    return jsonResponse({
      success: false,
      error: "Private receipt proof is missing. Reopen this receipt in the checkout browser.",
    }, 404);
  }

  const env = (() => {
    try {
      const value = cfEnv as unknown as Env;
      return value?.BACKEND_API || value?.PUBLIC_API_BASE_URL ? value : undefined;
    } catch {
      return undefined;
    }
  })();
  const apiPath = `/api/v1/customer-auth/orders/${encodeURIComponent(orderId)}/claim-receipt`;
  const canUseServiceBinding = Boolean(env?.BACKEND_API && !import.meta.env.DEV);
  const targetUrl = canUseServiceBinding
    ? `https://api.internal${apiPath}`
    : `${String(env?.PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "")}${apiPath}`;
  if (!canUseServiceBinding && !env?.PUBLIC_API_BASE_URL) {
    return jsonResponse({ success: false, error: "Account service is temporarily unavailable." }, 503);
  }

  try {
    const fetcher = canUseServiceBinding
      ? env!.BACKEND_API.fetch.bind(env!.BACKEND_API)
      : fetch;
    const response = await fetcher(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "X-Receipt-Token": receiptToken,
      },
      body: "{}",
    });
    const body = await response.text();
    return new Response(body || JSON.stringify({ success: response.ok }), {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        Vary: "Cookie",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[order-receipt/claim-account] Account claim failed:", error);
    return jsonResponse({ success: false, error: "Order could not be saved right now. Please try again." }, 503);
  }
};
