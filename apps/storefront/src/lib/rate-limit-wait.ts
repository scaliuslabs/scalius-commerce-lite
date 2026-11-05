// The wait a refused (429) request names, carried from the API to the words a
// buyer reads. The API sends it twice for its rate limits: `Retry-After` and
// `error.details.retryAfterSeconds`. A page says that wait ("Try again in
// 11:10", Bangla digits on a Bangla page) or, when the API named none, a
// sentence that promises no particular time. Browser-safe: no transport.
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { checkoutText } from "./checkout-text";
import { formatPageNumber, pageLanguage } from "./store-time-zone";

/** A positive whole number of seconds, else undefined. */
export function positiveSeconds(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The wait a refusal names: `details.retryAfterSeconds` in its JSON body (the
 * envelope's `error.details`, a bare `details` object, or the storefront
 * proxies' own `retryAfterSeconds`), else its `Retry-After` header in seconds.
 */
export function refusalWaitSeconds(payload: unknown, headers?: Pick<Headers, "get"> | null): number | undefined {
  const outer = record(payload);
  const inner = record(outer?.error);
  const details = record(inner?.details) ?? record(outer?.details);
  return positiveSeconds(details?.retryAfterSeconds)
    ?? positiveSeconds(outer?.retryAfterSeconds)
    ?? positiveSeconds(headers?.get("Retry-After"));
}

/**
 * "2:00", "0:45": a wait as a clock, its digits written by `digits` (the
 * page's: "২:০০" on a Bangla page through `pageWait`).
 */
export function formatWait(seconds: number, digits: (value: number) => string = String): string {
  const total = Math.max(0, Math.ceil(seconds));
  const rest = total % 60;
  return `${digits(Math.floor(total / 60))}:${rest < 10 ? digits(0) : ""}${digits(rest)}`;
}

/** A wait in the page's digits: "11:10", "১১:১০" on a Bangla page. */
export function pageWait(seconds: number, language: string = pageLanguage()): string {
  return formatWait(seconds, (value) => formatPageNumber(value, language));
}

/**
 * A rate limit in the store's checkout wording: its "Try again in {time}"
 * with the wait the API named, else `unknownWait`, the merchant's sentence for
 * that refusal, which names no time.
 */
export function checkoutRateLimitedText(
  copy: Pick<CheckoutLanguageData, "orderCodeTryAgainInText">,
  unknownWait: string,
  seconds: number | undefined,
  language: string = pageLanguage(),
): string {
  return seconds ? checkoutText(copy.orderCodeTryAgainInText, { time: pageWait(seconds, language) }) : unknownWait;
}

/**
 * A plain form post comes back by redirect, so the wait travels in the return
 * address as the moment it ends (Unix seconds), never as a duration: a reload
 * a minute later still reads the true time left. A wait is not buyer data.
 */
export const RETRY_AT_PARAM = "retryAt";
/** Longer than any limiter window: a larger value is not a wait this store set. */
const MAX_WAIT_SECONDS = 24 * 60 * 60;

/** `url` with the moment `seconds` from now ends, or without any when there is no wait. */
export function setRetryAt(url: URL, seconds: number | undefined, nowMs: number = Date.now()): URL {
  url.searchParams.delete(RETRY_AT_PARAM);
  const wait = positiveSeconds(seconds);
  if (wait && wait <= MAX_WAIT_SECONDS) url.searchParams.set(RETRY_AT_PARAM, String(Math.ceil(nowMs / 1000) + wait));
  return url;
}

/** The seconds left of a wait a return address carries, or undefined once it has passed. */
export function readRetryAt(params: URLSearchParams, nowMs: number = Date.now()): number | undefined {
  const raw = params.get(RETRY_AT_PARAM);
  if (!raw || !/^\d{1,12}$/.test(raw)) return undefined;
  const left = positiveSeconds(Number(raw) - nowMs / 1000);
  return left && left <= MAX_WAIT_SECONDS ? left : undefined;
}
