// POST /api/gift-cards/apply: the checkout page's gift-card field. The code
// arrives in the POST body only and goes on to POST /api/v1/checkout/gift-cards/apply;
// the browser gets back the short-lived apply handle (kept in sessionStorage)
// and what it may show (last 4, balance). The code is never echoed, logged or
// put in a URL.
//
// Without JavaScript the form still posts here (method=post): the handle is
// useless without the page script, so the answer is a 303 back to /checkout
// with nothing in the URL, and the API is not called.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { applyGiftCard } from "@/lib/api/gift-cards";

export const prerender = false;

const MAX_BODY_BYTES = 1024;

const NO_STORE = "private, no-cache, no-store, must-revalidate";

function json(body: Record<string, unknown>, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": NO_STORE,
      "Content-Type": "application/json; charset=utf-8",
      Pragma: "no-cache",
      ...extra,
    },
  });
}

function isCrossOrigin(request: Request): boolean {
  if (shouldRejectCrossOriginCookieRequest(request)) return true;
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

/** The `code` of a small JSON body; null for anything larger or malformed. */
async function readCode(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  return typeof body === "object" && body !== null ? (body as { code?: unknown }).code : null;
}

const FAILURES = {
  unusable: { status: 400, errorCode: "GIFT_CARD_UNUSABLE" },
  not_found: { status: 400, errorCode: "GIFT_CARD_UNUSABLE" },
  signed_out: { status: 400, errorCode: "GIFT_CARD_UNUSABLE" },
  rate_limited: { status: 429, errorCode: "RATE_LIMITED" },
  unavailable: { status: 503, errorCode: "GIFT_CARDS_UNAVAILABLE" },
} as const;

export const POST: APIRoute = async ({ request }) => {
  if (isCrossOrigin(request)) {
    return json({ success: false, errorCode: "FORBIDDEN" }, 403);
  }
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    // A plain form post (no script yet): back to the payment step, nothing in the URL.
    await request.body?.cancel().catch(() => undefined);
    return new Response(null, {
      status: 303,
      headers: { Location: "/checkout", "Cache-Control": NO_STORE },
    });
  }

  let code: unknown;
  try {
    code = await readCode(request);
  } catch {
    code = null;
  }

  const result = await applyGiftCard(code, request);
  if (!result.ok) {
    const failure = FAILURES[result.reason];
    return json(
      {
        success: false,
        errorCode: failure.errorCode,
        ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      },
      failure.status,
      result.retryAfterSeconds ? { "Retry-After": String(result.retryAfterSeconds) } : undefined,
    );
  }

  const card = result.data;
  return json({
    success: true,
    data: {
      handle: card.handle,
      handleExpiresAt: card.handleExpiresAt,
      last4: card.last4,
      balance: card.balance,
      balanceMinor: card.balanceMinor,
      currencyCode: card.currencyCode,
      expiresAt: card.expiresAt,
    },
  }, 200);
};

export const ALL: APIRoute = () =>
  new Response("Method not allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": NO_STORE } });
