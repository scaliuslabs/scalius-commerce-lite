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
 *   active sale list > segment list > market list > FX-derived > base
 *
 * - A list price applies only while its list is active and inside its
 *   schedule, in the market's currency, and (segment lists) to a member of
 *   its customer segment. Callers filter with `applicablePriceListPrices()`.
 * - Quantity breaks are `min_quantity` rows (Medusa): a list offers the row
 *   with the largest `min_quantity` that the line quantity reaches.
 * - Among lists of the same kind: the higher priority wins, then the lower
 *   amount, then the smaller list id (so the answer never depends on row order).
 * - A list price replaces the SKU's price and its catalogue discount. Its
 *   compare-at is the row's own; a sale row without one compares against the
 *   price the buyer would pay without sale lists (Medusa's original price).
 * - FX-derived (a market in `fx` mode): the base buyer price converted at the
 *   market's rate, adjusted by its percentage, rounded half-up to the price
 *   increment, then up to the market's rounding step and its ending
 *   (WooPayments' rounding and charm pricing). The compare-at is the base
 *   price converted the same way (Shopify adjusts compare-at too).
 * - Base: the SKU's price after its catalogue discount (`discountedPriceMinor`).
 *
 * Promotions, bundles and app discounts apply after this, in today's order:
 * they see the resolved unit price as the line's catalogue price.
 */
import { convertMinorAtRate, isFxRate, SAME_CURRENCY_FX_RATE } from "./money-chain";

export const PRICE_LIST_KINDS = ["market", "segment", "sale"] as const;
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
const KIND_RANK: Readonly<Record<PriceListKind, number>> = { sale: 3, segment: 2, market: 1 };

/** Lists a public (anonymous, cacheable) read may apply: never segment lists. */
export const PUBLIC_PRICE_LIST_KINDS: readonly PriceListKind[] = ["market", "sale"];

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
 * Where a market's exchange rate comes from. Step 4a ships the manual source
 * only: the merchant's rate on the market (or "1" while the market sells the
 * shop currency). A rate provider (ECB, an app) implements this port later
 * (`docs/MARKETS-DESIGN.md`, "Step 4a implemented", left for later).
 */
export interface FxRateSource {
  readonly id: string;
  /** Units of `to` per one unit of `from`, as a decimal string, or null when it has none. */
  rate(from: string, to: string): Promise<{ rate: string; asOf: Date | null } | null>;
}

/** The only source in step 4a: the market's manual rate. */
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
  if (!Number.isSafeInteger(baseMinor) || baseMinor < 0) throw new RangeError("A base price is a non-negative safe integer.");
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
  if (!Number.isSafeInteger(value)) throw new RangeError("The converted price exceeds the supported range.");
  return value;
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
    if (fxPriceMinor(middle, conversion) <= marketMinor) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The smallest base amount whose market price is at least `marketMinor`. */
export function minBaseForFxPrice(marketMinor: number, conversion: FxConversion, upperBound = 9_000_000_000_000): number {
  if (marketMinor <= 0) return 0;
  return maxBaseForFxPrice(marketMinor - 1, conversion, upperBound) + 1;
}

/** A converted amount between currencies without market rounding (reporting, previews). */
export function convertAtMarketRate(amountMinor: number, rate: string, fromDecimalPlaces: number, toDecimalPlaces: number): number {
  return convertMinorAtRate(amountMinor, rate, fromDecimalPlaces, toDecimalPlaces);
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

export type ResolvedPriceSource = PriceListKind | "fx" | "base";

export interface ResolvedPrice {
  /** What one unit costs in the market currency. */
  amountMinor: number;
  /** The struck-through price, only when it is above `amountMinor`. */
  compareAtMinor: number | null;
  source: ResolvedPriceSource;
  /** The list whose row priced it (null for FX and base). */
  priceListId: string | null;
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

function better(left: PriceListPrice, right: PriceListPrice): boolean {
  const rank = KIND_RANK[left.kind] - KIND_RANK[right.kind];
  if (rank !== 0) return rank > 0;
  if (left.priority !== right.priority) return left.priority > right.priority;
  if (left.amountMinor !== right.amountMinor) return left.amountMinor < right.amountMinor;
  return left.priceListId < right.priceListId;
}

/** The one price of a SKU in a market for a buyer and quantity (see the module header). */
export function resolvePrice(input: PriceResolutionInput): ResolvedPrice {
  const quantity = Math.max(1, Math.floor(input.quantity ?? 1));
  const candidates = rowPerList(input.prices, quantity);
  let winner: PriceListPrice | null = null;
  for (const candidate of candidates) if (!winner || better(candidate, winner)) winner = candidate;
  if (!winner) return withoutLists(input);
  const amountMinor = toIncrement(winner.amountMinor, input.incrementMinor);
  let compareAt = winner.compareAtMinor === null ? null : toIncrement(winner.compareAtMinor, input.incrementMinor);
  if (compareAt === null && winner.kind === "sale") {
    compareAt = resolvePrice({ ...input, prices: input.prices.filter((price) => price.kind !== "sale") }).amountMinor;
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
