// src/pages/api/checkout/discount-preview.ts
// Same-origin discount preview for a signed-in buyer. The browser previews a
// guest's cart straight against the public API, but the buyer's session is an
// httpOnly cookie of this origin the API never sees: a code limited to
// customer segments would ask a member to sign in. This proxy forwards the
// preview with the session as `X-Customer-Session`, as the tax quote and the
// order do, so the preview prices the buyer exactly as checkout will.

import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import { apiFetch } from "@/lib/api/transport";
import { getCustomerSessionTokenFromCookie } from "../../../lib/customer-session-cookie";

export const prerender = false;

const DISCOUNT_PREVIEW_API_PATH = "/discounts/validate";
const DISCOUNT_PREVIEW_TIMEOUT_MS = 8_000;
/** Up to 99 cart lines and five codes fit well inside this. */
const DISCOUNT_PREVIEW_MAX_BYTES = 64 * 1024;
const DISCOUNT_PREVIEW_MAX_RESPONSE_BYTES = 256 * 1024;

function jsonResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      Pragma: "no-cache",
    },
  });
}

const failure = (error: string, status: number) => jsonResponse(JSON.stringify({ success: false, error: { message: error } }), status);

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

/** The body as text, or null when it is larger than `maxBytes`. */
async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export const POST: APIRoute = async ({ request }) => {
  if (isCrossOrigin(request)) return failure("Request origin denied", 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return failure("JSON request required", 415);
  }
  let body: string | null;
  try {
    body = await readBounded(request.body, DISCOUNT_PREVIEW_MAX_BYTES);
    if (body !== null) JSON.parse(body);
  } catch {
    return failure("Discount preview request is invalid", 400);
  }
  if (body === null) return failure("Request too large", 413);

  try {
    const sessionToken = getCustomerSessionTokenFromCookie(request.headers.get("cookie"));
    const upstream = await apiFetch(
      DISCOUNT_PREVIEW_API_PATH,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(sessionToken ? { "X-Customer-Session": sessionToken } : {}),
        },
        body,
        cache: "no-store",
      },
      { retries: 0, timeout: DISCOUNT_PREVIEW_TIMEOUT_MS, auth: false },
    );
    const text = await readBounded(upstream.body, DISCOUNT_PREVIEW_MAX_RESPONSE_BYTES);
    if (text === null) return failure("Discount preview is unavailable", 502);
    // The API's own answer (and its 400 reasons) reach the cart unchanged.
    if (upstream.ok || upstream.status === 400) return jsonResponse(text, upstream.status);
    return failure("Discount preview is unavailable", upstream.status === 429 ? 429 : 502);
  } catch {
    return failure("Discount preview is unavailable", 502);
  }
};
