/**
 * The presentment currency of a checkout (docs/MARKETS-DESIGN.md D2, D3,
 * "Step 6 implemented"): the market's currency the buyer sees and pays, the
 * shop currency the books are kept in, and the one locked rate between them.
 *
 * Shopify's rule, copied: every amount the store keeps in the shop currency
 * (a delivery fee, a free-delivery or minimum-order threshold, a fixed
 * discount, a bundle price, a buyer-input surcharge) is converted at the
 * locked rate and rounded to the market's price increment, unless a fixed
 * amount exists in the market currency (a price list price). Same-currency
 * checkouts convert nothing: every function here returns its input.
 *
 * Rates are exact decimal strings (`money-chain`): a market's rate is market
 * currency units per shop currency unit; an order's `fx_rate` is the inverse
 * (shop units per presentment unit), so the order's shop amounts are exact
 * integer conversions at the stored rate. Pure and browser-safe.
 */
import { currencyExponent, defaultPriceIncrementMinor, type PricingCurrency } from "./currency-policy";
import {
  convertMinorAtRate,
  isFxRate,
  SAME_CURRENCY_FX_RATE,
  SAME_CURRENCY_FX_SOURCE,
  type OrderFxSnapshot,
} from "./money-chain";

/** Shopify's default checkout rate lock. */
export const DEFAULT_FX_LOCK_MINUTES = 30;
export const MIN_FX_LOCK_MINUTES = 5;
export const MAX_FX_LOCK_MINUTES = 1_440;

/** The source of a market's manual rate (`MANUAL_FX_RATE_SOURCE_ID` in market-pricing). */
export const MANUAL_FX_SOURCE = "manual";

/** How one checkout converts the store's amounts into the currency the buyer pays. */
export interface PresentmentMoney {
  /** What the buyer sees and pays (the order's currency). */
  currencyCode: string;
  decimalPlaces: number;
  /** The market's price increment: every converted amount is a multiple of it. */
  incrementMinor: number;
  /** The books' currency: the backup market's. */
  shopCurrencyCode: string;
  shopDecimalPlaces: number;
  /** Presentment units per shop unit; "1" for the shop currency. */
  rate: string;
  /** `same_currency`, `manual` or a rate provider's id. */
  fxSource: string;
  /** When the rate was set (epoch seconds), or null. */
  fxAsOf: number | null;
  /** How long a placed order keeps this rate (the market's lock, default 30). */
  lockMinutes: number;
}

/** A checkout in the shop currency: nothing converts. */
export function shopPresentment(shop: PricingCurrency): PresentmentMoney {
  return {
    currencyCode: shop.code,
    decimalPlaces: shop.decimalPlaces,
    incrementMinor: shop.priceIncrementMinor,
    shopCurrencyCode: shop.code,
    shopDecimalPlaces: shop.decimalPlaces,
    rate: SAME_CURRENCY_FX_RATE,
    fxSource: SAME_CURRENCY_FX_SOURCE,
    fxAsOf: null,
    lockMinutes: DEFAULT_FX_LOCK_MINUTES,
  };
}

/** A market currency's price increment (MARKETS-DESIGN D1): whole taka for BDT, else the minor unit. */
export function marketCurrencyIncrementMinor(code: string): number {
  return defaultPriceIncrementMinor(code);
}

/** A checkout in a market currency at a market rate. */
export function marketPresentment(input: {
  shop: PricingCurrency;
  currencyCode: string;
  rate: string;
  fxSource?: string;
  fxAsOf?: number | null;
  lockMinutes?: number | null;
}): PresentmentMoney {
  const code = input.currencyCode.trim().toUpperCase();
  if (code === input.shop.code) return { ...shopPresentment(input.shop), lockMinutes: lockMinutesOf(input.lockMinutes) };
  if (!isFxRate(input.rate)) throw new RangeError(`Invalid exchange rate: ${JSON.stringify(input.rate)}.`);
  return {
    currencyCode: code,
    decimalPlaces: currencyExponent(code),
    incrementMinor: marketCurrencyIncrementMinor(code),
    shopCurrencyCode: input.shop.code,
    shopDecimalPlaces: input.shop.decimalPlaces,
    rate: input.rate,
    fxSource: input.fxSource ?? MANUAL_FX_SOURCE,
    fxAsOf: input.fxAsOf ?? null,
    lockMinutes: lockMinutesOf(input.lockMinutes),
  };
}

function lockMinutesOf(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && value! >= MIN_FX_LOCK_MINUTES && value! <= MAX_FX_LOCK_MINUTES
    ? value!
    : DEFAULT_FX_LOCK_MINUTES;
}

/** True when the buyer pays in another currency than the shop's. */
export function isForeignPresentment(money: Pick<PresentmentMoney, "currencyCode" | "shopCurrencyCode">): boolean {
  return money.currencyCode !== money.shopCurrencyCode;
}

/** The pricing currency (code, places, increment) every checkout rule rounds in. */
export function presentmentPricingCurrency(money: PresentmentMoney): PricingCurrency {
  return { code: money.currencyCode, decimalPlaces: money.decimalPlaces, priceIncrementMinor: money.incrementMinor };
}

/**
 * A shop-currency amount in the presentment currency: exact at the rate,
 * then half-up (`nearest`) or down (`down`) to the market's price increment.
 * A positive amount that rounds to zero stays one increment when rounding to
 * the nearest (a fee or threshold never vanishes); zero stays zero.
 */
export function presentShopMinor(money: PresentmentMoney, shopMinor: number, mode: "nearest" | "down" = "nearest"): number {
  if (!Number.isSafeInteger(shopMinor)) throw new RangeError("Amounts are safe integers of minor units.");
  if (!isForeignPresentment(money) || shopMinor === 0) return shopMinor;
  const negative = shopMinor < 0;
  const [whole, fraction = ""] = money.rate.split(".");
  const shift = money.decimalPlaces - money.shopDecimalPlaces;
  // amount × rate in presentment minor units, as the fraction top / bottom.
  const top = BigInt(Math.abs(shopMinor)) * BigInt(`${whole}${fraction}`) * (shift > 0 ? 10n ** BigInt(shift) : 1n);
  const bottom = 10n ** BigInt(fraction.length) * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  const increment = BigInt(money.incrementMinor);
  // Round the exact fraction once: to whole increments of top / bottom.
  const units = mode === "down"
    ? top / (bottom * increment)
    : (top * 2n + bottom * increment) / (bottom * increment * 2n);
  let rounded = units * increment;
  if (rounded === 0n && mode === "nearest") rounded = increment;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new RangeError("The converted amount exceeds the supported range.");
  return negative ? -value : value;
}

/** A nullable shop amount (an optional threshold) in the presentment currency. */
export function presentShopMinorOrNull(money: PresentmentMoney, shopMinor: number | null | undefined): number | null {
  return shopMinor === null || shopMinor === undefined ? null : presentShopMinor(money, shopMinor);
}

/**
 * The order's rate (shop units per presentment unit): the inverse of the
 * market rate, half-up at 12 fraction digits; "1" for the shop currency.
 */
export function orderFxRate(money: Pick<PresentmentMoney, "rate" | "currencyCode" | "shopCurrencyCode">): string {
  if (!isForeignPresentment(money)) return SAME_CURRENCY_FX_RATE;
  return invertFxRate(money.rate);
}

/** 1 / rate as a decimal string with at most 12 fraction digits, half up (never zero). */
export function invertFxRate(rate: string): string {
  if (!isFxRate(rate)) throw new RangeError(`Invalid exchange rate: ${JSON.stringify(rate)}.`);
  const [whole, fraction = ""] = rate.split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  const scale = 10n ** BigInt(fraction.length);
  // (scale / numerator) × 10^12, half up.
  const scaled = (scale * 10n ** 12n * 2n + numerator) / (numerator * 2n);
  const safe = scaled === 0n ? 1n : scaled;
  const digits = safe.toString().padStart(13, "0");
  const integer = digits.slice(0, -12).replace(/^0+(?=\d)/, "");
  const decimals = digits.slice(-12).replace(/0+$/, "");
  return decimals ? `${integer}.${decimals}` : integer;
}

/** A presentment amount in the shop currency at the order's rate (exact, half up). */
export function shopMinorOf(money: PresentmentMoney, presentmentMinor: number): number {
  if (!isForeignPresentment(money)) return presentmentMinor;
  return convertMinorAtRate(presentmentMinor, orderFxRate(money), money.decimalPlaces, money.shopDecimalPlaces);
}

/**
 * The order's fx snapshot (MARKETS-DESIGN D3): the shop currency, its rate,
 * where the rate came from, when it was set, and until when the order keeps
 * it (`placedAt` + the market's lock). A same-currency order is
 * `sameCurrencyFx`: rate "1", no quote, no lock.
 */
export function presentmentFx(money: PresentmentMoney, placedAt: Date = new Date()): OrderFxSnapshot {
  if (!isForeignPresentment(money)) {
    return {
      shopCurrency: money.shopCurrencyCode,
      fxRate: SAME_CURRENCY_FX_RATE,
      fxSource: SAME_CURRENCY_FX_SOURCE,
      fxAsOf: null,
      fxLockedUntil: null,
    };
  }
  return {
    shopCurrency: money.shopCurrencyCode,
    fxRate: orderFxRate(money),
    fxSource: money.fxSource,
    fxAsOf: money.fxAsOf === null ? placedAt : new Date(money.fxAsOf * 1_000),
    fxLockedUntil: new Date(placedAt.getTime() + money.lockMinutes * 60_000),
  };
}

// ---------------------------------------------------------------------------
// Between two currencies of the store (gift cards, Shopify's rule)
// ---------------------------------------------------------------------------

/** A currency of the store with its rate against the shop currency (units per shop unit). */
export interface StoreCurrencyRate {
  code: string;
  decimalPlaces: number;
  /** Units of this currency per shop unit; "1" for the shop currency. */
  rate: string;
}

function fractionOf(rate: string): { numerator: bigint; scale: bigint } {
  if (!isFxRate(rate)) throw new RangeError(`Invalid exchange rate: ${JSON.stringify(rate)}.`);
  const [whole, fraction = ""] = rate.split(".");
  return { numerator: BigInt(`${whole}${fraction}`), scale: 10n ** BigInt(fraction.length) };
}

/**
 * `amountMinor` of `from` in `to` through the shop currency, exact, rounded
 * down (`down`, what a balance can pay) or up (`up`, what a payment debits).
 * The same currency returns the amount.
 */
export function convertStoreCurrencyMinor(
  amountMinor: number,
  from: StoreCurrencyRate,
  to: StoreCurrencyRate,
  mode: "down" | "up",
): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RangeError("Amounts are non-negative safe integers.");
  if (from.code === to.code) return amountMinor;
  // amount / 10^fromDp / fromRate × toRate × 10^toDp
  const a = fractionOf(from.rate);
  const b = fractionOf(to.rate);
  const shift = to.decimalPlaces - from.decimalPlaces;
  const top = BigInt(amountMinor) * b.numerator * a.scale * (shift > 0 ? 10n ** BigInt(shift) : 1n);
  const bottom = a.numerator * b.scale * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  const value = Number(mode === "down" ? top / bottom : (top + bottom - 1n) / bottom);
  if (!Number.isSafeInteger(value)) throw new RangeError("The converted amount exceeds the supported range.");
  return value;
}

/** The rate of `to` per one unit of `from` (decimal string, 12 fraction digits, half up). */
export function crossRate(from: StoreCurrencyRate, to: StoreCurrencyRate): string {
  if (from.code === to.code) return SAME_CURRENCY_FX_RATE;
  const a = fractionOf(from.rate);
  const b = fractionOf(to.rate);
  // (b / a) × 10^12, half up.
  const top = b.numerator * a.scale * 10n ** 12n;
  const bottom = a.numerator * b.scale;
  const scaled = (top * 2n + bottom) / (bottom * 2n);
  const digits = (scaled === 0n ? 1n : scaled).toString().padStart(13, "0");
  const integer = digits.slice(0, -12).replace(/^0+(?=\d)/, "");
  const decimals = digits.slice(-12).replace(/0+$/, "");
  return decimals ? `${integer}.${decimals}` : integer;
}
