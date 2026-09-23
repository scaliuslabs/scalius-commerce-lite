import { ValidationError } from "@scalius/core/errors";
import type { SupportedCurrencyCode } from "@scalius/shared/currency";
import { roundPriceToPrecision } from "@scalius/shared/price-utils";

import type { OrderCurrencySnapshot } from "./order-currency";

export interface RefundProviderMoney {
  amountMinor: number;
  currency: SupportedCurrencyCode;
}

function toPositiveMinorAmount(
  amount: number,
  decimalPlaces: number,
  label: string,
): number {
  const normalized = roundPriceToPrecision(amount, decimalPlaces);
  const amountMinor = Math.round(normalized * 10 ** decimalPlaces);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError(`${label} must resolve to a positive provider amount.`);
  }
  return amountMinor;
}

export function resolveStripeRefundProviderMoney(
  localAmount: number,
  currency: OrderCurrencySnapshot,
): RefundProviderMoney {
  return {
    amountMinor: toPositiveMinorAmount(
      localAmount,
      currency.decimalPlaces,
      "Stripe refund",
    ),
    currency: currency.code,
  };
}
