/**
 * Money is stored and computed as integer minor units of its currency (paisa
 * for BDT). The HTTP contract carries decimal major units, converted exactly
 * once at that boundary with `toMinor` / `fromMinor`.
 *
 * Rounding rules, all exact integer math:
 * - `toMinor` rounds half-up at the currency's decimal places.
 * - A percentage discount prices each unit at round-half-up of
 *   `priceMinor × (10000 − bps) / 10000` to the market's price increment
 *   (`@scalius/shared/currency-policy`; a BDT store defaults to whole taka);
 *   the discount is the difference.
 * - Proportional splits (order discounts, tax) use largest-remainder
 *   allocation with a stable key tie-break, so parts always sum to the whole.
 */
import currency from "currency.js";
import { currencyExponent, isWholeUnitIncrement } from "./currency-policy";

/** The largest amount (minor units) money is stored and computed in. */
export const MAX_MINOR_AMOUNT = 9_000_000_000_000;

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

// ---------------------------------------------------------------------------
// The market's price increment
// ---------------------------------------------------------------------------

function assertIncrement(incrementMinor: number): void {
  if (!Number.isSafeInteger(incrementMinor) || incrementMinor < 1) {
    throw new RangeError("A price increment is a positive integer of minor units.");
  }
}

/** Why a BDT amount with paisa is refused while the market prices in whole taka. */
export const WHOLE_TAKA_MESSAGE = "Taka amounts are whole numbers.";

/**
 * Why an amount off the market's price increment is refused. Whole taka keeps
 * its long-standing message; another whole unit says the same of its code.
 */
export function priceIncrementMessage(currencyCode: string, incrementMinor: number): string {
  const code = currencyCode.trim().toUpperCase();
  if (isWholeUnitIncrement(code, incrementMinor)) {
    return code === "BDT" ? WHOLE_TAKA_MESSAGE : `${code} amounts are whole numbers.`;
  }
  return `${code} amounts go in steps of ${fromMinor(incrementMinor, currencyExponent(code))}.`;
}

/** True when the amount is a whole number of increments (an increment of 1 accepts every amount). */
export function isIncrementMultipleMinor(amountMinor: number, incrementMinor: number): boolean {
  assertIncrement(incrementMinor);
  return Number.isSafeInteger(amountMinor) && amountMinor % incrementMinor === 0;
}

/** Half-up to a multiple of the increment; an increment of 1 leaves the amount. */
export function roundToIncrementMinor(amountMinor: number, incrementMinor: number): number {
  assertIncrement(incrementMinor);
  if (incrementMinor === 1) return amountMinor;
  return Math.floor((amountMinor + incrementMinor / 2) / incrementMinor) * incrementMinor;
}

/** Down to a multiple of the increment: a fixed amount never grows to fit it. */
export function floorToIncrementMinor(amountMinor: number, incrementMinor: number): number {
  assertIncrement(incrementMinor);
  return incrementMinor === 1 ? amountMinor : Math.floor(amountMinor / incrementMinor) * incrementMinor;
}

export class PriceIncrementError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "PriceIncrementError";
  }
}

/**
 * A merchant-entered decimal amount (price, fixed discount, delivery charge,
 * threshold, refund, manual adjustment) in minor units, refused with
 * `PriceIncrementError` unless it is a multiple of the market's price
 * increment (a BDT store by default: whole taka).
 */
export function toIncrementMinor(
  amount: number,
  decimalPlaces: number,
  incrementMinor: number,
  currencyCode: string,
): number {
  const minor = toMinor(amount, decimalPlaces);
  if (!isIncrementMultipleMinor(minor, incrementMinor)) {
    throw new PriceIncrementError(priceIncrementMessage(currencyCode, incrementMinor));
  }
  return minor;
}

/**
 * `baseMinor × basisPoints / 10000`, rounded half-up to a multiple of the
 * price increment and never above the base.
 */
export function percentOfMinor(baseMinor: number, basisPoints: number, incrementMinor: number): number {
  assertIncrement(incrementMinor);
  if (basisPoints >= 10_000) return baseMinor;
  const unit = BigInt(incrementMinor);
  const value = ((BigInt(baseMinor) * BigInt(basisPoints) + 5_000n * unit) / (10_000n * unit)) * unit;
  return Math.min(baseMinor, Number(value));
}

/**
 * The per-unit price after a catalog (product/variant) discount, in minor
 * units: a percentage price rounds half-up to the price increment, a flat
 * discount keeps the merchant's exact amount.
 */
export function discountedPriceMinor(
  priceMinor: number,
  discountType: unknown,
  discountBps: number | null | undefined,
  discountAmountMinor: number | null | undefined,
  incrementMinor: number,
): number {
  if (discountType === "percentage" && discountBps != null && discountBps > 0) {
    return percentOfMinor(priceMinor, 10_000 - Math.min(discountBps, 10_000), incrementMinor);
  }
  if (discountType === "flat" && discountAmountMinor != null && discountAmountMinor > 0) {
    return Math.max(priceMinor - discountAmountMinor, 0);
  }
  return priceMinor;
}
