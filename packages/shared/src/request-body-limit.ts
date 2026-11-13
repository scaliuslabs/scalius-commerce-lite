// The one request-body ceiling of every Worker: a body is counted as it
// streams, never trusted by its declared length alone, and never buffered
// past the ceiling. The API applies it to every route by the route's declared
// class (apps/api/src/runtime/route-limits.ts). It lives here, free of the
// API, so any Worker reading a request body can use it.

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * The fixed body classes a route can declare, in bytes: the API applies them
 * per route (`ROUTE_BODY_RULES`, apps/api/src/runtime/route-limits.ts, which
 * says what each one is sized from), and the storefront bounds a body it
 * forwards to such a route by the same class, so the two never disagree.
 */
export const REQUEST_BODY_CLASS_BYTES = {
  /** No body: reads. */
  none: 0,
  /** A small JSON form; the largest a buyer form's schema takes is a 100-line support request, about 35 KB. */
  form: 48 * KIB,
  /** A cart, an order or a quote: 99 lines and the cart's buyer inputs at their caps, about 1 MB, plus a quarter. */
  cart: 1280 * KIB,
  /** A provider's callback, an installed app's route. */
  callback: 1 * MIB,
  /** A dashboard or app API operation. */
  dashboard: 8 * MIB,
} as const;

/** A body larger than its route takes. Answer 413 `payload_too_large`. */
export class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Send at most ${maxBytes} bytes in one request.`);
    this.name = "PayloadTooLargeError";
  }
}

export interface LimitedRequest {
  /** The request with a body that errors once it passes the ceiling. */
  readonly request: Request;
  /** True once more than the ceiling was read (the body errored). */
  exceeded(): boolean;
}

function declaredLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The request with its body bounded to `maxBytes`. A declared length past the
 * ceiling throws at once, before a byte is read; any body (chunked, or one
 * whose declared length lies) is counted as it is read and errors with
 * {@link PayloadTooLargeError} past the ceiling, so a reader holds at most
 * `maxBytes`. Nothing is read here: a route that never reads its body pays
 * nothing.
 */
export function limitRequestBody(request: Request, maxBytes: number): LimitedRequest {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer");
  const declared = declaredLength(request);
  if (declared !== null && declared > maxBytes) throw new PayloadTooLargeError(maxBytes);
  if (request.body === null) return { request, exceeded: () => false };
  let total = 0;
  let over = false;
  const counted = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        over = true;
        controller.error(new PayloadTooLargeError(maxBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  const init: RequestInit & { duplex: "half" } = { body: counted, duplex: "half" };
  return { request: new Request(request, init), exceeded: () => over };
}

/** The whole body as bytes, at most `maxBytes` of them, or {@link PayloadTooLargeError}. */
export async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const limited = limitRequestBody(request, maxBytes);
  if (limited.request.body === null) return new Uint8Array(0);
  try {
    return new Uint8Array(await new Response(limited.request.body).arrayBuffer());
  } catch (error) {
    if (limited.exceeded()) throw new PayloadTooLargeError(maxBytes);
    throw error;
  }
}

/** The whole body as UTF-8 text, at most `maxBytes` of it, or {@link PayloadTooLargeError}. */
export async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readLimitedBytes(request, maxBytes));
}

/** The request with its body read into memory (at most `maxBytes`), so a handler that parses it cannot read more. */
export async function bufferRequestBody(request: Request, maxBytes: number): Promise<Request> {
  if (request.body === null) {
    limitRequestBody(request, maxBytes);
    return request;
  }
  const bytes = await readLimitedBytes(request, maxBytes);
  const headers = new Headers(request.headers);
  headers.set("content-length", String(bytes.byteLength));
  headers.delete("transfer-encoding");
  return new Request(request, { body: bytes, headers });
}
