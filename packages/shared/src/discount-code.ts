// A discount code as the store matches it: case and surrounding spaces never
// matter, wherever a buyer or a merchant types one (checkout, the orders
// list's filter and search, the app API's `orders.list?discountCode=`).
// Browser-safe.

/** The shape a discount code has: 3 to 50 letters, digits, `_` or `-`. */
export const DISCOUNT_CODE_PATTERN = /^[A-Za-z0-9_-]{3,50}$/u;

/** The code as stored and matched (`promotion_codes.normalized_code`): trimmed, upper case. */
export function normalizeDiscountCode(value: string): string {
  return value.trim().toUpperCase();
}

/** Whether typed text can be a discount code (a search term worth looking up as one). */
export function looksLikeDiscountCode(value: string): boolean {
  return DISCOUNT_CODE_PATTERN.test(value.trim());
}
