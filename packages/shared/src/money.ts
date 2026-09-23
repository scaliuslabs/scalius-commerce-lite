/**
 * Money is stored and computed as integer minor units of its currency (paisa
 * for BDT). The HTTP contract carries decimal major units, converted exactly
 * once at that boundary with `toMinor` / `fromMinor`.
 *
 * Rounding rules, all exact integer math:
 * - `toMinor` rounds half-up at the currency's decimal places.
 * - A percentage discount prices each unit at round-half-up of
 *   `priceMinor × (10000 − bps) / 10000`; the discount is the difference.
 * - Proportional splits (order discounts, tax) use largest-remainder
 *   allocation with a stable key tie-break, so parts always sum to the whole.
 */
import currency from "currency.js";

const MAX_MINOR_AMOUNT = 9_000_000_000_000;

function assertDecimalPlaces(decimalPlaces: number): void {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 3) {
    throw new RangeError("Currency decimal places must be an integer between 0 and 3.");
  }
}

/** Decimal major units (as sent over HTTP) to non-negative integer minor units. */
export function toMinor(amount: number, decimalPlaces: number): number {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError("Money amount must be finite and non-negative.");
  }
  assertDecimalPlaces(decimalPlaces);
  const minor = currency(amount, { precision: decimalPlaces }).intValue;
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR_AMOUNT) {
    throw new RangeError("Money amount exceeds the supported range.");
  }
  return minor;
}

/** Integer minor units to the decimal major-unit number used by the HTTP contract. */
export function fromMinor(amountMinor: number, decimalPlaces: number): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError("Money amount must be a safe integer of minor units.");
  }
  assertDecimalPlaces(decimalPlaces);
  return amountMinor / 10 ** decimalPlaces;
}

/** A percentage such as 12.5 to integer basis points (1250), clamped to 0–100%. */
export function percentToBps(percent: number | null | undefined): number {
  if (percent == null || !Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(10_000, Math.round(percent * 100));
}

export function bpsToPercent(bps: number): number {
  return bps / 100;
}

export type CatalogDiscountType = "percentage" | "flat";

/** The per-unit price after a catalog (product/variant) discount, in minor units. */
export function discountedPriceMinor(
  priceMinor: number,
  discountType: unknown,
  discountBps: number | null | undefined,
  discountAmountMinor: number | null | undefined,
): number {
  if (discountType === "percentage" && discountBps != null && discountBps > 0) {
    const keptBps = BigInt(10_000 - Math.min(discountBps, 10_000));
    return Number((BigInt(priceMinor) * keptBps + 5_000n) / 10_000n);
  }
  if (discountType === "flat" && discountAmountMinor != null && discountAmountMinor > 0) {
    return Math.max(priceMinor - discountAmountMinor, 0);
  }
  return priceMinor;
}
