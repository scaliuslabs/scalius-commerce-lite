// Merchant transaction references sent to hosted gateways. They are context
// for matching a return to a server-created attempt, never payment authority.
// Most Bangladeshi gateways cap the reference at 30 characters.

import { ValidationError } from "@scalius/core/errors";
import type { PaymentType } from "./port";

const SUFFIX_LENGTH = 8;
export const PAYMENT_CORRELATION_ID_MAX_LENGTH = 30;
const PAYMENT_TYPE_CODE = { full: "F", deposit: "D", balance: "B" } as const;

export function buildPaymentCorrelationId(
  orderId: string,
  paymentType: PaymentType,
  suffix: string = crypto.randomUUID(),
): string {
  const normalizedSuffix = suffix.replace(/[^a-zA-Z0-9]/g, "").slice(0, SUFFIX_LENGTH).toUpperCase();
  const readable = `${orderId}_${paymentType}_${normalizedSuffix}`;
  if (readable.length <= PAYMENT_CORRELATION_ID_MAX_LENGTH) return readable;

  const compact = `${orderId}_${PAYMENT_TYPE_CODE[paymentType]}${normalizedSuffix}`;
  if (compact.length > PAYMENT_CORRELATION_ID_MAX_LENGTH) {
    throw new ValidationError(`Payment transaction ID exceeds ${PAYMENT_CORRELATION_ID_MAX_LENGTH} characters.`);
  }
  return compact;
}

export function parsePaymentCorrelationId(value: string): { orderId: string; paymentType: PaymentType | null } {
  const readable = /^(.+)_(full|deposit|balance)_([a-zA-Z0-9]{6,32})$/.exec(value);
  if (readable) return { orderId: readable[1]!, paymentType: readable[2] as PaymentType };

  const compact = /^(.+)_([FDB])([a-zA-Z0-9]{6,8})$/.exec(value);
  if (compact) {
    const paymentType = ({ F: "full", D: "deposit", B: "balance" } as const)[compact[2] as "F" | "D" | "B"];
    return { orderId: compact[1]!, paymentType };
  }
  return { orderId: value, paymentType: null };
}
