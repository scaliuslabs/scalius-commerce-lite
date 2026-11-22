// The time budget of each request a checkout press can wait on, in one place,
// so the press's own limit (submit-machine.ts SUBMIT_STEP_LIMIT_MS) follows
// them: a change to a retry budget moves the limit with it.

/** Waits between repeats of a cart check or a quote that failed in transit. */
export const QUOTE_RETRY_DELAYS_MS = [500, 1500] as const;
/** One attempt of the cart's availability check. */
export const CART_VALIDATION_TIMEOUT_MS = 10_000;
/** One attempt of the tax quote. */
export const TAX_QUOTE_TIMEOUT_MS = 10_000;
/** Waits between repeats of a delivery rates read that failed in transit. */
export const DELIVERY_RATES_RETRY_DELAYS_MS = [400, 1200] as const;
/** One attempt of the delivery rates read. */
export const DELIVERY_RATES_TIMEOUT_MS = 8_000;

/** The longest a request repeated after failures in transit can take: every attempt timing out, and the waits between. */
export function retriedRequestMs(timeoutMs: number, delays: readonly number[]): number {
  return timeoutMs * (delays.length + 1) + delays.reduce((total, delay) => total + delay, 0);
}

/** The longest any one of those requests can take. */
export const LONGEST_CHECK_MS = Math.max(
  retriedRequestMs(CART_VALIDATION_TIMEOUT_MS, QUOTE_RETRY_DELAYS_MS),
  retriedRequestMs(TAX_QUOTE_TIMEOUT_MS, QUOTE_RETRY_DELAYS_MS),
  retriedRequestMs(DELIVERY_RATES_TIMEOUT_MS, DELIVERY_RATES_RETRY_DELAYS_MS),
);
