/**
 * Reading a request (or an upstream response) body no further than a limit:
 * the one way a storefront route reads a body. A declared Content-Length over
 * the limit is refused before a byte is read, and the stream is counted as it
 * arrives, so a missing or false Content-Length cannot carry more past it:
 * the read stops at the limit and cancels the rest. A route never parses a
 * body it has not bounded (a 30 MB body to /api/checkout/validate-cart was
 * once read and parsed whole).
 *
 * The byte counting is the API's own primitive (`@scalius/shared/request-body-limit`),
 * and the limits are its route classes (`REQUEST_BODY_CLASS_BYTES`): a body
 * the storefront forwards is bounded by the class of the API route it goes
 * to. Nothing else in the storefront counts body bytes.
 */

import {
  PayloadTooLargeError,
  REQUEST_BODY_CLASS_BYTES,
  limitRequestBody,
  readLimitedBytes,
} from "@scalius/shared/request-body-limit";

export type BoundedBody<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "too_large" | "invalid" };

/** A body that carries a cart's lines (the cart check, the order, the tax quote, the discount preview): the API's cart class. */
export const CART_REQUEST_MAX_BYTES = REQUEST_BODY_CLASS_BYTES.cart;
/** A buyer form forwarded to the API (a token, an order id, a support request): the API's form class. */
export const FORM_REQUEST_MAX_BYTES = REQUEST_BODY_CLASS_BYTES.form;

// ---------------------------------------------------------------------------
// Byte limits: the shared primitive (`@scalius/shared/request-body-limit`)
// ---------------------------------------------------------------------------

/** The primitive bounds a Request: an upstream answer or a bare stream is read through one. */
function asRequest(source: Response | ReadableStream<Uint8Array>): Request {
  const isResponse = "headers" in source;
  const headers = new Headers();
  const length = isResponse ? source.headers.get("Content-Length") : null;
  if (length) headers.set("Content-Length", length);
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: isResponse ? source.body : source, duplex: "half" };
  return new Request("https://storefront.invalid/body", init);
}

/** The bytes, at most `maxBytes`: the shared counted read. */
async function readCountedBytes(request: Request, maxBytes: number): Promise<BoundedBody<Uint8Array<ArrayBuffer>>> {
  try {
    return { ok: true, value: await readLimitedBytes(request, maxBytes) };
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      void request.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    return { ok: false, reason: "invalid" };
  }
}

// ---------------------------------------------------------------------------
// Storefront readers
// ---------------------------------------------------------------------------

/** The body's bytes, at most `maxBytes`. */
export async function readBoundedBytes(
  source: Request | Response | ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedBody<Uint8Array<ArrayBuffer>>> {
  if (!source) return { ok: true, value: new Uint8Array(new ArrayBuffer(0)) };
  return readCountedBytes(source instanceof Request ? source : asRequest(source), maxBytes);
}

/** The body as UTF-8 text, at most `maxBytes`; "invalid" when it is not UTF-8. */
export async function readBoundedText(
  source: Request | Response | ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedBody<string>> {
  const bytes = await readBoundedBytes(source, maxBytes);
  if (!bytes.ok) return bytes;
  try {
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(bytes.value) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** The body parsed as JSON, at most `maxBytes`; "invalid" when it is not JSON. */
export async function readBoundedJson(
  source: Request | Response | ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedBody<unknown>> {
  const text = await readBoundedText(source, maxBytes);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) as unknown };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** A form body (urlencoded or multipart), at most `maxBytes`, parsed as the request's own `formData()` would. */
export async function readBoundedForm(request: Request, maxBytes: number): Promise<BoundedBody<FormData>> {
  const bytes = await readBoundedBytes(request, maxBytes);
  if (!bytes.ok) return bytes;
  try {
    const contentType = request.headers.get("Content-Type");
    const form = await new Response(bytes.value, contentType ? { headers: { "Content-Type": contentType } } : undefined).formData();
    return { ok: true, value: form };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/**
 * A body passed on unread (a proxy streams it to the API), counted as it
 * flows: a declared Content-Length over `maxBytes` is refused before a byte
 * moves, and the stream errors once more than `maxBytes` have passed, so the
 * Worker never holds more than one chunk of it. `exceeded()` says whether
 * the stream was stopped for its size (the forward then failed for that).
 */
export function limitedBodyStream(
  request: Request,
  maxBytes: number,
): { ok: false; reason: "too_large" } | { ok: true; body: ReadableStream<Uint8Array> | null; exceeded: () => boolean } {
  try {
    const limited = limitRequestBody(request, maxBytes);
    return { ok: true, body: limited.request.body, exceeded: limited.exceeded };
  } catch (error) {
    if (!(error instanceof PayloadTooLargeError)) throw error;
    void request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }
}

/** The JSON answer to a body over its limit. */
export function payloadTooLargeResponse(): Response {
  return new Response(JSON.stringify({ success: false, error: "Request too large" }), {
    status: 413,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
