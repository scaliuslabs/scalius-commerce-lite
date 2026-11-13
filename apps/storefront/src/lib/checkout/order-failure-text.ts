// The words of a refused order (`checkoutOrderFailureText`): they read the API
// error catalogue, so this module loads with a refusal, never with the cart
// page's or the payment step's first paint (scripts/client-chunk-graph.mjs).
import { buyerApiErrorKind } from "../buyer-api-errors";
import { buyerApiErrorCopy } from "../buyer-api-error-copy";
import { checkoutText } from "../checkout-text";
import { pageLanguage } from "../store-time-zone";
import { checkoutRateLimitedText, refusalWaitSeconds } from "../rate-limit-wait";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Order refusals use the merchant's checkout catalogue, never API prose. A
 * rate limit says the wait its `details.retryAfterSeconds` names.
 */
/** The order's lines, to name the item and input a refusal is about. */
type FailureLines = ReadonlyArray<{ productName: string; variantLabel?: string | null; properties?: ReadonlyArray<{ key: string; label: string }> }>;

/**
 * A file the order could not take (`upload_unavailable`: already sent with
 * another order, expired, or copied from another device): the real reason
 * and what to do, naming the input and item when the refusal names its key.
 */
function uploadUnavailableText(details: unknown, lines: FailureLines | undefined, locale: string): string {
  const words = buyerApiErrorCopy(locale);
  const key = isRecord(details) && typeof details.key === "string" ? details.key : null;
  for (const line of key ? lines ?? [] : []) {
    const input = line.properties?.find((property) => property.key === key);
    if (input) {
      const item = line.variantLabel ? `${line.productName} (${line.variantLabel})` : line.productName;
      return checkoutText(words.uploadUnavailableNamed, { input: input.label, item });
    }
  }
  return words.uploadUnavailable;
}

export function checkoutOrderFailureText(
  status: number | undefined,
  _message: string,
  copy: CheckoutLanguageData,
  errorCode?: string,
  details?: unknown,
  context: { lines?: FailureLines; locale?: string } = {},
): string {
  if (status !== undefined && status >= 500) {
    return status >= 502 && status <= 504 ? copy.checkoutUnavailableMessage : copy.orderProcessingFailedText;
  }
  const kind = buyerApiErrorKind({ errorCode, details }, status);
  switch (kind) {
    case "signIn": return copy.signInToCheckoutText;
    case "conflict": return copy.checkoutConflictText;
    case "rateLimited": return checkoutRateLimitedText(copy, copy.tooManyCheckoutAttemptsText, refusalWaitSeconds({ details }));
    case "purchaseOptionUnavailable": return copy.checkoutUnavailableMessage;
    // Not a checkout-language phrase (merchants never word it): the storefront catalogue, in the page's language.
    case "purchaseOptionsConflict": return buyerApiErrorCopy(pageLanguage()).purchaseOptionsConflict;
    // Not "changed in another tab": the file itself is the reason, and the line says what to do.
    case "uploadUnavailable": return uploadUnavailableText(details, context.lines, context.locale ?? pageLanguage());
    case "appUnavailable": return copy.checkoutAppUnavailableText;
    case "paymentWindowExpired": return copy.paymentRateExpiredText;
    case "priceChanged": return copy.totalChangedReviewText;
    case "stock": case "notFound": return copy.cartItemChangedText;
    default: return copy.orderProcessingFailedText;
  }
}

