/**
 * Market pricing (docs/MARKETS-DESIGN.md D5, "Step 4a implemented"): price
 * lists, FX-derived prices and the one precedence every price reader uses.
 *
 * Pure and browser-safe. The catalogue (cards, the product page, search,
 * feeds and JSON-LD), cart validation, checkout, staff orders and agents all
 * price a SKU with `resolvePrice()`; the dashboard previews FX rounding with
 * `fxPriceMinor()`.
 *
 * Precedence, documented once (Medusa price lists, Shopify catalogs):
 *
 *   purchase-option app price > override list > the lower of sale and the
 *   ordinary price (segment list > market list > app price > FX-derived > base)
 *
 * - A list price applies only while its list is active and inside its
 *   schedule, in the market's currency, and (segment lists) to a member of
 *   its customer segment. Callers filter with `applicablePriceListPrices()`.
 * - Quantity breaks are `min_quantity` rows (Medusa): a list offers the row
 *   with the largest `min_quantity` that the line quantity reaches.
 * - Sales choose the lowest rounded amount. Other kinds choose higher
 *   priority first. Equal sale amounts or other priorities break ties by
 *   priority, then raw amount, then list id, never by row order.
 * - A list price replaces the SKU's price and its catalogue discount. Its
 *   compare-at is the row's own; a sale row without one compares against the
 *   price the buyer would pay without sale lists. A sale only applies when
 *   lower than that price; an override deliberately replaces it by rank.
 * - FX-derived (a market in `fx` mode): the base buyer price converted at the
 *   market's rate, adjusted by its percentage, rounded half-up to the price
 *   increment, then up to the market's rounding step and its ending
 *   (WooPayments' rounding and charm pricing). The compare-at is the base
 *   price converted the same way (Shopify adjusts compare-at too).
 * - App price (`cart.line_prices`, packages/plugin-sdk/docs/apps.md): a checkout
 *   function's unit price for one cart line, rounded half-up to the price
 *   increment. It sits below override, market and segment lists, so their rules stay
 *   authoritative, and above the FX-derived and base price, so B2B contract,
 *   subscription and tiered prices replace them. The compare-at is the price
 *   without the app when that is higher. Checkout only: catalogue reads never
 *   run apps.
 * - Purchase-option app price: a line bought with an app's purchase option
 *   (`purchaseOption`, a subscription or a rental) is that app's offer, so
 *   only the app that declares the option prices it, and its price outranks
 *   every list: a subscription on a sale item is charged the subscription
 *   price, never the sale price. Checkout refuses a line without its owner
 *   app's valid price. Lists keep pricing one-time lines. The
 *   compare-at is the one-time price when that is higher.
 * - Base: the SKU's price after its catalogue discount (`discountedPriceMinor`).
 *
 * Promotions, bundles and app discounts apply after this, in today's order:
 * they see the resolved unit price as the line's catalogue price.
 */
import { isFxRate, SAME_CURRENCY_FX_RATE } from "./money-chain";
import { assertMinorAmount, MoneyRangeError } from "./money";

export const PRICE_LIST_KINDS = ["market", "segment", "sale", "override"] as const;
export type PriceListKind = (typeof PRICE_LIST_KINDS)[number];

export const PRICE_LIST_STATUSES = ["draft", "active"] as const;
export type PriceListStatus = (typeof PRICE_LIST_STATUSES)[number];

/** `fixed`: base prices and fixed list prices; `fx`: base prices converted at the market's rate. */
export const MARKET_PRICE_MODES = ["fixed", "fx"] as const;
export type MarketPriceMode = (typeof MARKET_PRICE_MODES)[number];

/** Limits a store keeps (the same on every plan profile). */
export const MAX_PRICE_LISTS = 100;
export const MAX_PRICE_LIST_PRICES = 5_000;
/** Quantity breaks of one SKU in one currency of one list (its base row included). */
export const MAX_PRICE_LIST_QUANTITY_BREAKS = 5;
export const PRICE_LIST_PRIORITY_MAX = 1_000;
export const PRICE_LIST_MIN_QUANTITY_MAX = 10_000;
export const PRICE_LIST_NAME_MAX_LENGTH = 80;
export const PRICE_LIST_DESCRIPTION_MAX_LENGTH = 300;
/** A market's price adjustment: −99 % to +1,000 %, in basis points. */
export const MARKET_PRICE_ADJUSTMENT_MIN_BPS = -9_900;
export const MARKET_PRICE_ADJUSTMENT_MAX_BPS = 100_000;

/** Rank of a kind in the precedence (higher wins). */
const KIND_RANK: Readonly<Record<PriceListKind, number>> = { override: 4, sale: 3, segment: 2, market: 1 };

export function isPriceListKind(value: unknown): value is PriceListKind {
  return typeof value === "string" && (PRICE_LIST_KINDS as readonly string[]).includes(value);
}

export function isMarketPriceMode(value: unknown): value is MarketPriceMode {
  return typeof value === "string" && (MARKET_PRICE_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// FX-derived prices
// ---------------------------------------------------------------------------

/**
 * Where a market's exchange rate comes from (`markets.fx_rate_source`). The
 * default is the manual source: the merchant's rate on the market (or "1"
 * while the market sells the shop currency). An app FX provider
 * (`<plugin id>:<provider id>`, the `fx` provider port) is the other: the
 * scheduled tick asks it and stores the answer on the market
 * (`refreshMarketFxRates`), so a page or a checkout never waits on it and an
 * order records the source and time of its rate.
 */
export interface FxRateSource {
  readonly id: string;
  /** Units of `to` per one unit of `from`, as a decimal string, or null when it has none. */
  rate(from: string, to: string): Promise<{ rate: string; asOf: Date | null } | null>;
}

/** The default source: the market's manual rate. */
export const MANUAL_FX_RATE_SOURCE_ID = "manual";

/**
 * The rate a market converts shop prices at (market currency units per shop
 * currency unit): "1" for the shop currency, else the manual override. Null
 * means no rate: the market cannot derive prices (it fails closed).
 */
export function marketFxRate(market: { currencyCode: string; fxRate: string | null }, shopCurrencyCode: string): string | null {
  if (market.currencyCode.trim().toUpperCase() === shopCurrencyCode.trim().toUpperCase()) return SAME_CURRENCY_FX_RATE;
  return market.fxRate !== null && isFxRate(market.fxRate) ? market.fxRate : null;
}

/** How a market in `fx` mode derives its prices from the shop's base prices. */
export interface MarketFxPolicy {
  /** Market currency units per shop currency unit (exact decimal string). */
  rate: string;
  /** Percentage adjustment in basis points (−9,900 to 100,000); 0 for none. */
  adjustmentBps: number;
  /** Round up to this step (a multiple of the price increment); null rounds half-up to the increment. */
  roundingMinor: number | null;
  /** The amount a rounded price ends in within its step (0 < ending < step); null for none. */
  endingMinor: number | null;
}

/** The currencies an FX conversion goes between, and the market's price increment. */
export interface FxConversion {
  policy: MarketFxPolicy;
  fromDecimalPlaces: number;
  toDecimalPlaces: number;
  /** The market currency's price increment (minor units). */
  incrementMinor: number;
}

/** Why a market FX policy is refused, or null. Amounts are minor units of the market currency. */
export function marketFxPolicyIssue(policy: MarketFxPolicy, incrementMinor: number): string | null {
  if (!isFxRate(policy.rate)) return "rate";
  if (!Number.isSafeInteger(policy.adjustmentBps)
    || policy.adjustmentBps < MARKET_PRICE_ADJUSTMENT_MIN_BPS
    || policy.adjustmentBps > MARKET_PRICE_ADJUSTMENT_MAX_BPS) return "adjustment";
  const { roundingMinor: step, endingMinor: ending } = policy;
  if (step !== null && (!Number.isSafeInteger(step) || step < incrementMinor || step % incrementMinor !== 0)) return "rounding";
  if (ending !== null) {
    if (step === null) return "ending";
    if (!Number.isSafeInteger(ending) || ending <= 0 || ending >= step || ending % incrementMinor !== 0) return "ending";
  }
  return null;
}

function ceilDiv(top: bigint, bottom: bigint): bigint {
  return (top + bottom - 1n) / bottom;
}

/**
 * A base amount (shop currency minor units) as a market price: × rate ×
 * (1 + adjustment), exact; then half-up to the increment, or up to the
 * rounding step; then the ending (`step − ending` off the rounded price,
 * WooPayments' charm pricing). A positive base never becomes zero or less: an
 * ending that would reach zero keeps the rounded price. Zero stays zero.
 */
export function fxPriceMinor(baseMinor: number, conversion: FxConversion): number {
  assertMinorAmount(baseMinor);
  if (baseMinor < 0) throw new RangeError("A base price is non-negative.");
  if (baseMinor === 0) return 0;
  const { policy, incrementMinor } = conversion;
  // Exact: base × rate (between exponents) × (10000 + bps) / 10000, as one fraction.
  const [whole, fraction = ""] = policy.rate.split(".");
  if (!isFxRate(policy.rate)) throw new RangeError("Invalid exchange rate.");
  const shift = conversion.toDecimalPlaces - conversion.fromDecimalPlaces;
  const top = BigInt(baseMinor) * BigInt(`${whole}${fraction}`) * BigInt(10_000 + policy.adjustmentBps)
    * (shift > 0 ? 10n ** BigInt(shift) : 1n);
  const bottom = 10n ** BigInt(fraction.length) * 10_000n * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  const increment = BigInt(incrementMinor);
  let rounded: bigint;
  if (policy.roundingMinor === null) {
    // Half-up to the increment.
    rounded = ((top * 2n + bottom * increment) / (bottom * increment * 2n)) * increment;
    if (rounded === 0n) rounded = increment;
  } else {
    const step = BigInt(policy.roundingMinor);
    rounded = ceilDiv(top, bottom * step) * step;
    if (rounded === 0n) rounded = step;
    if (policy.endingMinor !== null) {
      const charmed = rounded - step + BigInt(policy.endingMinor);
      if (charmed > 0n) rounded = charmed;
    }
  }
  const value = Number(rounded);
  assertMinorAmount(value);
  return value;
}

/** What converts a store-currency amount: the one rate in use and the market's FX policy. */
export interface StoreAmountConversion {
  /**
   * The rate in use (`PresentmentMoney`: a checkout's one locked rate, or a
   * read's market rate; "1" in the store's own currency), both currencies'
   * places and the market's increment.
   */
  money: { rate: string; decimalPlaces: number; shopDecimalPlaces: number; incrementMinor: number };
  /** The market's FX policy (`PricingMarket.fx`); null when the market prices at base prices. */
  fx: FxConversion | null;
}

/**
 * Which policy a store-currency amount converts under (rules/money/store-amounts-convert-once.md):
 *
 * - `price`: an item's price that is not a product's base price: an app's
 *   price for a line, a fixed bundle tier. Rate, adjustment, rounding step
 *   and ending, exactly as a product price (`fxPriceMinor`).
 * - `add_on`: an amount added to an item's price: the store's buyer-input
 *   surcharges and an app's add-ons. Rate and adjustment, then half-up to the
 *   increment; never the step or ending, which make the item's price point.
 * - `fee`: an amount that is not an item's price: delivery fees, delivery and
 *   promotion thresholds, fixed promotion amounts, money fields. The rate
 *   alone, half-up to the increment; the store's own currency keeps it as it is.
 */
export type StoreAmountKind = "price" | "add_on" | "fee";

/**
 * A store-currency amount in the market's currency: the one conversion every
 * store amount takes (`fxPriceMinor`, at the rate in use, under its kind's
 * policy). In a USD market at 0.0082, +10%, rounded up to $1 and ending .99:
 * ৳1,200 as a `price` is $10.99 (as the ৳1,200 product is), ৳50 as an
 * `add_on` is $0.45 (never the $0.99 a second ending would make it), ৳50 as
 * a `fee` is $0.41. In the store's own currency a price or add-on still takes
 * the market's adjustment and rounds to the increment (৳50.50 at whole taka
 * is ৳51). A positive amount never rounds to nothing (one increment); zero
 * stays zero.
 */
export function storeAmountMinor(amountMinor: number, conversion: StoreAmountConversion, kind: StoreAmountKind): number {
  const { money, fx } = conversion;
  if (kind === "fee" && money.rate === SAME_CURRENCY_FX_RATE && money.decimalPlaces === money.shopDecimalPlaces) return amountMinor;
  const price = kind === "price";
  return fxPriceMinor(amountMinor, {
    policy: {
      // The rate in use, never the market row's newer one.
      rate: money.rate,
      adjustmentBps: kind === "fee" ? 0 : fx?.policy.adjustmentBps ?? 0,
      roundingMinor: price ? fx?.policy.roundingMinor ?? null : null,
      endingMinor: price ? fx?.policy.endingMinor ?? null : null,
    },
    fromDecimalPlaces: money.shopDecimalPlaces,
    toDecimalPlaces: money.decimalPlaces,
    incrementMinor: money.incrementMinor,
  });
}

/** `storeAmountMinor` of an optional amount (an unset threshold stays unset). */
export function storeAmountMinorOrNull(amountMinor: number | null | undefined, conversion: StoreAmountConversion, kind: StoreAmountKind): number | null {
  return amountMinor === null || amountMinor === undefined ? null : storeAmountMinor(amountMinor, conversion, kind);
}

/** The conversion of the store's own currency at a market's increment: identity rate, no FX policy. */
export function sameCurrencyConversion(decimalPlaces: number, incrementMinor: number, fx: FxConversion | null = null): StoreAmountConversion {
  return { money: { rate: SAME_CURRENCY_FX_RATE, decimalPlaces, shopDecimalPlaces: decimalPlaces, incrementMinor }, fx };
}

/**
 * The largest base amount whose market price is at most `marketMinor` (−1
 * when none is): `fxPriceMinor` never decreases, so a buyer's "at most"
 * filter in market prices is "at most this" in base prices.
 */
export function maxBaseForFxPrice(marketMinor: number, conversion: FxConversion, upperBound = 9_000_000_000_000): number {
  if (marketMinor < 0) return -1;
  let low = 0;
  let high = upperBound;
  if (fxPriceMinor(0, conversion) > marketMinor) return -1;
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2);
    let atMost = false;
    try {
      atMost = fxPriceMinor(middle, conversion) <= marketMinor;
    } catch (error) {
      // A search probe can overflow even when the requested price is small.
      // Conversion is monotone, so an unsupported amount lies above the bound.
      if (!(error instanceof MoneyRangeError)) throw error;
    }
    if (atMost) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The smallest base amount whose market price is at least `marketMinor`. */
export function minBaseForFxPrice(marketMinor: number, conversion: FxConversion, upperBound = 9_000_000_000_000): number {
  if (marketMinor <= 0) return 0;
  return maxBaseForFxPrice(marketMinor - 1, conversion, upperBound) + 1;
}

// ---------------------------------------------------------------------------
// Price lists
// ---------------------------------------------------------------------------

/** One stored list price with its list's facts, as readers load it. */
export interface PriceListRow {
  priceListId: string;
  kind: PriceListKind;
  marketId: string;
  /** Segment lists only. */
  segmentId: string | null;
  priority: number;
  /** Epoch seconds; null: no bound. */
  startsAt: number | null;
  endsAt: number | null;
  currencyCode: string;
  amountMinor: number;
  compareAtMinor: number | null;
  minQuantity: number;
}

/** A list price that applies to this buyer now (the resolver's input). */
export interface PriceListPrice {
  priceListId: string;
  kind: PriceListKind;
  priority: number;
  amountMinor: number;
  compareAtMinor: number | null;
  minQuantity: number;
}

/** Whether a list is inside its schedule at `atSeconds` (start inclusive, end exclusive). */
export function isPriceListLive(row: { startsAt: number | null; endsAt: number | null }, atSeconds: number): boolean {
  return (row.startsAt === null || row.startsAt <= atSeconds) && (row.endsAt === null || row.endsAt > atSeconds);
}

/**
 * The rows that apply to one buyer: the market's lists, live at `atSeconds`,
 * in the market currency; segment lists only for a member (`segmentIds`),
 * never on a public read (`segmentIds: "public"`).
 */
export function applicablePriceListPrices(
  rows: readonly PriceListRow[],
  scope: {
    marketId: string;
    currencyCode: string;
    atSeconds: number;
    segmentIds: ReadonlySet<string> | "public";
  },
): PriceListPrice[] {
  const currency = scope.currencyCode.trim().toUpperCase();
  return rows.flatMap((row) => {
    if (row.marketId !== scope.marketId || row.currencyCode !== currency || !isPriceListLive(row, scope.atSeconds)) return [];
    if (row.kind === "segment") {
      if (scope.segmentIds === "public" || row.segmentId === null || !scope.segmentIds.has(row.segmentId)) return [];
    }
    return [{
      priceListId: row.priceListId,
      kind: row.kind,
      priority: row.priority,
      amountMinor: row.amountMinor,
      compareAtMinor: row.compareAtMinor,
      minQuantity: row.minQuantity,
    }];
  });
}

/** The next instant (epoch seconds) a list in `rows` starts or ends after `atSeconds`, or null. */
export function nextPriceListBoundary(rows: ReadonlyArray<{ startsAt: number | null; endsAt: number | null }>, atSeconds: number): number | null {
  let next: number | null = null;
  for (const row of rows) {
    for (const at of [row.startsAt, row.endsAt]) {
      if (at !== null && at > atSeconds && (next === null || at < next)) next = at;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/** A SKU's base buyer price in the shop currency: its price and its price after the catalogue discount. */
export interface BasePrice {
  priceMinor: number;
  effectiveMinor: number;
}

export type ResolvedPriceSource = PriceListKind | "app" | "fx" | "base";

export interface ResolvedPrice {
  /** What one unit costs in the market currency. */
  amountMinor: number;
  /** The struck-through price, only when it is above `amountMinor`. */
  compareAtMinor: number | null;
  source: ResolvedPriceSource;
  /** The list whose row priced it (null for an app, FX and base). */
  priceListId: string | null;
}

/** An app's unit price for one cart line (`cart.line_prices`), in the market currency. */
export interface AppLinePrice {
  amountMinor: number;
  pluginId: string;
  /**
   * The line's purchase option (`<app id>.<key>`) when the app that declares
   * it priced the line: the price outranks every list (see the module header).
   */
  purchaseOption?: string | null;
}

export interface PriceResolutionInput {
  base: BasePrice;
  /** The line quantity (quantity breaks); default 1. */
  quantity?: number;
  /** Applicable list prices for this SKU (`applicablePriceListPrices`). */
  prices: readonly PriceListPrice[];
  /** The market's FX conversion when it is in `fx` mode; null otherwise. */
  fx: FxConversion | null;
  /** The market currency's price increment: list amounts round half-up to it. */
  incrementMinor: number;
  /** An app's price for this line (checkout only); override/segment/market lists outrank it, sales can only lower it, and its own purchase option outranks lists. */
  app?: AppLinePrice | null;
}

function toIncrement(amountMinor: number, incrementMinor: number): number {
  if (incrementMinor <= 1) return amountMinor;
  return Math.max(incrementMinor, Math.floor((amountMinor + incrementMinor / 2) / incrementMinor) * incrementMinor);
}

function compareAbove(amountMinor: number, compareAtMinor: number | null): number | null {
  return compareAtMinor !== null && compareAtMinor > amountMinor ? compareAtMinor : null;
}

/** The FX-derived or base price: what a SKU costs without any list. */
function withoutLists(input: PriceResolutionInput): ResolvedPrice {
  const { base, fx } = input;
  if (fx) {
    const amountMinor = fxPriceMinor(base.effectiveMinor, fx);
    const compareAt = base.priceMinor > base.effectiveMinor ? fxPriceMinor(base.priceMinor, fx) : null;
    return { amountMinor, compareAtMinor: compareAbove(amountMinor, compareAt), source: "fx", priceListId: null };
  }
  return {
    amountMinor: base.effectiveMinor,
    compareAtMinor: compareAbove(base.effectiveMinor, base.priceMinor),
    source: "base",
    priceListId: null,
  };
}

/** Per list, the row with the largest `min_quantity` the quantity reaches. */
function rowPerList(prices: readonly PriceListPrice[], quantity: number): PriceListPrice[] {
  const best = new Map<string, PriceListPrice>();
  for (const price of prices) {
    if (price.minQuantity > quantity) continue;
    const current = best.get(price.priceListId);
    if (!current || price.minQuantity > current.minQuantity) best.set(price.priceListId, price);
  }
  return [...best.values()];
}

function better(left: PriceListPrice, right: PriceListPrice, incrementMinor: number): boolean {
  const rank = KIND_RANK[left.kind] - KIND_RANK[right.kind];
  if (rank !== 0) return rank > 0;
  if (left.kind === "sale") {
    const difference = toIncrement(left.amountMinor, incrementMinor) - toIncrement(right.amountMinor, incrementMinor);
    if (difference !== 0) return difference < 0;
  }
  if (left.priority !== right.priority) return left.priority > right.priority;
  if (left.amountMinor !== right.amountMinor) return left.amountMinor < right.amountMinor;
  return left.priceListId < right.priceListId;
}

/** The one price of a SKU in a market for a buyer and quantity (see the module header). */
export function resolvePrice(input: PriceResolutionInput): ResolvedPrice {
  const app = input.app && Number.isSafeInteger(input.app.amountMinor) && input.app.amountMinor > 0 ? input.app : null;
  if (input.app?.purchaseOption && !app) throw new RangeError("A purchase option requires a valid price from its app.");
  if (app?.purchaseOption) {
    // The option's own price: above every list, struck against the one-time price.
    const oneTime = resolvePrice({ ...input, app: null });
    const amountMinor = toIncrement(app.amountMinor, input.incrementMinor);
    return { amountMinor, compareAtMinor: compareAbove(amountMinor, oneTime.compareAtMinor ?? oneTime.amountMinor), source: "app", priceListId: null };
  }
  const quantity = Math.max(1, Math.floor(input.quantity ?? 1));
  const candidates = rowPerList(input.prices, quantity);
  let winner: PriceListPrice | null = null;
  for (const candidate of candidates) if (!winner || better(candidate, winner, input.incrementMinor)) winner = candidate;
  if (!winner) {
    const fallback = withoutLists(input);
    if (!app) return fallback;
    const amountMinor = toIncrement(app.amountMinor, input.incrementMinor);
    const without = fallback.compareAtMinor ?? fallback.amountMinor;
    return { amountMinor, compareAtMinor: compareAbove(amountMinor, without), source: "app", priceListId: null };
  }
  const amountMinor = toIncrement(winner.amountMinor, input.incrementMinor);
  let compareAt = winner.compareAtMinor === null ? null : toIncrement(winner.compareAtMinor, input.incrementMinor);
  if (winner.kind === "sale") {
    // A sale only lowers the ordinary price; an override wins by rank before
    // reaching this branch. Keep equal-price provenance and compare-at intact.
    const ordinary = resolvePrice({ ...input, prices: input.prices.filter((price) => price.kind !== "sale") });
    if (amountMinor >= ordinary.amountMinor) return ordinary;
    compareAt ??= ordinary.amountMinor;
  }
  return { amountMinor, compareAtMinor: compareAbove(amountMinor, compareAt), source: winner.kind, priceListId: winner.priceListId };
}

/**
 * A resolved price in the catalogue's stored discount shape: the compare-at
 * (or the amount) as the price and the difference as a flat discount, so
 * every reader that applies `discountedPriceMinor` (the product page's
 * pricing engine included) arrives at exactly `amountMinor`.
 */
export function resolvedPriceAsCatalogPrice(resolved: ResolvedPrice): {
  priceMinor: number;
  discountType: "flat" | null;
  discountBps: number;
  discountAmountMinor: number;
} {
  const priceMinor = resolved.compareAtMinor ?? resolved.amountMinor;
  const discountAmountMinor = priceMinor - resolved.amountMinor;
  return {
    priceMinor,
    discountType: discountAmountMinor > 0 ? "flat" : null,
    discountBps: 0,
    discountAmountMinor,
  };
}

/** One SKU of a product for its card: its resolved price and whether a buyer can take it now. */
export interface CardSkuPrice {
  skuId: string;
  available: boolean;
  resolved: ResolvedPrice;
}

/**
 * The card price of a product from its buyer SKUs, by the projection's rule
 * (`buildBuyerCatalogPricingProjection`): the buyable pool when one SKU can
 * be bought now, else every SKU; the lowest price in the pool (then the SKU
 * id) is the card SKU, and the pool's highest price says whether it varies.
 */
export function cardPriceOf(skus: readonly CardSkuPrice[]): { card: CardSkuPrice; maxAmountMinor: number } | null {
  if (skus.length === 0) return null;
  const pool = skus.some((sku) => sku.available) ? skus.filter((sku) => sku.available) : [...skus];
  let card = pool[0]!;
  let maxAmountMinor = card.resolved.amountMinor;
  for (const sku of pool) {
    const amount = sku.resolved.amountMinor;
    if (amount < card.resolved.amountMinor || (amount === card.resolved.amountMinor && sku.skuId < card.skuId)) card = sku;
    if (amount > maxAmountMinor) maxAmountMinor = amount;
  }
  return { card, maxAmountMinor };
}
