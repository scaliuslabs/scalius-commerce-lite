/**
 * Decimal price helpers for browser code that renders HTTP (major-unit) prices.
 * Server code stores and computes money in integer minor units (./money).
 */
import Currency from "currency.js";
import { getDecimalPlaces, getCurrencyCode } from "./currency";
import { discountedPriceMinor, fromMinor, percentToBps, toMinor } from "./money";

/**
 * Round a price to the correct decimal places for the given currency.
 * Defaults to the globally configured currency code.
 */
export function roundPrice(amount: number, currencyCode?: string): number {
  const precision = getDecimalPlaces(currencyCode ?? getCurrencyCode());
  return Currency(amount, { precision }).value;
}

/** Round using an already-resolved currency precision. */
export function roundPriceToPrecision(
  amount: number,
  precision: number,
): number {
  const safePrecision =
    Number.isInteger(precision) && precision >= 0 && precision <= 6
      ? precision
      : 2;
  return Currency(amount, { precision: safePrecision }).value;
}

/**
 * The discounted unit price of a decimal HTTP price, using the exact integer
 * rule checkout applies (`discountedPriceMinor`, including BDT cash
 * rounding), so displayed and charged prices always agree.
 */
export function calculateDiscountedPrice(
  price: number,
  discountType: unknown,
  discountPercentage: number | null | undefined,
  discountAmount: number | null | undefined,
  currencyCode: string,
): number {
  const places = getDecimalPlaces(currencyCode);
  // Amounts too large for integer minor units are not prices: the result is
  // 0, which every caller already treats as "not sellable at a price".
  const amount = (value: number | null | undefined): number | null => {
    if (value == null || !Number.isFinite(value) || value <= 0) return 0;
    try {
      return toMinor(value, places);
    } catch {
      return null;
    }
  };
  const priceMinor = amount(price);
  const discountMinor = amount(discountAmount);
  if (priceMinor === null || discountMinor === null) return 0;
  return fromMinor(
    discountedPriceMinor(priceMinor, discountType, percentToBps(discountPercentage), discountMinor, currencyCode),
    places,
  );
}
