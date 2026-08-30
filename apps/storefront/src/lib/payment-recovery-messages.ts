import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";

export type PaymentRecoveryOperation = "send" | "verify";

export interface PaymentRecoveryFailureContext {
  copy: CheckoutLanguageData;
  operation: PaymentRecoveryOperation;
  errorCode?: string;
  status: number;
}

const RATE_LIMIT_CODES = new Set([
  "RATE_LIMIT_EXCEEDED",
  "RATE_LIMIT_ERROR",
  "TOO_MANY_REQUESTS",
]);

/**
 * Recovery APIs expose stable classification only. Buyer-facing text always
 * comes from the active checkout language rather than provider/API prose.
 */
export function getPaymentRecoveryFailureText({
  copy,
  operation,
  errorCode,
  status,
}: PaymentRecoveryFailureContext): string {
  if (status === 429 || (errorCode && RATE_LIMIT_CODES.has(errorCode))) {
    return copy.paymentRecoveryRateLimitedText;
  }

  return operation === "send"
    ? copy.paymentRecoverySendFailedText
    : copy.paymentRecoveryVerificationFailedText;
}
