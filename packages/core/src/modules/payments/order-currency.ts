import {
  DEFAULT_CURRENCY,
  getDecimalPlaces,
  normalizeSupportedCurrencyCode,
  type SupportedCurrencyCode,
} from "@scalius/shared/currency";
import { roundPriceToPrecision } from "@scalius/shared/price-utils";
import { ValidationError } from "@scalius/core/errors";

export interface OrderCurrencySnapshot {
  code: SupportedCurrencyCode;
  decimalPlaces: number;
  legacyFallback: boolean;
}

export interface OrderCurrencySnapshotSource {
  currencyCode?: unknown;
  currencyDecimalPlaces?: unknown;
  code?: unknown;
  decimalPlaces?: unknown;
}

function isStoredCurrencyPrecision(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;
}

/**
 * Resolve the immutable currency snapshot stored with an order.
 * Only orders with both legacy snapshot columns absent fall back to BDT.
 */
export function resolveOrderCurrencySnapshot(
  source: OrderCurrencySnapshotSource,
): OrderCurrencySnapshot {
  const rawCode = source.currencyCode ?? source.code;
  const rawPrecision = source.currencyDecimalPlaces ?? source.decimalPlaces;
  if (rawCode == null && rawPrecision == null) {
    return {
      code: "BDT",
      decimalPlaces: DEFAULT_CURRENCY.decimalPlaces,
      legacyFallback: true,
    };
  }

  const code = normalizeSupportedCurrencyCode(rawCode);
  if (!code) {
    throw new ValidationError("Order currency snapshot is invalid. Repair the order before changing payment state.");
  }
  if (rawPrecision == null) {
    return {
      code,
      decimalPlaces: getDecimalPlaces(code),
      legacyFallback: false,
    };
  }
  if (!isStoredCurrencyPrecision(rawPrecision)) {
    throw new ValidationError("Order currency precision is invalid. Repair the order before changing payment state.");
  }

  return { code, decimalPlaces: rawPrecision, legacyFallback: false };
}

export function createOrderCurrencySnapshot(currencyCode: unknown): OrderCurrencySnapshot {
  const code = normalizeSupportedCurrencyCode(currencyCode);
  if (!code) {
    throw new ValidationError("A supported order currency is required.");
  }
  return {
    code,
    decimalPlaces: getDecimalPlaces(code),
    legacyFallback: false,
  };
}

export function roundOrderMoney(amount: number, currency: OrderCurrencySnapshot): number {
  return roundPriceToPrecision(amount, currency.decimalPlaces);
}

export function orderMoneyEqual(
  left: number,
  right: number,
  currency: OrderCurrencySnapshot,
): boolean {
  return roundOrderMoney(left, currency) === roundOrderMoney(right, currency);
}

export function assertOrderPaymentCurrency(
  value: unknown,
  currency: OrderCurrencySnapshot,
  label = "Payment",
): void {
  // Pre-snapshot legacy BDT orders may also predate a populated payment
  // currency column. Never extend this compatibility rule to snapshotted orders.
  if (value == null && currency.legacyFallback) return;
  if (normalizeSupportedCurrencyCode(value) !== currency.code) {
    throw new ValidationError(
      `${label} currency does not match the immutable order currency. Repair the payment ledger before continuing.`,
    );
  }
}
