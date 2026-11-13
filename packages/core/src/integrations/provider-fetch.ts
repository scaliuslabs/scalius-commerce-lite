// The one way the platform calls a provider over the internet (email, Meta,
// Google, TikTok, WhatsApp): every call carries a deadline. Provider sends
// run after the response (`waitUntil`, cut off about 30 s later) or in the
// scheduled drains, so a hung provider must fail fast enough for the
// row to be retried, never hang until the platform kills the invocation and
// the row waits out its lease. `scripts/check-source-policies.mjs` refuses a
// bare `fetch(` to a provider anywhere else in apps/api and packages/core.

/** The longest deadline a provider call may ask for: it must end well inside the after-response window. */
export const MAX_PROVIDER_TIMEOUT_MS = 20_000;

/** The usual deadline: a provider that has not answered in 10 s is treated as down, and the send is retried. */
export const PROVIDER_TIMEOUT_MS = 10_000;

export interface ProviderFetchOptions {
  /** The call's deadline (1 ms to MAX_PROVIDER_TIMEOUT_MS): it aborts the request and the body read. */
  timeoutMs: number;
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_PROVIDER_TIMEOUT_MS) {
    throw new RangeError(`A provider call needs a deadline between 1 and ${MAX_PROVIDER_TIMEOUT_MS} ms`);
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
