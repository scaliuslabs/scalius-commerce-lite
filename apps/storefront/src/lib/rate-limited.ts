/**
 * The one way a storefront `/api/*` route answers the API's rate limit: with
 * the API's own code (`rate_limited`) and its wait, in the body
 * (`error.details.retryAfterSeconds`) and in `Retry-After`, so the buyer's
 * page says how long to wait (`refusalWaitSeconds`, `pageWait`). A route that
 * relays the API's answer passes it through `relayApiAnswer`; a route that
 * words its own refusal answers `rateLimitedResponse`. A route once replaced
 * the code with its own (`rate`) and dropped the header, so the page could
 * only say "wait a moment".
 */
import { positiveSeconds, refusalWaitSeconds } from "./rate-limit-wait";

export const RATE_LIMITED_CODE = "rate_limited";

/** The wait an API answer names: its `Retry-After`, else its body's `retryAfterSeconds`. */
export function apiAnswerWaitSeconds(upstream: Pick<Response, "headers">, body: unknown): number | undefined {
  return positiveSeconds(upstream.headers.get("Retry-After")) ?? refusalWaitSeconds(body);
}

function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** A JSON refusal for a rate limit, in the buyer's words, with the API's code and wait. */
export function rateLimitedResponse(message: string, retryAfterSeconds?: number, headers: HeadersInit = {}): Response {
  const out = new Headers({ "Content-Type": "application/json", "Cache-Control": "private, no-store" });
  for (const [name, value] of new Headers(headers)) out.set(name, value);
  if (retryAfterSeconds) out.set("Retry-After", String(retryAfterSeconds));
  return new Response(JSON.stringify({
    success: false,
    error: { code: RATE_LIMITED_CODE, message, ...(retryAfterSeconds ? { details: { retryAfterSeconds } } : {}) },
  }), { status: 429, headers: out });
}

/**
 * A route that keeps its own refusal body (the cart check's, the order's)
 * still says the wait: its body's details and `Retry-After` carry it.
 */
export function withRateLimitWait(details: unknown, retryAfterSeconds: number | undefined): { details: unknown; headers: Record<string, string> } {
  if (!retryAfterSeconds) return { details, headers: {} };
  const base = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : {};
  return { details: { ...base, retryAfterSeconds }, headers: { "Retry-After": String(retryAfterSeconds) } };
}

/**
 * The API's answer relayed with the route's own headers: a 429 keeps its
 * wait in `Retry-After` (from the API's header or its body).
 */
export function relayApiAnswer(upstream: Response, body: string, headers: HeadersInit): Response {
  const out = new Headers(headers);
  if (upstream.status === 429) {
    const wait = apiAnswerWaitSeconds(upstream, parsed(body));
    if (wait) out.set("Retry-After", String(wait));
  }
  return new Response(body, { status: upstream.status, headers: out });
}
