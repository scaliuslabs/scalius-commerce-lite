// Shared by the two "prove it's your order with a code" pages: Track your
// order (order number, then a code for full details) and Finish paying
// (payment-recovery link).
// Browser-safe: no transport imports.
import {
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import { toLatinDigits } from "@scalius/shared/phone-input";

/** The API's resend wait when a response doesn't say (core OTP cooldown). */
export const DEFAULT_RESEND_AFTER_SECONDS = 60;

/** No channel the store chose reaches a contact on the order: say so and show the store's contact. */
export const NO_CODE_CHANNEL = "NO_CODE_CHANNEL";
/** The store's chosen channel can't send right now (fail closed, never another channel). */
export const CODE_CHANNEL_UNAVAILABLE = "CODE_CHANNEL_UNAVAILABLE";

/**
 * A failure the buyer can't fix on this page (no code channel, codes
 * unavailable): the page adds the store's contact links, when it has any.
 */
export function failureNeedsStoreContact(failure: { status: number; errorCode?: string }): boolean {
  return failure.errorCode === NO_CODE_CHANNEL || failure.errorCode === CODE_CHANNEL_UNAVAILABLE || failure.status === 503;
}

/** What a failed send/verify tells the page; never the receipt token. */
export interface OrderCodeFailure {
  status: number;
  errorCode: string;
  message?: string;
  retryAfterSeconds?: number;
  attemptsLeft?: number;
}

/** "#1001", "1001", "১০০১" or an internal order id; null when it can't be one. */
export function normalizeOrderReference(raw: string | null | undefined): string | null {
  const reference = toLatinDigits(raw ?? "").trim().replace(/^#\s*/, "");
  return /^[A-Za-z0-9]{4,32}$/.test(reference) ? reference : null;
}

/** The lookup form's one field, checked the same way with or without JavaScript. */
export function getOrderLookupFieldErrors(
  copy: Pick<CheckoutLanguageData, "trackOrderNumberInvalidText">,
  reference: string,
): Partial<Record<"reference", string>> {
  return normalizeOrderReference(reference) ? {} : { reference: copy.trackOrderNumberInvalidText };
}

/** 45 → "0:45", 120 → "2:00". */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A positive whole number of seconds, else undefined. */
export function positiveSeconds(value: unknown): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

/**
 * Buyer copy for a failed send or verify. Waits and remaining attempts come
 * from the active checkout language; the API's own sentence is shown only
 * where it says something the page can't: why a send was refused (no such
 * order, no way to reach the buyer, too many codes).
 */
export function getOrderCodeFailureText(
  copy: CheckoutLanguageData,
  failure: Pick<OrderCodeFailure, "status" | "message" | "retryAfterSeconds" | "attemptsLeft">,
  operation: "send" | "verify",
  unavailableText: string,
): string {
  if (failure.status === 429) {
    if (!failure.retryAfterSeconds) return failure.message || copy.paymentRecoveryRateLimitedText;
    const wait = formatCheckoutLanguageText(copy.orderCodeTryAgainInText, { time: formatCountdown(failure.retryAfterSeconds) });
    return failure.message ? `${failure.message} ${wait}.` : wait;
  }
  if (operation === "send" && failure.message && (failure.status === 404 || failure.status === 409)) {
    return failure.message;
  }
  if (operation === "verify" && typeof failure.attemptsLeft === "number") {
    if (failure.attemptsLeft <= 0) return copy.orderCodeExpiredText;
    return failure.attemptsLeft === 1
      ? copy.orderCodeWrongOneAttemptText
      : formatCheckoutLanguageText(copy.orderCodeWrongAttemptsText, { count: failure.attemptsLeft });
  }
  if (failure.status === 503) return unavailableText;
  return operation === "send" ? copy.paymentRecoverySendFailedText : copy.paymentRecoveryVerificationFailedText;
}

/** What the page shows after a refused "Send code", with or without JavaScript. */
export interface OrderCodeSendRefusal {
  message: string;
  /** Show the code field: the code already sent still works. */
  codeSent: boolean;
  /** The wait before a new code, counted on the resend button. */
  resendAfterSeconds: number;
  needsStoreContact: boolean;
}

/**
 * A rate-limited send ("A code was just sent", "Enter the latest code we
 * sent") leaves the last code usable, so the code field opens and the wait
 * moves to the resend button. Without that, a buyer who reloads the page or
 * comes back from their inbox is told to wait up to ten minutes with no field
 * for the code they already have.
 */
export function describeOrderCodeSendRefusal(
  copy: CheckoutLanguageData,
  failure: Pick<OrderCodeFailure, "status" | "message" | "retryAfterSeconds"> & { errorCode?: string },
  unavailableText: string,
): OrderCodeSendRefusal {
  if (failure.status === 429) {
    return {
      message: getOrderCodeFailureText(copy, { ...failure, retryAfterSeconds: undefined }, "send", unavailableText),
      codeSent: true,
      resendAfterSeconds: positiveSeconds(failure.retryAfterSeconds) ?? 0,
      needsStoreContact: false,
    };
  }
  return {
    message: getOrderCodeFailureText(copy, failure, "send", unavailableText),
    codeSent: false,
    resendAfterSeconds: 0,
    needsStoreContact: failureNeedsStoreContact(failure),
  };
}
