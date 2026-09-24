// Shared by the two "prove it's your order with a code" pages: Track your
// order (order number + phone) and Finish paying (payment-recovery link).
// Browser-safe: no transport imports.
import {
  formatCheckoutLanguageText,
  type CheckoutLanguageData,
} from "@scalius/shared/checkout-language";
import { normalizeBdMobile, toLatinDigits } from "@scalius/shared/phone-input";

/** The API's resend wait when a response doesn't say (core OTP cooldown). */
export const DEFAULT_RESEND_AFTER_SECONDS = 60;

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

export type OrderLookupInput =
  | { ok: true; reference: string; phone: string }
  | { ok: false; field: "reference" | "phone" };

/** Checks the lookup form the same way with or without JavaScript. */
export function readOrderLookupInput(reference: string, phone: string): OrderLookupInput {
  const normalizedReference = normalizeOrderReference(reference);
  if (!normalizedReference) return { ok: false, field: "reference" };
  const normalizedPhone = normalizeBdMobile(phone);
  if (!normalizedPhone) return { ok: false, field: "phone" };
  return { ok: true, reference: normalizedReference, phone: normalizedPhone };
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
 * Buyer copy for a failed send or verify, in the active checkout language.
 * Waits and remaining attempts are said plainly; the API's prose is not shown.
 */
export function getOrderCodeFailureText(
  copy: CheckoutLanguageData,
  failure: Pick<OrderCodeFailure, "status" | "retryAfterSeconds" | "attemptsLeft">,
  operation: "send" | "verify",
  unavailableText: string,
): string {
  if (failure.status === 429) {
    return failure.retryAfterSeconds
      ? formatCheckoutLanguageText(copy.orderCodeTryAgainInText, { time: formatCountdown(failure.retryAfterSeconds) })
      : copy.paymentRecoveryRateLimitedText;
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
