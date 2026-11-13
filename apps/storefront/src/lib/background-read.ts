// A read the browser makes in the background, straight to the public API or
// a storefront route (filter counts, "See more" facets, cart
// recommendations, product data, a receipt's status). The API answers a busy
// client 429 with `Retry-After` (its `read` class). Such a read is never the
// buyer's error: the screen keeps what it shows, the read waits the stated
// delay (at least a doubling backoff, at most a minute) and tries again a few
// times, then gives up quietly. Callers show no toast and no broken panel for
// it. Browser-safe: no transport, no copy.

/** The longest one throttled wait; a longer stated wait gives up at once (the screen stays as it is). */
export const BACKGROUND_READ_MAX_WAIT_MS = 60_000;
/** The first wait when the API names none; it doubles each time. */
const FIRST_WAIT_MS = 2_000;
/** Tries in all, the first included. */
const DEFAULT_ATTEMPTS = 3;

/** The wait a 429 names in `Retry-After` (seconds, or an HTTP date), in ms; undefined when it names none. */
export function retryAfterMs(response: Pick<Response, "headers">, now: number = Date.now()): number | undefined {
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1_000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * How long to wait before try `attempt + 1` of a throttled read: the stated
 * wait or the backoff (2, 4, 8 s...), whichever is longer, with a little jitter
 * so tabs that were throttled together do not return together. Null when the
 * stated wait is longer than BACKGROUND_READ_MAX_WAIT_MS: give up for now.
 */
export function throttledWaitMs(response: Pick<Response, "headers">, attempt: number, random: () => number = Math.random): number | null {
  const stated = retryAfterMs(response);
  if (stated !== undefined && stated > BACKGROUND_READ_MAX_WAIT_MS) return null;
  const backoff = FIRST_WAIT_MS * 2 ** Math.max(0, attempt);
  const wait = Math.max(stated ?? 0, backoff);
  return Math.min(BACKGROUND_READ_MAX_WAIT_MS, Math.round(wait * (1 + random() * 0.2)));
}

function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export interface BackgroundReadOptions {
  /** Tries in all (default 3). */
  attempts?: number;
  /** The caller moved on (a newer filter state, the drawer closed): stop waiting. */
  signal?: AbortSignal;
  /** Tests replace the clock. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  random?: () => number;
}

/**
 * The read's first answer that is not a 429, or null when it stayed
 * throttled (or the caller moved on while it waited): the caller then keeps
 * what is on screen. Other statuses and network errors are the caller's, as
 * before.
 */
export async function readInBackground(read: () => Promise<Response>, options: BackgroundReadOptions = {}): Promise<Response | null> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const wait = options.wait ?? delay;
  for (let attempt = 0; ; attempt += 1) {
    const response = await read();
    if (response.status !== 429) return response;
    await response.body?.cancel().catch(() => undefined);
    const ms = attempt + 1 < attempts ? throttledWaitMs(response, attempt, options.random) : null;
    if (ms === null || !(await wait(ms, options.signal))) return null;
  }
}
