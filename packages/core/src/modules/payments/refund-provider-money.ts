import { ValidationError } from "@scalius/core/errors";
import type { SupportedCurrencyCode } from "@scalius/shared/currency";
import { roundPriceToPrecision } from "@scalius/shared/price-utils";

import type { OrderCurrencySnapshot } from "./order-currency";

export interface RefundProviderMoney {
  amountMinor: number;
  currency: SupportedCurrencyCode;
}

/** A local major-unit refund amount as the positive integer minor units every adapter receives. */
export function resolveRefundProviderMoney(
  localAmount: number,
  currency: OrderCurrencySnapshot,
  label = "Refund",
): RefundProviderMoney {
  const normalized = roundPriceToPrecision(localAmount, currency.decimalPlaces);
  const amountMinor = Math.round(normalized * 10 ** currency.decimalPlaces);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError(`${label} must resolve to a positive provider amount.`);
  }
  return { amountMinor, currency: currency.code };
}
