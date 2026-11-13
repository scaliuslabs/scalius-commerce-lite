// The one way the platform calls a provider over the internet (email, Meta,
// Google, TikTok, WhatsApp): every call carries a deadline. Provider sends
// run after the response (`waitUntil`, cut off about 30 s later) or in the
// scheduled drains, so a hung provider must fail fast enough for the
// row to be retried, never hang until the platform kills the invocation and
// the row waits out its lease. `scripts/check-source-policies.mjs` refuses a
// bare `fetch(` to a provider anywhere else in apps/api and packages/core.
// The other outbound calls use it too: a merchant's webhook endpoint, an
// app's own egress, an app release download and a staff media import from a
// URL, each also passing the outbound URL guard (@scalius/shared/outbound-url).

/** The longest deadline a provider call may ask for: it must end well inside the after-response window. */
export const MAX_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * The longest deadline for a call made while a request or an app's run waits
 * for it (a dashboard media import, an app's own http.fetch inside its wall
 * time of at most 30 s): that request or run ends it anyway, so it may wait
 * longer than work done after the response. Ask for it with `withinRequest`.
 */
export const MAX_IN_REQUEST_TIMEOUT_MS = 30_000;

/** The usual deadline: a provider that has not answered in 10 s is treated as down, and the send is retried. */
export const PROVIDER_TIMEOUT_MS = 10_000;

export interface ProviderFetchOptions {
  /** The call's deadline (1 ms to MAX_PROVIDER_TIMEOUT_MS, or MAX_IN_REQUEST_TIMEOUT_MS `withinRequest`): it aborts the request and the body read. */
  timeoutMs: number;
  /** The call runs while a request or an app's run waits for it, never after the response. */
  withinRequest?: boolean;
  /** The caller's own cancellation, combined with the deadline. */
  signal?: AbortSignal;
  /** Tests inject a fetch; production uses the global one. */
  fetcher?: typeof fetch;
}

/** A provider call that ran out of time: retryable, like a lost connection. */
export class ProviderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The provider did not answer within ${timeoutMs} ms`);
    this.name = "ProviderTimeoutError";
  }
}

export async function providerFetch(input: string | URL, init: RequestInit, options: ProviderFetchOptions): Promise<Response> {
  const { timeoutMs } = options;
  const ceiling = options.withinRequest ? MAX_IN_REQUEST_TIMEOUT_MS : MAX_PROVIDER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > ceiling) {
    throw new RangeError(`An outbound call needs a deadline between 1 and ${ceiling} ms`);
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    return await (options.fetcher ?? fetch)(input, { ...init, signal });
  } catch (error) {
    if (deadline.aborted && !options.signal?.aborted) throw new ProviderTimeoutError(timeoutMs);
    throw error;
  }
}
