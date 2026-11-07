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

/**
 * The one money ceiling (audit I7): the largest amount, in minor units of its
 * currency, that money is stored, computed and accepted in. Every price,
 * charge, discount, payment, refund and gift card value is at most this,
 * whatever its currency (90 billion taka; 9 trillion of a zero-decimal
 * currency such as VND). It keeps every derived amount a safe integer with
 * room to spare: a line is at most this (`isLineAmountInRange`), and an
 * order of 99 such lines plus shipping and tax stays below
 * `Number.MAX_SAFE_INTEGER` (about 9.007 × 10^15) by about tenfold. Every
 * stable `*Minor` input advertises it as its `maximum`; the database columns
 * are 64-bit integers on every provider.
 */
export const MAX_MINOR_AMOUNT = 9_000_000_000_000;

/** The largest amount in major units of a currency with `decimalPlaces` (`MAX_MINOR_AMOUNT` of it). */
export function maxMajorAmount(decimalPlaces: number): number {
  assertDecimalPlaces(decimalPlaces);
  return MAX_MINOR_AMOUNT / 10 ** decimalPlaces;
}

/**
 * The largest major-unit amount of any currency (a zero-decimal one's): the
 * bound a major-unit input schema can state before it knows the currency.
 * The exact bound applies when the amount is converted (`toMinor` refuses
 * more than `MAX_MINOR_AMOUNT` with a `MoneyRangeError`).
 */
export const MAX_MAJOR_AMOUNT = MAX_MINOR_AMOUNT;

/** An amount above `MAX_MINOR_AMOUNT` (or not a safe integer of minor units). */
export class MoneyRangeError extends RangeError {
  constructor(message = "Money amount exceeds the supported range.") {
    super(message);
    this.name = "MoneyRangeError";
  }
}

/** Enforce the shared ceiling on stored or derived money, including signed adjustments. */
export function assertMinorAmount(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor) || Math.abs(amountMinor) > MAX_MINOR_AMOUNT) {
    throw new MoneyRangeError();
  }
}

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
    throw new MoneyRangeError();
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

/**
 * A sale badge's whole percentage ("-13%"), the one rule every theme and
 * surface shows: rounded down so a badge never promises more than the
 * saving, and at least 1 while there is a saving. Null when the price is
 * not lower (or the original is not positive).
 */
export function discountPercentOff(original: number, current: number): number | null {
  if (!(original > 0) || !Number.isFinite(current) || !(current < original)) return null;
  return Math.max(1, Math.floor(((original - Math.max(current, 0)) / original) * 100 + 1e-9));
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

/**
 * A share of an amount (`percent` with at most two decimals: 12.5 is 12.5%),
 * exact in integers, then half-up to the increment. A positive share of a
 * positive amount never rounds to nothing: it takes one increment, as a
 * converted fee does (`presentShopMinor`).
 */
export function addOnShareMinor(amountMinor: number, percent: number, incrementMinor: number): number {
  assertIncrement(incrementMinor);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RangeError("The amount must be a non-negative safe integer.");
  const basisPoints = Math.round(percent * 100);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || Math.abs(percent * 100 - basisPoints) > 1e-6) {
    throw new RangeError("A share has at most two decimals.");
  }
  if (amountMinor === 0 || basisPoints === 0) return 0;
  const top = BigInt(amountMinor) * BigInt(basisPoints);
  const step = 10_000n * BigInt(incrementMinor);
  const units = (top * 2n + step) / (step * 2n);
  const rounded = Number(units === 0n ? 1n : units) * incrementMinor;
  if (!Number.isSafeInteger(rounded)) throw new RangeError("The share is too large.");
  return rounded;
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
