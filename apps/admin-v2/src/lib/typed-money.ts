import { DEFAULT_CURRENCY, getDecimalPlaces } from "@scalius/shared/currency";
import { toMinor } from "@scalius/shared/money";

/**
 * An amount a person typed (decimal major units) as the API takes it:
 * integer minor units at the exponent of the currency the amount is in
 * (0 for JPY, 2 for BDT, 3 for KWD). The currency is required: an amount on
 * an existing order is in that order's currency, which may be a market's,
 * never silently the store's.
 */
export function typedMinor(amount: number, currencyCode: string): number {
  return toMinor(amount, getDecimalPlaces(currencyCode));
}

/** The currency an existing order's amounts are in (the column's default for an order that names none). */
export function orderCurrencyCode(order: { currencyCode?: string | null }): string {
  return order.currencyCode || DEFAULT_CURRENCY.code;
}
