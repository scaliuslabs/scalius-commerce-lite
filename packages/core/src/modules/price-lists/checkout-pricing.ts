// Market pricing for checkout (MARKETS-DESIGN D5): cart validation, the tax
// quote, the order commit, staff orders and agents price every line with
// `resolvePrice()` in the market that prices the order.
//
// - The pricing market: the active market of the order's market country (the
//   shipping country, else the billed country), else, before an address is
//   known, the page's presence, else the backup market. It is the market the
//   order records (`orderMarketIdSql`), so a quote and its order agree.
// - Both facts ride in statements checkout already runs: the markets with
//   their FX policies as one scalar (`marketPricingMatrixSql`) and each SKU's
//   list prices as one column (`checkoutListPricesSql`). A store without a
//   list or an FX market prices exactly as before, with the same statements.
// - Segment lists price a signed-in member: only when such a list applies to
//   the cart is membership read (one statement per segment, as promotions do).
import type { Database } from "@scalius/database/client";
import { BACKUP_MARKET_ID } from "@scalius/database/schema";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
    applicablePriceListPrices,
    isPriceListLive,
    resolvePrice,
    type BasePrice,
    type FxConversion,
    type PriceListRow,
    type ResolvedPrice,
} from "@scalius/shared/market-pricing";
import { sql, type SQL } from "drizzle-orm";
import { customerSegmentMembership, readSegmentDefinitions } from "../customers";
import { currentStoreTimeZone } from "../../utils/store-time-zone";
import { marketFxConversion, marketListPricesSql, parseMarketListPrices } from "./market-pricing";

/** One active market as checkout prices in it. */
export interface PricingMarket {
    id: string;
    isBackup: boolean;
    countries: readonly string[];
    /** Its subfolder presences (`en-in`). */
    presences: readonly string[];
    fx: FxConversion | null;
}

/**
 * Every active market with its countries, presences and FX policy as one
 * JSON text, for a statement checkout already runs. Values are cast to text
 * (PostgreSQL's `json_object` takes text). Checkout reads are never cached.
 */
export function marketPricingMatrixSql(): SQL<string | null> {
    return sql<string | null>`(SELECT '[' || group_concat(pricing_market.entry, ',') || ']' FROM (
        SELECT json_object(
            'id', pricing_row.id,
            'b', CAST(pricing_row.is_backup AS TEXT),
            'm', pricing_row.price_mode,
            'r', pricing_row.fx_rate,
            'a', CAST(pricing_row.price_adjustment_bps AS TEXT),
            'd', CAST(pricing_row.price_rounding_minor AS TEXT),
            'e', CAST(pricing_row.price_ending_minor AS TEXT),
            'c', (SELECT group_concat(pricing_country.country_code, ',') FROM market_countries AS pricing_country WHERE pricing_country.market_id = pricing_row.id),
            'p', (SELECT group_concat(pricing_presence.value, ',') FROM market_presences AS pricing_presence WHERE pricing_presence.market_id = pricing_row.id AND pricing_presence.kind = 'subfolder' AND pricing_presence.value <> '')
        ) AS entry
        FROM markets AS pricing_row
        WHERE pricing_row.status = 'active'
    ) AS pricing_market)`;
}

/** Every active list price of a SKU (all markets and kinds) as one column; `variantId` is qualified. */
export function checkoutListPricesSql(variantId: SQL = sql.raw('"product_variants"."id"')): SQL<string | null> {
    return marketListPricesSql(variantId, { all: true });
}

interface MatrixEntry {
    id?: unknown; b?: unknown; m?: unknown; r?: unknown; a?: unknown; d?: unknown; e?: unknown; c?: unknown; p?: unknown;
}

function nullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function list(value: unknown): string[] {
    return typeof value === "string" && value ? value.split(",").filter(Boolean) : [];
}

/** The markets of a `marketPricingMatrixSql()` value, priced in the shop currency at its increment. */
export function parseMarketPricingMatrix(value: unknown, currency: { code: string; incrementMinor: number }): PricingMarket[] {
    if (typeof value !== "string" || value === "") return [];
    let entries: MatrixEntry[] = [];
    try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) entries = parsed as MatrixEntry[];
    } catch {
        return [];
    }
    return entries.flatMap((entry) => {
        if (typeof entry.id !== "string") return [];
        const isBackup = entry.b === "1" || entry.b === 1 || entry.b === "true" || entry.b === true;
        return [{
            id: entry.id,
            isBackup,
            countries: list(entry.c),
            presences: list(entry.p),
            fx: isBackup ? null : marketFxConversion({
                priceMode: typeof entry.m === "string" ? entry.m : null,
                fxRate: typeof entry.r === "string" ? entry.r : null,
                priceAdjustmentBps: nullableNumber(entry.a),
                priceRoundingMinor: nullableNumber(entry.d),
                priceEndingMinor: nullableNumber(entry.e),
            }, { code: currency.code, shopCode: currency.code, incrementMinor: currency.incrementMinor }),
        }];
    });
}

/** What decides the pricing market of a checkout. */
export interface PricingMarketSignals {
    /** The order's market country: the shipping country, else the billed one. */
    countryCode?: string | null;
    /** The page's subfolder presence, before an address is known. */
    presence?: string | null;
}

/**
 * The active market that prices a checkout: its market country's, else (no
 * country yet) its presence's, else the backup market. A country no active
 * market sells to prices in the backup market, as the order is placed there.
 */
export function pricingMarketOf(markets: readonly PricingMarket[], signals: PricingMarketSignals): PricingMarket | null {
    const backup = markets.find((market) => market.isBackup) ?? null;
    const country = signals.countryCode?.trim().toUpperCase();
    if (country) return markets.find((market) => market.countries.includes(country)) ?? backup;
    const presence = signals.presence?.trim().toLowerCase();
    if (presence) return markets.find((market) => market.presences.includes(presence)) ?? backup;
    return backup;
}

/** Everything checkout needs to price one cart's lines in its market. */
export interface CheckoutPriceScope {
    /** Null: the store has no market row (before 0112): base prices. */
    market: PricingMarket | null;
    currencyCode: string;
    incrementMinor: number;
    /** The segments the signed-in buyer is in (empty for a guest). */
    segmentIds: ReadonlySet<string>;
    atSeconds: number;
}

/** A line's unit price (before buyer-input surcharges) in the scope's market. */
export function resolveCheckoutSkuPrice(
    scope: CheckoutPriceScope,
    base: BasePrice,
    listPrices: readonly PriceListRow[],
    quantity: number,
): ResolvedPrice {
    const market = scope.market;
    return resolvePrice({
        base,
        quantity,
        fx: market?.fx ?? null,
        incrementMinor: scope.incrementMinor,
        prices: market
            ? applicablePriceListPrices(listPrices, {
                marketId: market.id,
                currencyCode: scope.currencyCode,
                atSeconds: scope.atSeconds,
                segmentIds: scope.segmentIds,
            })
            : [],
    });
}

/** The segments of live segment lists of this market among the cart's SKU prices: membership to read. */
export function segmentListIds(marketId: string | null | undefined, rows: readonly PriceListRow[], atSeconds: number): string[] {
    if (!marketId) return [];
    const ids = new Set<string>();
    for (const row of rows) {
        if (row.kind === "segment" && row.segmentId && row.marketId === marketId && isPriceListLive(row, atSeconds)) ids.add(row.segmentId);
    }
    return [...ids];
}

/**
 * Which of these segments a signed-in customer is in now (one statement per
 * segment, read only when a segment list applies). A guest is in none.
 */
export async function matchPriceListSegments(
    db: Database,
    customerId: string | null | undefined,
    segmentIds: readonly string[],
    atSeconds = Math.floor(Date.now() / 1_000),
): Promise<Set<string>> {
    const unique = [...new Set(segmentIds)];
    if (!customerId || unique.length === 0) return new Set();
    const definitions = await readSegmentDefinitions(db, unique);
    return customerSegmentMembership(
        db,
        customerId,
        unique.map((id) => ({ id, definition: definitions.get(id) ?? null })),
        { nowSeconds: atSeconds, timeZone: currentStoreTimeZone() },
    );
}

/** The backup market's id (base prices). */
export { BACKUP_MARKET_ID };

/** The decimal places of a scope's currency. */
export function scopeDecimalPlaces(scope: Pick<CheckoutPriceScope, "currencyCode">): number {
    return getDecimalPlaces(scope.currencyCode);
}

// ---------------------------------------------------------------------------
// The market a checkout prices in (MARKETS-DESIGN D5): cart validation, the
// tax quote, the order and agent checkout price every line with
// `resolvePrice()` in it. Promotions, bundles and app discounts then apply to
// those unit prices, as before.
//
// - Placing an order (the quote and the order): the order's market, by the
//   rule the order records it (`orderMarketIdSql`): the shipping country when
//   a physical line ships (a pickup sends none), the billed country when
//   nothing physical is sold, else the backup market. The quote and the order
//   apply the same rule to the same request, so they always agree.
// - Before an address (the cart page): the country the buyer picked, else the
//   page's presence, else the backup market.

/** What says which market prices a checkout. */
export interface CheckoutMarketSignals {
    /** The page's subfolder presence (the cart page). */
    presence?: string | null;
    shippingCountryCode?: string | null;
    billingCountryCode?: string | null;
    /** The quote or the order: the order's market rule applies. */
    placing?: boolean;
    /** The signed-in buyer (segment price lists); a promise is awaited only when a segment list applies. */
    customerId?: string | null | PromiseLike<string | null>;
}

interface PricedItem {
    productId: string;
    variantId: string;
}

interface PricingProductRow {
    id: string;
    isGiftCard: boolean;
    pricingMatrix?: string | null;
}

interface PricingVariantRow {
    id: string;
    fulfillmentKind: string;
    listPrices?: string | null;
}

/** The country whose market prices the checkout (null: the backup market, or the presence before an address). */
export function checkoutMarketCountry(
    items: readonly PricedItem[],
    productRows: readonly PricingProductRow[],
    variantRows: readonly PricingVariantRow[],
    signals: CheckoutMarketSignals,
): string | null {
    const shipping = signals.shippingCountryCode?.trim().toUpperCase() || null;
    const billing = signals.billingCountryCode?.trim().toUpperCase() || null;
    if (!signals.placing) return shipping;
    const products = new Map(productRows.map((row) => [row.id, row]));
    const variants = new Map(variantRows.map((row) => [row.id, row]));
    const shipsPhysical = items.some((item) =>
        variants.get(item.variantId)?.fulfillmentKind === "physical" && products.get(item.productId)?.isGiftCard !== true);
    return shipsPhysical ? shipping : billing;
}

/**
 * The price scope of one checkout: its market (from the markets read with
 * the cart's products), the buyer's segments when a segment list of that
 * market prices one of the cart's SKUs (then one statement per segment), and
 * the instant it prices at. Null when nothing can price away from base
 * prices: no FX market and no list price on the cart's SKUs.
 */
export async function resolveCheckoutPriceScope(
    db: Database,
    input: {
        items: readonly PricedItem[];
        productRows: readonly PricingProductRow[];
        variantRows: readonly PricingVariantRow[];
        currency: { code: string; incrementMinor: number };
        signals: CheckoutMarketSignals;
        atSeconds?: number;
    },
): Promise<CheckoutPriceScope | null> {
    const markets = parseMarketPricingMatrix(input.productRows[0]?.pricingMatrix, input.currency);
    const listRows = input.variantRows.flatMap((row) => parseMarketListPrices(row.listPrices));
    if (!markets.some((market) => market.fx !== null) && listRows.length === 0) return null;
    const country = checkoutMarketCountry(input.items, input.productRows, input.variantRows, input.signals);
    const market = pricingMarketOf(markets, country
        ? { countryCode: country }
        : { presence: input.signals.placing ? null : input.signals.presence });
    const atSeconds = input.atSeconds ?? Math.floor(Date.now() / 1_000);
    const segments = market ? segmentListIds(market.id, listRows, atSeconds) : [];
    return {
        market,
        currencyCode: input.currency.code,
        incrementMinor: input.currency.incrementMinor,
        segmentIds: segments.length > 0 ? await matchPriceListSegments(db, await input.signals.customerId, segments, atSeconds) : new Set(),
        atSeconds,
    };
}
