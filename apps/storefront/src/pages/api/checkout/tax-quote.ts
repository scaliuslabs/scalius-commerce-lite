import type { APIRoute } from "astro";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";
import type { CartValidationIssue } from "@/lib/api/orders";
import { createApiUrl, fetchWithRetry } from "@/lib/api/client";
import {
  normalizeTaxQuoteRequest,
  parseTaxQuoteEnvelope,
  TAX_QUOTE_MAX_REQUEST_BYTES,
  TAX_QUOTE_MAX_RESPONSE_BYTES,
} from "@/lib/checkout/tax-quote-contract";
import { parseTaxQuoteCartIssues } from "@/lib/checkout/tax-quote-error-contract";
import { getCustomerSessionTokenFromCookie } from "../../../lib/customer-session-cookie";

export const prerender = false;

const TAX_QUOTE_API_PATH = "/orders/tax-quote";
const TAX_QUOTE_UPSTREAM_TIMEOUT_MS = 8_000;

class BodyTooLargeError extends Error {}

function responseHeaders(): Headers {
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    Pragma: "no-cache",
  });
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(),
  });
}

function isCrossOrigin(request: Request): boolean {
  if (shouldRejectCrossOriginCookieRequest(request)) return true;
  const submittedOrigin = request.headers.get("Origin");
  if (!submittedOrigin) return false;
  try {
    return new URL(submittedOrigin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

function contentLengthExceeds(request: Request, maxBytes: number): boolean {
  const value = request.headers.get("Content-Length");
  if (!value) return false;
  const parsed = Number(value);
  return !Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes;
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
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
        throw new BodyTooLargeError();
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

function safeUpstreamFailureStatus(status: number): number {
  return status === 400 ||
    status === 409 ||
    status === 422 ||
    status === 429 ||
    status === 503
    ? status
    : 502;
}

export const POST: APIRoute = async ({ request }) => {
  if (isCrossOrigin(request)) {
    return jsonResponse({ success: false, error: "Request origin denied" }, 403);
  }
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    return jsonResponse({ success: false, error: "JSON request required" }, 415);
  }
  if (contentLengthExceeds(request, TAX_QUOTE_MAX_REQUEST_BYTES)) {
    return jsonResponse({ success: false, error: "Request too large" }, 413);
  }

  let normalizedRequest;
  try {
    const text = await readBoundedBody(request.body, TAX_QUOTE_MAX_REQUEST_BYTES);
    normalizedRequest = normalizeTaxQuoteRequest(JSON.parse(text));
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return jsonResponse({ success: false, error: "Request too large" }, 413);
    }
    return jsonResponse(
      { success: false, error: "Checkout tax quote request is invalid" },
      400,
    );
  }

  try {
    const customerSessionToken = getCustomerSessionTokenFromCookie(
      request.headers.get("cookie"),
    );
    const upstream = await fetchWithRetry(
      createApiUrl(TAX_QUOTE_API_PATH),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(customerSessionToken
            ? { "X-Customer-Session": customerSessionToken }
            : {}),
        },
        body: JSON.stringify(normalizedRequest),
        cache: "no-store",
      },
      0,
      TAX_QUOTE_UPSTREAM_TIMEOUT_MS,
      false,
    );

    if (!upstream.ok) {
      let itemIssues: CartValidationIssue[] = [];
      try {
        const text = await readBoundedBody(
          upstream.body,
          TAX_QUOTE_MAX_RESPONSE_BYTES,
        );
        itemIssues = parseTaxQuoteCartIssues(JSON.parse(text));
      } catch {
        itemIssues = [];
      }
      return jsonResponse(
        {
          success: false,
          error: "Current checkout total is unavailable",
          ...(itemIssues.length > 0 ? { details: { itemIssues } } : {}),
        },
        safeUpstreamFailureStatus(upstream.status),
      );
    }

    const text = await readBoundedBody(
      upstream.body,
      TAX_QUOTE_MAX_RESPONSE_BYTES,
    );
    const quote = parseTaxQuoteEnvelope(JSON.parse(text));
    return jsonResponse({ success: true, data: quote }, 200);
  } catch {
    return jsonResponse(
      { success: false, error: "Current checkout total is unavailable" },
      502,
    );
  }
};
