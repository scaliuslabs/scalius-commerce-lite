import {
  normalizeSupportedCurrencyCode,
  getDecimalPlaces,
  type SupportedCurrencyCode,
} from "@scalius/shared/currency";
import { ValidationError } from "@scalius/core/errors";

/** The currency an order was committed in; its amounts are minor units of it. */
export interface OrderCurrencySnapshot {
  code: SupportedCurrencyCode;
  decimalPlaces: number;
}

export interface OrderCurrencySnapshotSource {
  currencyCode: unknown;
  currencyDecimalPlaces: unknown;
}

/** Validates the currency stored with an order; a corrupt snapshot fails closed. */
export function resolveOrderCurrencySnapshot(
  source: OrderCurrencySnapshotSource,
): OrderCurrencySnapshot {
  const code = normalizeSupportedCurrencyCode(source.currencyCode);
  if (!code) {
    throw new ValidationError("Order currency snapshot is invalid. Repair the order before changing payment state.");
  }
  const decimalPlaces = source.currencyDecimalPlaces;
  if (!Number.isInteger(decimalPlaces) || Number(decimalPlaces) < 0 || Number(decimalPlaces) > 3) {
    throw new ValidationError("Order currency precision is invalid. Repair the order before changing payment state.");
  }
  return { code, decimalPlaces: Number(decimalPlaces) };
}

export function createOrderCurrencySnapshot(currencyCode: unknown): OrderCurrencySnapshot {
  const code = normalizeSupportedCurrencyCode(currencyCode);
  if (!code) {
    throw new ValidationError("A supported order currency is required.");
  }
  return { code, decimalPlaces: getDecimalPlaces(code) };
}

export function assertOrderPaymentCurrency(
  value: unknown,
  currency: OrderCurrencySnapshot,
  label = "Payment",
): void {
  if (normalizeSupportedCurrencyCode(value) !== currency.code) {
    throw new ValidationError(
      `${label} currency does not match the immutable order currency. Repair the payment ledger before continuing.`,
    );
  }
}
