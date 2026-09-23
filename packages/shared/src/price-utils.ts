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
 * rule checkout applies (`discountedPriceMinor`), so displayed and charged
 * prices always agree.
 */
export function calculateDiscountedPriceAtPrecision(
  price: number,
  discountType: unknown,
  discountPercentage: number | null | undefined,
  discountAmount: number | null | undefined,
  precision: number,
): number {
  const places = Number.isInteger(precision) && precision >= 0 && precision <= 3 ? precision : 2;
  const amount = (value: number | null | undefined) =>
    value != null && Number.isFinite(value) && value > 0 ? toMinor(value, places) : 0;
  return fromMinor(
    discountedPriceMinor(amount(price), discountType, percentToBps(discountPercentage), amount(discountAmount)),
    places,
  );
}
