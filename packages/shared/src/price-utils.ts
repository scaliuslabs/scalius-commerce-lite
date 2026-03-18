/**
 * Price arithmetic utilities powered by currency.js.
 * Eliminates floating-point drift across all price calculations.
 */
import Currency from "currency.js";
import { getDecimalPlaces, getCurrencyCode } from "./currency";

/**
 * Round a price to the correct decimal places for the given currency.
 * Defaults to the globally configured currency code.
 */
export function roundPrice(amount: number, currencyCode?: string): number {
  const precision = getDecimalPlaces(currencyCode ?? getCurrencyCode());
  return Currency(amount, { precision }).value;
}

/**
 * Safe price addition that avoids float drift.
 */
export function addPrices(...amounts: number[]): number {
  return amounts.reduce((sum, amt) => Currency(sum).add(amt).value, 0);
}

/**
 * Safe price subtraction.
 */
export function subtractPrice(a: number, b: number): number {
  return Currency(a).subtract(b).value;
}

/**
 * Check if two prices are effectively equal.
 */
export function pricesEqual(a: number, b: number): boolean {
  return Currency(a).subtract(b).value === 0;
}

/**
 * Calculate discount amount from percentage, rounded.
 */
export function calculatePercentageDiscount(
  price: number,
  percentage: number,
): number {
  return Currency(price).multiply(percentage / 100).value;
}
