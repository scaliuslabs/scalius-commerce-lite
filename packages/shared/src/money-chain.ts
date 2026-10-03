/**
 * The money chain of an order and its payments (docs/MARKETS-DESIGN.md D2,
 * D3), as pure column values every writer shares:
 *
 * - presentment: the order's own currency (`orders.currency_code`), what the
 *   buyer sees and pays, and the currency of every refund;
 * - shop: the store's reporting currency when the order was placed, reached
 *   through the rate checkout locked (`fx_rate`, a decimal string: shop units
 *   per presentment unit); analytics sum shop amounts, never mixed currencies;
 * - settlement: what reached the merchant for one payment movement, in
 *   which currency, at which rate.
 *
 * Until a second currency is enabled every order is same-currency (rate "1",
 * shop amounts equal presentment amounts) and every movement settles as
 * presented. Rates are exact decimal strings and conversions are exact
 * integer arithmetic, rounded once, half up, to a whole minor unit.
 */
import { currencyExponent } from "./currency-policy";

/** The rate of a same-currency order or settlement. */
export const SAME_CURRENCY_FX_RATE = "1";
/** `fx_source` of a same-currency order: no rate was quoted. */
export const SAME_CURRENCY_FX_SOURCE = "same_currency";

const FX_RATE_PATTERN = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

/** A positive decimal string of at most 12 integer and 12 fraction digits ("1", "0.0091", "117.25"). */
export function isFxRate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = FX_RATE_PATTERN.exec(value);
  return Boolean(match) && /[1-9]/.test(value);
}

function rateParts(rate: string): { numerator: bigint; scale: bigint } {
  if (!isFxRate(rate)) throw new RangeError(`Invalid exchange rate: ${JSON.stringify(rate)}.`);
  const [whole, fraction = ""] = rate.split(".");
  return { numerator: BigInt(`${whole}${fraction}`), scale: 10n ** BigInt(fraction.length) };
}

/**
 * `amountMinor` (minor units at `fromDecimalPlaces`) × `rate`, in minor units
 * at `toDecimalPlaces`, rounded half up once. Rate "1" between equal
 * exponents returns the amount itself.
 */
export function convertMinorAtRate(
  amountMinor: number,
  rate: string,
  fromDecimalPlaces: number,
  toDecimalPlaces: number,
): number {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError("Amounts are safe integers of minor units.");
  if (rate === SAME_CURRENCY_FX_RATE && fromDecimalPlaces === toDecimalPlaces) return amountMinor;
  const { numerator, scale } = rateParts(rate);
  const shift = toDecimalPlaces - fromDecimalPlaces;
  const top = BigInt(Math.abs(amountMinor)) * numerator * (shift >= 0 ? 10n ** BigInt(shift) : 1n);
  const bottom = scale * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  const rounded = (top * 2n + bottom) / (bottom * 2n);
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new RangeError("The converted amount exceeds the supported range.");
  return amountMinor < 0 ? -value : value;
}

/** The rate `to / from` of two amounts as a decimal string with at most 12 fraction digits, half up. */
export function rateBetweenMinor(
  fromMinor: number,
  fromDecimalPlaces: number,
  toMinor: number,
  toDecimalPlaces: number,
): string {
  if (!Number.isSafeInteger(fromMinor) || fromMinor <= 0 || !Number.isSafeInteger(toMinor) || toMinor < 0) {
    throw new RangeError("A rate needs a positive amount and a non-negative one.");
  }
  // (to / 10^toDp) / (from / 10^fromDp) × 10^12, rounded half up.
  const shift = 12 + fromDecimalPlaces - toDecimalPlaces;
  const top = BigInt(toMinor) * (shift >= 0 ? 10n ** BigInt(shift) : 1n);
  const bottom = BigInt(fromMinor) * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  const scaled = (top * 2n + bottom) / (bottom * 2n);
  const digits = scaled.toString().padStart(13, "0");
  const whole = digits.slice(0, -12).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-12).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/** The conversion an order was placed with (the `orders` fx columns). */
export interface OrderFxSnapshot {
  shopCurrency: string;
  fxRate: string;
  fxSource: string;
  fxAsOf: Date | null;
  fxLockedUntil: Date | null;
}

/** A same-currency order: the shop currency is the presentment currency, rate "1", no quote. */
export function sameCurrencyFx(currencyCode: string): OrderFxSnapshot {
  return {
    shopCurrency: currencyCode.trim().toUpperCase(),
    fxRate: SAME_CURRENCY_FX_RATE,
    fxSource: SAME_CURRENCY_FX_SOURCE,
    fxAsOf: null,
    fxLockedUntil: null,
  };
}

/** The presentment totals of an order, in minor units of its own currency. */
export interface OrderPresentmentTotals {
  currencyCode: string;
  subtotalAmountMinor: number;
  shippingAmountMinor: number;
  discountAmountMinor: number;
  taxAmountMinor: number;
  totalAmountMinor: number;
}

export interface OrderShopAmounts {
  subtotalShopMinor: number;
  shippingShopMinor: number;
  discountShopMinor: number;
  taxShopMinor: number;
  totalShopMinor: number;
}

/**
 * The order's totals in its shop currency at its locked rate. Each amount
 * converts once (a converted total can differ from the sum of the converted
 * parts by a rounding unit; reports sum each column as stored).
 */
export function orderShopAmounts(totals: OrderPresentmentTotals, fx: Pick<OrderFxSnapshot, "shopCurrency" | "fxRate">): OrderShopAmounts {
  const from = currencyExponent(totals.currencyCode);
  const to = currencyExponent(fx.shopCurrency);
  const convert = (amountMinor: number) => convertMinorAtRate(amountMinor, fx.fxRate, from, to);
  return {
    subtotalShopMinor: convert(totals.subtotalAmountMinor),
    shippingShopMinor: convert(totals.shippingAmountMinor),
    discountShopMinor: convert(totals.discountAmountMinor),
    taxShopMinor: convert(totals.taxAmountMinor),
    totalShopMinor: convert(totals.totalAmountMinor),
  };
}

/**
 * Every money-chain column of an order row: its fx snapshot and its shop
 * amounts. Order inserts spread it beside the presentment totals; edits that
 * rewrite the totals pass the order's stored snapshot so the rate stays the
 * one the buyer was quoted.
 */
export function orderMoneyChainColumns(
  totals: OrderPresentmentTotals,
  fx: OrderFxSnapshot = sameCurrencyFx(totals.currencyCode),
): OrderFxSnapshot & OrderShopAmounts {
  return { ...fx, ...orderShopAmounts(totals, fx) };
}

// ---------------------------------------------------------------------------
// Payment settlement
// ---------------------------------------------------------------------------

/** The settlement columns of one `order_payments` movement. */
export interface PaymentSettlementColumns {
  settlementCurrency: string;
  settlementAmountMinor: number;
  settlementRate: string;
  exchangeAdjustmentMinor: number;
}

/** A movement that settled as presented: same currency, same amount, rate "1". */
export function presentedSettlement(amountMinor: number, currency: string): PaymentSettlementColumns {
  return {
    settlementCurrency: currency.trim().toUpperCase(),
    settlementAmountMinor: amountMinor,
    settlementRate: SAME_CURRENCY_FX_RATE,
    exchangeAdjustmentMinor: 0,
  };
}

/** What a provider reported about a captured payment's settlement (the payment port's `settlement`). */
export interface ReportedSettlement {
  currency: string;
  amountMinor: number;
  /** Presentment → settlement rate as a decimal string; absent for same-currency settlement. */
  exchangeRate?: string;
}

/**
 * The settlement columns of a captured payment. Without a report (or with an
 * unusable one) it settled as presented. A report in another currency keeps
 * its rate (else the rate between the two amounts); when it settled in the
 * order's shop currency, `exchangeAdjustmentMinor` is the gain or loss
 * against the order's locked rate (Shopify's currencyExchangeAdjustment),
 * else 0.
 */
export function paymentSettlement(input: {
  amountMinor: number;
  currency: string;
  settlement?: ReportedSettlement | null;
  order?: Pick<OrderFxSnapshot, "shopCurrency" | "fxRate"> | null;
}): PaymentSettlementColumns {
  const currency = input.currency.trim().toUpperCase();
  const reported = input.settlement;
  if (!reported || !Number.isSafeInteger(reported.amountMinor) || reported.amountMinor < 0 || !/^[A-Za-z]{3}$/.test(reported.currency)) {
    return presentedSettlement(input.amountMinor, currency);
  }
  const settlementCurrency = reported.currency.toUpperCase();
  if (settlementCurrency === currency) {
    return {
      settlementCurrency,
      settlementAmountMinor: reported.amountMinor,
      settlementRate: SAME_CURRENCY_FX_RATE,
      exchangeAdjustmentMinor: 0,
    };
  }
  const from = currencyExponent(currency);
  const to = currencyExponent(settlementCurrency);
  const settlementRate = isFxRate(reported.exchangeRate)
    ? reported.exchangeRate
    : input.amountMinor > 0
      ? rateBetweenMinor(input.amountMinor, from, reported.amountMinor, to)
      : SAME_CURRENCY_FX_RATE;
  const order = input.order;
  const exchangeAdjustmentMinor = order && isFxRate(order.fxRate) && order.shopCurrency.toUpperCase() === settlementCurrency
    ? reported.amountMinor - convertMinorAtRate(input.amountMinor, order.fxRate, from, to)
    : 0;
  return { settlementCurrency, settlementAmountMinor: reported.amountMinor, settlementRate, exchangeAdjustmentMinor };
}
