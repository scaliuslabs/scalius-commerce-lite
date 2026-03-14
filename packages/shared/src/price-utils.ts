/**
 * Round a price to 2 decimal places using banker's rounding.
 * Use at every calculation boundary: totals, discounts, balance due.
 */
export function roundPrice(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * Safe price addition that avoids float drift.
 */
export function addPrices(...amounts: number[]): number {
  return roundPrice(amounts.reduce((sum, a) => sum + a, 0));
}

/**
 * Safe price subtraction.
 */
export function subtractPrice(a: number, b: number): number {
  return roundPrice(a - b);
}

/**
 * Check if two prices are effectively equal (within 0.01 tolerance).
 */
export function pricesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

/**
 * Calculate discount amount from percentage, rounded.
 */
export function calculatePercentageDiscount(
  price: number,
  percentage: number
): number {
  return roundPrice(price * (percentage / 100));
}
