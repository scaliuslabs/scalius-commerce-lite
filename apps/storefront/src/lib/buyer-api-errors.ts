import { buyerApiErrorCopy, type BuyerApiErrorKind } from "./buyer-api-error-copy";
import { checkoutText } from "./checkout-text";
import { pageWait, refusalWaitSeconds } from "./rate-limit-wait";
import { pageLanguage } from "./store-time-zone";

const CODE_KIND: Readonly<Record<string, BuyerApiErrorKind>> = {
  unauthorized: "signIn", customer_sign_in_required: "signIn", authentication_required: "signIn",
  forbidden: "forbidden", not_found: "notFound", conflict: "conflict",
  validation_error: "invalid", invalid_input: "invalid", bad_request: "invalid",
  rate_limited: "rateLimited", too_many_requests: "rateLimited",
  code_recently_sent: "codeJustSent", code_limit_reached: "codeLimitReached",
  invalid_code: "wrongCode", invalid_otp: "wrongCode", otp_expired: "expiredCode", code_expired: "expiredCode",
  otp_unavailable: "codesUnavailable", code_channel_unavailable: "codesUnavailable", no_code_channel: "noCodeChannel",
  quantity_unavailable: "stock", insufficient_stock: "stock", out_of_stock: "stock",
  variant_required: "variantRequired", variant_mismatch: "variantRequired",
  properties_required: "propertiesInvalid", properties_invalid: "propertiesInvalid",
  confirmation_required: "confirmationRequired", decision_required: "decisionRequired",
  checkout_app_unavailable: "appUnavailable",
  fulfilment_unavailable: "fulfilmentUnavailable", purchase_option_unavailable: "purchaseOptionUnavailable",
  purchase_options_conflict: "purchaseOptionsConflict", add_on_unavailable: "addOnUnavailable",
  upload_unavailable: "uploadUnavailable",
  product_unavailable: "notFound", variant_unavailable: "notFound",
  price_changed: "priceChanged", storefront_checkout_quote_conflict: "priceChanged",
  payment_rate_expired: "paymentWindowExpired",
  checkout_expired: "checkoutExpired",
  payment_attempts_exhausted: "paymentAttemptsExhausted",
  payment_session_processing: "processing", payment_session_processing_timeout: "processing",
  service_unavailable: "unavailable", internal_server_error: "unavailable",
  card_declined: "cardDeclined", expired_card: "cardExpiry",
  invalid_number: "cardNumber", incomplete_number: "cardNumber", incorrect_number: "cardNumber",
  incorrect_cvc: "cardCvc", invalid_cvc: "cardCvc", incomplete_cvc: "cardCvc",
  invalid_expiry_month: "cardExpiry", invalid_expiry_year: "cardExpiry", invalid_expiry_year_past: "cardExpiry", incomplete_expiry: "cardExpiry",
  incorrect_zip: "cardPostal", incomplete_zip: "cardPostal", invalid_zip: "cardPostal",
  payment_intent_authentication_failure: "cardAuthentication",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Select catalogue keys from machine fields only. API and provider prose is never buyer copy. */
export function buyerApiErrorKind(payload: unknown, status?: number): BuyerApiErrorKind | undefined {
  const outer = record(payload);
  const inner = record(outer?.error) ?? outer;
  const rawCode = typeof payload === "string" ? payload : inner?.code ?? inner?.errorCode ?? outer?.errorCode;
  const code = typeof rawCode === "string" ? rawCode.toLowerCase() : undefined;
  // Server failures never expose a validation or provider detail even if its code is recognized.
  if (status === 0 || status === 408 || (status !== undefined && status >= 500)) return "unavailable";
  const details = record(inner?.details) ?? record(outer?.details);
  if ((code === "validation_error" || code === "invalid_code" || code === "invalid_otp") && typeof details?.attemptsLeft === "number") {
    return details.attemptsLeft <= 0 ? "expiredCode" : "wrongCode";
  }
  const reason = details?.reason;
  if (typeof reason === "string" && Object.hasOwn(CODE_KIND, reason)) return CODE_KIND[reason];
  if (typeof inner?.decline_code === "string" && inner.decline_code) return "cardDeclined";
  if (typeof code === "string" && Object.hasOwn(CODE_KIND, code)) return CODE_KIND[code];
  switch (status) {
    case 400: case 422: return "invalid";
    case 401: return "signIn";
    case 403: return "forbidden";
    case 404: case 410: return "notFound";
    case 409: return "conflict";
    case 429: return "rateLimited";
    default: return undefined;
  }
}

/**
 * A rate limit in the page's words: the wait the API named ("Try again in
 * 11:10", the page's digits), else a sentence that promises no time.
 */
export function rateLimitedText(seconds: number | undefined, locale: string = pageLanguage()): string {
  const copy = buyerApiErrorCopy(locale);
  return seconds ? checkoutText(copy.rateLimitedWait, { time: pageWait(seconds, locale) }) : copy.rateLimited;
}

/**
 * Use the rendered page's language by default; callers may supply their
 * localized operation fallback. A rate limit says the wait its body
 * (`details.retryAfterSeconds`) or `headers` (Retry-After) name, unless the
 * caller counts that wait down itself (`showWait: false`).
 */
export function buyerApiErrorText(
  payload: unknown,
  options: { locale?: string | null; status?: number; fallback?: string; headers?: Pick<Headers, "get"> | null; showWait?: boolean } = {},
): string {
  const locale = options.locale ?? pageLanguage();
  const copy = buyerApiErrorCopy(locale);
  const kind = buyerApiErrorKind(payload, options.status);
  if (kind === "rateLimited") {
    return rateLimitedText(options.showWait === false ? undefined : refusalWaitSeconds(payload, options.headers), locale);
  }
  return kind ? copy[kind] : options.fallback ?? copy.failed;
}
