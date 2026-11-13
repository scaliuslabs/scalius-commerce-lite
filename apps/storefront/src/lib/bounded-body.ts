/**
 * Reading a request (or an upstream response) body no further than a limit:
 * the one way a storefront route reads a body. A declared Content-Length over
 * the limit is refused before a byte is read, and the stream is counted as it
 * arrives, so a missing or false Content-Length cannot carry more past it:
 * the read stops at the limit and cancels the rest. A route never parses a
 * body it has not bounded (a 30 MB body to /api/checkout/validate-cart was
 * once read and parsed whole).
 */

export type BoundedBody<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "too_large" | "invalid" };

/** Bytes for any body that carries a cart's lines (the cart check, the order, the tax quote): 99 lines with their inputs, and room to spare. */
export const CART_REQUEST_MAX_BYTES = 256 * 1024;
/** Bytes for a body that carries a few fields (a token, an order id, a status poll). */
export const SMALL_REQUEST_MAX_BYTES = 8 * 1024;

function declaredTooLarge(headers: Headers | null, maxBytes: number): boolean {
  const value = headers?.get("Content-Length");
  if (!value) return false;
  const declared = Number(value);
  return !Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes;
}

/** The body's bytes, at most `maxBytes`. */
export async function readBoundedBytes(
  source: Request | Response | ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<BoundedBody<Uint8Array<ArrayBuffer>>> {
  const headers = source && "headers" in source ? source.headers : null;
  if (declaredTooLarge(headers, maxBytes)) {
    if (source && "body" in source) void source.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }
  const body = source && "getReader" in source ? source : source?.body ?? null;
  if (!body) return { ok: true, value: new Uint8Array(new ArrayBuffer(0)) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Not awaited: one half of a cloned (teed) body settles only once its twin is done too.
        void reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
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
  if (declaredTooLarge(request.headers, maxBytes)) {
    void request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }
  if (!request.body) return { ok: true, body: null, exceeded: () => false };
  let size = 0;
  let over = false;
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        over = true;
        controller.error(new RangeError("The request body is larger than its limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return { ok: true, body, exceeded: () => over };
}

/** The JSON answer to a body over its limit. */
export function payloadTooLargeResponse(): Response {
  return new Response(JSON.stringify({ success: false, error: "Request too large" }), {
    status: 413,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
