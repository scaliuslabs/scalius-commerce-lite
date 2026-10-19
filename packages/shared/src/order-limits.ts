// The one line limit of a cart, a checkout and every order (storefront,
// staff, app): how many lines and how many units a line may hold. Every
// schema that takes order lines reads these, so a wholesale quantity is
// either buyable everywhere or nowhere. The same on every plan.
import { MAX_MINOR_AMOUNT } from "./money";

/** The most lines one cart, checkout or order holds. */
export const MAX_ORDER_LINES = 99;

/** The most units one line holds (a wholesale MOQ of 120 is one line). */
export const MAX_LINE_QUANTITY = 1_000_000;

/**
 * Whether a line's amount (unit price × quantity, minor units) is one the
 * money code computes exactly: a safe integer within the supported range.
 * A larger line is refused rather than rounded.
 */
export function isLineAmountInRange(unitPriceMinor: number, quantity: number): boolean {
  const amount = unitPriceMinor * quantity;
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= MAX_MINOR_AMOUNT;
}
