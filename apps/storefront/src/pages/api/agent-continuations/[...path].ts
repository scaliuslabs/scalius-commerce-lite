import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";
import { appendRewrittenCustomerAuthSetCookies } from "@/lib/customer-auth-proxy-cookies";
import { createOrderReceiptCookieHeader } from "@/lib/order-receipt-cookie";
import { readAgentContinuationCookie } from "@/lib/agent-continuation-cookie";

export const prerender = false;

const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const CONTINUATION_ID = /^acn_[A-Za-z0-9_-]{20}$/;
const POST_ACTIONS = new Set([
  "customer/send-otp",
  "customer/verify-otp",
  "payment/start",
  "payment/reconcile",
  "recovery/send-otp",
  "recovery/verify-otp",
]);

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      ...Object.fromEntries(new Headers(headers).entries()),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAllowedPath(rawPath: string | undefined, method: string): string | null {
  const normalized = rawPath?.replace(/^\/+|\/+$/g, "") ?? "";
  const [continuationId, ...rest] = normalized.split("/");
  if (!CONTINUATION_ID.test(continuationId ?? "")) return null;
  const action = rest.join("/");
  if (method === "GET" && !action) return normalized;
  if (method === "POST" && POST_ACTIONS.has(action)) return normalized;
  return null;
}

export const ALL: APIRoute = async ({ request, params }) => {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return json({ success: false, error: "Cross-origin request denied." }, 403);
  }
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return json({ success: false, error: "Method not allowed." }, 405, { Allow: "GET, POST" });
  }
  const path = parseAllowedPath(params.path, method);
  if (!path) return json({ success: false, error: "Secure storefront step not found." }, 404);
  const continuationId = path.split("/", 1)[0] ?? "";
  if (readAgentContinuationCookie(request.headers.get("cookie"), continuationId) !== continuationId) {
    return json({ success: false, error: "Secure storefront step not found." }, 404);
  }

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ success: false, error: "Request body is too large." }, 413);
  }
  const body = method === "POST" ? await request.text() : undefined;
  if (body && new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return json({ success: false, error: "Request body is too large." }, 413);
  }

  try {
    const headers = new Headers({ Accept: "application/json" });
    if (method === "POST") headers.set("Content-Type", "application/json");
    const connectingIp = request.headers.get("cf-connecting-ip");
    if (connectingIp) headers.set("cf-connecting-ip", connectingIp);
    const upstream = await fetchWithRetry(
      createApiUrl(`/storefront/agent-continuations/${path}`),
      { method, headers, body, cache: "no-store" },
      0,
      REQUEST_TIMEOUT_MS,
      true,
      false,
    );
    const payload = await upstream.json().catch(() => null);
    const responseHeaders = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    });
    appendRewrittenCustomerAuthSetCookies(responseHeaders, upstream.headers);

    const action = path.split("/").slice(1).join("/");
    if (upstream.ok && action === "recovery/verify-otp" && isRecord(payload)) {
      const data = isRecord(payload.data) ? payload.data : null;
      const orderId = typeof data?.orderId === "string" ? data.orderId : "";
      const proof = typeof data?.receiptProof === "string" ? data.receiptProof : "";
      const receiptCookie = createOrderReceiptCookieHeader(orderId, proof);
      if (!receiptCookie) {
        return json({ success: false, error: "Recovered receipt authority could not be stored." }, 502);
      }
      responseHeaders.append("Set-Cookie", receiptCookie);
      return new Response(JSON.stringify({
        success: true,
        data: { recovered: true, orderId },
      }), { status: upstream.status, headers: responseHeaders });
    }

    return new Response(JSON.stringify(payload ?? {
      success: false,
      error: { message: "The secure storefront service returned an invalid response." },
    }), { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    console.error("[agent-continuation proxy] Request failed:", error instanceof Error ? error.message : "unknown");
    return json({ success: false, error: "Secure storefront service is unavailable." }, 502);
  }
};
