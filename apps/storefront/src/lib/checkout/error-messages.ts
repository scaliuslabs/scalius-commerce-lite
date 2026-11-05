import { buyerApiErrorKind } from "../buyer-api-errors";
import { checkoutRateLimitedText, refusalWaitSeconds } from "../rate-limit-wait";
import type { CheckoutLanguageData, CheckoutLanguageKey } from "@scalius/shared/checkout-language";

const DEFAULT_CHECKOUT_ERROR = "Order creation failed";

type ErrorRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ErrorRecord {
  return typeof value === "object" && value !== null;
}

function parseJsonErrorString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed || !["[", "{"].includes(trimmed[0])) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectMessages(value: unknown): string[] {
  if (typeof value === "string") {
    const parsed = parseJsonErrorString(value);
    if (parsed !== null) return collectMessages(parsed);

    const message = value.trim();
    return message && message !== "[object Object]" ? [message] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectMessages(item));
  }

  if (!isRecord(value)) return [];

  const messages: string[] = [];

  for (const key of ["details", "issues", "errors", "itemIssues", "lineIssues"]) {
    if (key in value) {
      messages.push(...collectMessages(value[key]));
    }
  }

  if ("error" in value) {
    messages.push(...collectMessages(value.error));
  }

  if (typeof value.message === "string") {
    messages.push(...collectMessages(value.message));
  }

  return messages;
}

export function getCheckoutErrorMessage(
  error: unknown,
  fallback = DEFAULT_CHECKOUT_ERROR,
): string {
  const messages = collectMessages(error);
  const uniqueMessages = [...new Set(messages.map((message) => message.trim()))]
    .filter(Boolean)
    .filter((message) => message !== "Invalid input data");

  if (uniqueMessages.length > 0) {
    return uniqueMessages.join(". ");
  }

  return fallback;
}

/**
 * Order refusals use the merchant's checkout catalogue, never API prose. A
 * rate limit says the wait its `details.retryAfterSeconds` names.
 */
export function checkoutOrderFailureText(
  status: number | undefined,
  _message: string,
  copy: CheckoutLanguageData,
  errorCode?: string,
  details?: unknown,
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
    case "appUnavailable": return copy.checkoutAppUnavailableText;
    case "paymentWindowExpired": return copy.paymentRateExpiredText;
    case "priceChanged": return copy.totalChangedReviewText;
    case "stock": case "notFound": return copy.cartItemChangedText;
    default: return copy.orderProcessingFailedText;
  }
}

/**
 * A checkout failure the buyer reads: it names its words by checkout-language
 * key, so they are the page's language and the merchant's edits. The message
 * is the developer's detail and stays internal.
 */
export class CheckoutCopyError extends Error {
  constructor(readonly copyKey: CheckoutLanguageKey, detail?: string) {
    super(detail ?? copyKey);
    this.name = "CheckoutCopyError";
  }
}

/** A failure already selected from the buyer's page catalogue. */
export class CheckoutBuyerMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutBuyerMessage";
  }
}

/**
 * The buyer's words for a failure: its own copy key or buyer message, else
 * `fallback`'s copy. A raw error message never reaches the page.
 */
export function checkoutFailureText(
  error: unknown,
  copy: CheckoutLanguageData,
  fallback: CheckoutLanguageKey,
): string {
  if (error instanceof CheckoutBuyerMessage) return error.message;
  return copy[error instanceof CheckoutCopyError ? error.copyKey : fallback];
}
