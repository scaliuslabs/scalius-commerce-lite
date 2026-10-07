// Market pricing at read time (MARKETS-DESIGN D5, "Step 4a implemented"):
// the price context of a market-keyed public read and the helpers that turn
// base catalogue rows into the market's prices with `resolvePrice()`.
//
// - A root read (no presence) never comes here: it is today's read, byte for
//   byte, and pays nothing.
// - A presence read reads its market's context in one statement beside its
//   own reads. A market that prices like the backup market (fixed mode, or an
//   FX policy that is the identity, and no live public list) is neutral: the
//   read answers the root's bytes.
// - FX-derived prices transform the rows already read (no statement). Fixed
//   list prices ride in a column of the SKU statement the read already runs
//   (`marketListPricesSql`), or, for cards priced from the projection, one
//   statement for the shown products' SKUs.
import type { Database } from "@scalius/database/client";
import { marketPresences, markets, productVariants, products } from "@scalius/database/schema";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
    applicablePriceListPrices,
    cardPriceOf,
    isPriceListKind,
    isPriceListLive,
    marketFxPolicyIssue,
    marketFxRate,
    nextPriceListBoundary,
    resolvePrice,
    resolvedPriceAsCatalogPrice,
    type BasePrice,
    type FxConversion,
    type MarketFxPolicy,
    type PriceListRow,
    type ResolvedPrice,
} from "@scalius/shared/market-pricing";
import { discountedPriceMinor } from "@scalius/shared/money";
import { NotFoundError } from "@scalius/core/errors";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { deps } from "../../cache-deps";
import { servedLanguageSql, storePriceIncrementSql } from "../markets";
import { channelAvailableStockSql, effectivePriceMinorSql, type BuyerPricingMinor } from "../products";
import { storeCurrencyCodeSql, storeCurrencyFromCode } from "../settings";

/** How one market prices for an anonymous buyer now. */
export interface MarketPriceContext {
    marketId: string;
    /** The market's currency: the shop currency until step 6. */
    currencyCode: string;
    decimalPlaces: number;
    incrementMinor: number;
    /** Its FX conversion in `fx` mode, unless it is the identity. */
    fx: FxConversion | null;
    /** An active public list is live now: list prices must be read. */
    listed: boolean;
    /** The instant the read priced at (epoch seconds). */
    atSeconds: number;
}

/** A market that prices exactly like the backup market: its reads answer the root's bytes. */
export function isNeutralMarketPricing(context: MarketPriceContext | null | undefined): boolean {
    return !context || (context.fx === null && !context.listed);
}

/** The FX conversion of a market row, or null when it prices at base prices. */
export function marketFxConversion(row: {
    priceMode: string | null;
    fxRate: string | null;
    priceAdjustmentBps: number | null;
    priceRoundingMinor: number | null;
    priceEndingMinor: number | null;
}, currency: { code: string; shopCode: string; incrementMinor: number }): FxConversion | null {
    if (row.priceMode !== "fx") return null;
    const rate = marketFxRate({ currencyCode: currency.code, fxRate: row.fxRate }, currency.shopCode);
    // No rate: the market cannot derive prices; until step 6 it sells the shop
    // currency, whose rate is always "1", so this cannot happen yet.
    if (rate === null) return null;
    let policy: MarketFxPolicy = {
        rate,
        adjustmentBps: Number(row.priceAdjustmentBps ?? 0),
        roundingMinor: row.priceRoundingMinor === null ? null : Number(row.priceRoundingMinor),
        endingMinor: row.priceEndingMinor === null ? null : Number(row.priceEndingMinor),
    };
    // A rounding that no longer fits the increment (it changed since) is
    // dropped rather than pricing off the increment.
    const issue = marketFxPolicyIssue(policy, currency.incrementMinor);
    if (issue === "rounding" || issue === "ending") policy = { ...policy, roundingMinor: null, endingMinor: null };
    else if (issue !== null) return null;
    if (policy.rate === "1" && policy.adjustmentBps === 0 && policy.roundingMinor === null) return null;
    const decimalPlaces = getDecimalPlaces(currency.code);
    return { policy, fromDecimalPlaces: getDecimalPlaces(currency.shopCode), toDecimalPlaces: decimalPlaces, incrementMinor: currency.incrementMinor };
}

interface ScheduleRow {
    s?: unknown;
    e?: unknown;
}

function epochOrNull(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function parseJsonArray<T>(value: unknown): T[] {
    if (typeof value !== "string" || value === "") return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
        return [];
    }
}

/**
 * The pricing context of the market a presence names (`en-in`), read in one
 * statement. Declares `mk:<id>` (the market resolves the presence) and
 * `pl:<id>` (its pricing and lists), and, when a list starts or ends later,
 * that instant as the entry's validity. An unknown or inactive presence is a
 * 404, as the checkout config answers.
 */
export async function readMarketPriceContext(
    db: Database,
    presence: string,
    atSeconds = Math.floor(Date.now() / 1_000),
): Promise<MarketPriceContext> {
    const row = await db.select({
        id: markets.id,
        priceMode: markets.priceMode,
        fxRate: markets.fxRate,
        priceAdjustmentBps: markets.priceAdjustmentBps,
        priceRoundingMinor: markets.priceRoundingMinor,
        priceEndingMinor: markets.priceEndingMinor,
        currencyCode: storeCurrencyCodeSql(),
        incrementMinor: storePriceIncrementSql(),
        // The schedules of its active public lists (a handful).
        lists: sql<string | null>`(SELECT '[' || group_concat(json_object(
            's', CAST(context_list.starts_at AS TEXT),
            'e', CAST(context_list.ends_at AS TEXT)
        ), ',') || ']' FROM price_lists AS context_list
        WHERE context_list.market_id = ${markets.id} AND context_list.status = 'active' AND context_list.kind <> 'segment')`,
    })
        .from(markets)
        .innerJoin(marketPresences, and(
            eq(marketPresences.marketId, markets.id),
            eq(marketPresences.kind, "subfolder"),
            eq(marketPresences.value, presence),
            // Only a published language's presence is served (MARKETS-DESIGN D9).
            servedLanguageSql(),
        ))
        .where(eq(markets.status, "active"))
        .get();
    // Which presences are served: their locales and the published languages.
    deps.translationLocales();
    if (!row) throw new NotFoundError("Market not found");
    deps.market(row.id);
    deps.marketPricing(row.id);
    const shopCode = storeCurrencyFromCode(row.currencyCode);
    const incrementMinor = Number(row.incrementMinor);
    const schedules = parseJsonArray<ScheduleRow>(row.lists).map((entry) => ({ startsAt: epochOrNull(entry.s), endsAt: epochOrNull(entry.e) }));
    const boundary = nextPriceListBoundary(schedules, atSeconds);
    if (boundary !== null) deps.validUntil(boundary * 1_000);
    return {
        marketId: row.id,
        currencyCode: shopCode,
        decimalPlaces: getDecimalPlaces(shopCode),
        incrementMinor,
        fx: marketFxConversion(row, { code: shopCode, shopCode, incrementMinor }),
        listed: schedules.some((schedule) => isPriceListLive(schedule, atSeconds)),
        atSeconds,
    };
}

/**
 * A market-keyed read's pricing: the page's presence (statements that read
 * SKUs fold its list prices in by it) and its market's context, read beside
 * the page's own reads and awaited where prices are presented.
 */
export interface MarketPricing {
    presence: string;
    context: Promise<MarketPriceContext>;
}

/** Starts reading a presence's pricing context; null for the root (no presence). */
export function startMarketPricing(db: Database, presence: string | null | undefined): MarketPricing | null {
    if (!presence) return null;
    const context = readMarketPriceContext(db, presence);
    // Awaited later; a read that fails first must not leave it unhandled.
    context.catch(() => undefined);
    return { presence, context };
}

/** The context of a read's pricing, or null at the root. */
export async function marketPriceContextOf(pricing: MarketPricing | null | undefined): Promise<MarketPriceContext | null> {
    return pricing ? pricing.context : null;
}

// ---------------------------------------------------------------------------
// List prices folded into a SKU statement
// ---------------------------------------------------------------------------

/** Which lists a folded column reads. */
export type MarketListScope =
    /** One market's active public lists. */
    | { marketId: string }
    /** The active public lists of the market a presence names (no read needed first). */
    | { presence: string }
    /** Every active list of every market and kind (checkout, staff orders, agents). */
    | { all: true };

/**
 * The list prices of one SKU as one JSON text column (NULL without any): a
 * correlated scalar on the price index (`price_list_prices_variant_idx`), so
 * a statement that already reads SKUs carries them at no extra statement.
 * `variantId` is a qualified reference (`sql.raw('"product_variants"."id"')`):
 * Drizzle renders a single-table select's columns unqualified, and a bare
 * `id` here would bind to the price list.
 */
export function marketListPricesSql(variantId: SQL, scope: MarketListScope): SQL<string | null> {
    const market = "marketId" in scope
        ? sql`AND list_price_list.market_id = ${scope.marketId} AND list_price_list.kind <> 'segment'`
        : "presence" in scope
            ? sql`AND list_price_list.market_id = (SELECT list_presence.market_id FROM market_presences AS list_presence WHERE list_presence.kind = 'subfolder' AND list_presence.value = ${scope.presence}) AND list_price_list.kind <> 'segment'`
            : sql``;
    return sql<string | null>`(SELECT '[' || group_concat(json_object(
        'l', list_price_list.id,
        'k', list_price_list.kind,
        'm', list_price_list.market_id,
        'g', list_price_list.segment_id,
        'p', CAST(list_price_list.priority AS TEXT),
        's', CAST(list_price_list.starts_at AS TEXT),
        'e', CAST(list_price_list.ends_at AS TEXT),
        'c', list_price.currency_code,
        'a', CAST(list_price.amount_minor AS TEXT),
        'x', CAST(list_price.compare_at_minor AS TEXT),
        'q', CAST(list_price.min_quantity AS TEXT)
    ), ',') || ']'
    FROM price_list_prices AS list_price
    INNER JOIN price_lists AS list_price_list ON list_price_list.id = list_price.price_list_id
    WHERE list_price.variant_id = ${variantId} AND list_price_list.status = 'active' ${market})`;
}

interface ListPriceJson {
    l?: unknown; k?: unknown; m?: unknown; g?: unknown; p?: unknown; s?: unknown; e?: unknown;
    c?: unknown; a?: unknown; x?: unknown; q?: unknown;
}

/** The rows of a `marketListPricesSql` value; malformed entries are dropped. */
export function parseMarketListPrices(value: unknown): PriceListRow[] {
    return parseJsonArray<ListPriceJson>(value).flatMap((entry) => {
        const amountMinor = Number(entry.a);
        const minQuantity = Number(entry.q ?? 1);
        if (typeof entry.l !== "string" || !isPriceListKind(entry.k) || typeof entry.m !== "string" || typeof entry.c !== "string"
            || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !Number.isSafeInteger(minQuantity) || minQuantity < 1) return [];
        const compareAt = epochOrNull(entry.x);
        return [{
            priceListId: entry.l,
            kind: entry.k,
            marketId: entry.m,
            segmentId: typeof entry.g === "string" ? entry.g : null,
            priority: Number(entry.p ?? 0) || 0,
            startsAt: epochOrNull(entry.s),
            endsAt: epochOrNull(entry.e),
            currencyCode: entry.c,
            amountMinor,
            compareAtMinor: compareAt !== null && Number.isSafeInteger(compareAt) ? compareAt : null,
            minQuantity,
        }];
    });
}

/** A SKU's resolved price for an anonymous buyer in this market (quantity 1 unless given). */
export function resolvePublicSkuPrice(
    context: MarketPriceContext,
    base: BasePrice,
    listPrices: readonly PriceListRow[],
    quantity = 1,
): ResolvedPrice {
    return resolvePrice({
        base,
        quantity,
        fx: context.fx,
        incrementMinor: context.incrementMinor,
        prices: context.listed
            ? applicablePriceListPrices(listPrices, {
                marketId: context.marketId,
                currencyCode: context.currencyCode,
                atSeconds: context.atSeconds,
                segmentIds: "public",
            })
            : [],
    });
}

/** The catalogue's stored price fields of a resolved price (`resolvedPriceAsCatalogPrice`). */
export { resolvedPriceAsCatalogPrice };

// ---------------------------------------------------------------------------
// SKU rows and cards
// ---------------------------------------------------------------------------

/** The stored price columns of a SKU or product row. */
export interface CatalogDiscountColumns {
    priceMinor: number;
    discountType: string | null;
    discountBps: number | null;
    discountAmountMinor: number | null;
}

/**
 * SKU rows priced in the market: each row's price and discount columns are
 * the resolved price in the catalogue's shape (a flat discount from the
 * compare-at), so the product page's pricing engine, the feed and every
 * reader that applies `discountedPriceMinor` arrive at the market price. The
 * product's own discount no longer applies to them (`neutralProductDiscount`).
 * `effectiveMinor` is the row's base buyer price (`discountedPriceMinor` of
 * its own and its product's discount).
 */
export function priceSkuRows<T extends CatalogDiscountColumns & { id: string }>(
    context: MarketPriceContext,
    rows: readonly T[],
    effectiveMinor: (row: T) => number,
    listPrices: (row: T) => readonly PriceListRow[],
): Array<T & { resolvedPrice: ResolvedPrice }> {
    return rows.map((row) => {
        const resolved = resolvePublicSkuPrice(context, { priceMinor: row.priceMinor, effectiveMinor: effectiveMinor(row) }, listPrices(row));
        return { ...row, ...resolvedPriceAsCatalogPrice(resolved), resolvedPrice: resolved };
    });
}

/** A SKU row a product page, feed or search reads: its price columns, stock and folded list prices. */
export interface MarketSkuRow extends CatalogDiscountColumns {
    id: string;
    productId: string;
    trackInventory: boolean;
    stock: number;
    reservedStock: number;
    /** With option SKUs, a product's hidden default SKU is not in its card's pool. */
    isDefault?: boolean;
    optionCombinationKey?: string | null;
    /** The `marketListPricesSql` column (absent at the root). */
    listPrices?: string | null;
}

/**
 * SKU rows of some products priced in the market (MARKETS-DESIGN D5). Each
 * SKU's price columns become its resolved market price in the catalogue's
 * shape (its base buyer price takes its own discount, else its product's);
 * each product's own price becomes its card's over its SKUs (the buyable ones
 * first, as the projection picks), so readers that let a SKU without a
 * discount fall back to its product's arrive at the market price too. A
 * neutral market (and the root) returns the rows as read, the folded column
 * removed.
 */
export function priceProductSkus<TSku extends MarketSkuRow>(
    context: MarketPriceContext | null | undefined,
    products: ReadonlyMap<string, CatalogDiscountColumns>,
    skus: readonly TSku[],
    incrementMinor: number,
): { skus: Array<Omit<TSku, "listPrices">>; productPrices: Map<string, CatalogDiscountColumns> } {
    const strip = (sku: TSku): Omit<TSku, "listPrices"> => {
        const { listPrices: _listPrices, ...rest } = sku;
        return rest;
    };
    const productPrices = new Map<string, CatalogDiscountColumns>();
    if (!context || isNeutralMarketPricing(context)) return { skus: skus.map(strip), productPrices };
    if (context.listed) deps.marketProductPricing(context.marketId, [...new Set(skus.map((sku) => sku.productId))]);
    const pools = new Map<string, Array<{ skuId: string; available: boolean; resolved: ResolvedPrice }>>();
    const priced = skus.map((sku) => {
        const product = products.get(sku.productId);
        const own = (sku.discountType === "percentage" && Number(sku.discountBps) > 0)
            || (sku.discountType === "flat" && Number(sku.discountAmountMinor) > 0);
        const discount = own || !product ? sku : product;
        const effectiveMinor = discountedPriceMinor(sku.priceMinor, discount.discountType, discount.discountBps, discount.discountAmountMinor, incrementMinor);
        const resolved = resolvePublicSkuPrice(context, { priceMinor: sku.priceMinor, effectiveMinor }, parseMarketListPrices(sku.listPrices));
        const pool = pools.get(sku.productId) ?? [];
        pool.push({ skuId: sku.id, available: !sku.trackInventory || sku.stock - sku.reservedStock > 0, resolved });
        pools.set(sku.productId, pool);
        return { ...strip(sku), ...resolvedPriceAsCatalogPrice(resolved) };
    });
    const optioned = new Set(skus.filter((sku) => sku.isDefault === false && Boolean(sku.optionCombinationKey?.trim())).map((sku) => sku.productId));
    const defaults = new Set(skus.filter((sku) => sku.isDefault === true).map((sku) => sku.id));
    for (const [productId, all] of pools) {
        const pool = optioned.has(productId) ? all.filter((sku) => !defaults.has(sku.skuId)) : all;
        const card = cardPriceOf(pool);
        if (card) productPrices.set(productId, resolvedPriceAsCatalogPrice(card.card.resolved));
    }
    return { skus: priced, productPrices };
}

/** A product row whose own discount must no longer apply to its market-priced SKUs. */
export function neutralProductDiscount<T extends CatalogDiscountColumns>(row: T, priceMinor: number): T {
    return { ...row, priceMinor, discountType: null, discountBps: 0, discountAmountMinor: 0 };
}

/** One buyer SKU of a card's pool with its base price, availability and the market's list prices. */
interface CardSkuRow {
    skuId: string;
    productId: string;
    priceMinor: number;
    effectiveMinor: number;
    available: number;
    listPrices: string | null;
}

/**
 * The buyer pool of these products' cards (the projection's pool, see
 * `buildBuyerCatalogPricingProjection`) with each SKU's base buyer price,
 * whether it can be bought now and the market's list prices: one statement.
 */
async function readCardSkus(db: Database, marketId: string, productIds: readonly string[]): Promise<CardSkuRow[]> {
    if (productIds.length === 0) return [];
    const ids = JSON.stringify([...new Set(productIds)]);
    const effective = effectivePriceMinorSql({
        priceMinor: sql`${productVariants.priceMinor}`,
        discountType: sql`${productVariants.discountType}`,
        discountBps: sql`${productVariants.discountBps}`,
        discountAmountMinor: sql`${productVariants.discountAmountMinor}`,
    }, {
        discountType: sql`${products.discountType}`,
        discountBps: sql`${products.discountBps}`,
        discountAmountMinor: sql`${products.discountAmountMinor}`,
    });
    return db.select({
        skuId: productVariants.id,
        productId: productVariants.productId,
        priceMinor: productVariants.priceMinor,
        effectiveMinor: effective,
        available: sql<number>`CASE WHEN ${productVariants.trackInventory} = 0 OR ${channelAvailableStockSql({ id: sql`${productVariants.id}`, stock: sql`${productVariants.stock}`, reservedStock: sql`${productVariants.reservedStock}` })} > 0 THEN 1 ELSE 0 END`,
        listPrices: marketListPricesSql(sql.raw('"product_variants"."id"'), { marketId }),
    })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(
            sql`${productVariants.productId} IN (SELECT CAST(value AS TEXT) FROM json_each(${ids}))`,
            isNull(productVariants.deletedAt),
            sql`${productVariants.id} <> 'default'`,
            sql`(
                ${productVariants.isDefault} = 0
                OR NOT EXISTS (
                    SELECT 1 FROM product_variants AS card_option_sku
                    WHERE card_option_sku.product_id = ${productVariants.productId}
                      AND card_option_sku.deleted_at IS NULL
                      AND card_option_sku.id <> 'default'
                      AND card_option_sku.is_default = 0
                      AND trim(coalesce(card_option_sku.option_combination_key, '')) <> ''
                )
            )`,
        )) as unknown as Promise<CardSkuRow[]>;
}

/** A card row's pricing columns with the resolved card price (the card SKU's, and the pool's maximum). */
function pricedCard<T extends BuyerPricingMinor>(row: T, resolved: ResolvedPrice, maxAmountMinor: number): T {
    const shape = resolvedPriceAsCatalogPrice(resolved);
    return {
        ...row,
        basePriceMinor: shape.priceMinor,
        discountType: shape.discountType,
        discountBps: shape.discountBps,
        discountAmountMinor: shape.discountAmountMinor,
        effectivePriceMinor: resolved.amountMinor,
        maxBuyerPriceMinor: Math.max(resolved.amountMinor, maxAmountMinor),
    };
}

/**
 * Card rows (`BuyerPricingMinor`, keyed by product `id`) priced in the
 * market. A neutral market returns them as they are. FX alone transforms the
 * projection's prices (FX-derived prices never fall as the base rises, so
 * the card SKU and the "from" price stay the projection's). Live list prices
 * read the products' buyer SKUs in one statement and re-pick each card by
 * the projection's rule; each product then depends on `pl:<market>:<id>`.
 */
export async function priceProductCards<T extends BuyerPricingMinor & { id: string }>(
    db: Database,
    context: MarketPriceContext | null | undefined,
    rows: readonly T[],
): Promise<T[]> {
    if (!context || isNeutralMarketPricing(context) || rows.length === 0) return [...rows];
    // A market price reads facts a root card may not show (the pool's highest
    // price, each SKU's own price, discount and availability): every one is a
    // fact of `p:<product>`.
    deps.products(rows.map((row) => row.id));
    if (!context.listed) {
        return rows.map((row) => {
            const resolved = resolvePrice({
                base: { priceMinor: row.basePriceMinor, effectiveMinor: row.effectivePriceMinor },
                prices: [],
                fx: context.fx,
                incrementMinor: context.incrementMinor,
            });
            const max = resolvePrice({
                base: { priceMinor: row.maxBuyerPriceMinor, effectiveMinor: row.maxBuyerPriceMinor },
                prices: [],
                fx: context.fx,
                incrementMinor: context.incrementMinor,
            }).amountMinor;
            return pricedCard(row, resolved, max);
        });
    }
    const productIds = rows.map((row) => row.id);
    deps.marketProductPricing(context.marketId, productIds);
    const skus = await readCardSkus(db, context.marketId, productIds);
    const byProduct = new Map<string, CardSkuRow[]>();
    for (const sku of skus) {
        const list = byProduct.get(sku.productId) ?? [];
        list.push(sku);
        byProduct.set(sku.productId, list);
    }
    return rows.map((row) => {
        const card = cardPriceOf((byProduct.get(row.id) ?? []).map((sku) => ({
            skuId: sku.skuId,
            available: Number(sku.available) === 1,
            resolved: resolvePublicSkuPrice(
                context,
                { priceMinor: Number(sku.priceMinor), effectiveMinor: Number(sku.effectiveMinor) },
                parseMarketListPrices(sku.listPrices),
            ),
        })));
        return card ? pricedCard(row, card.card.resolved, card.maxAmountMinor) : row;
    });
}

/** A base amount (a price filter bound, a facet edge) in the market: FX only, lists never move it. */
export function marketAmountMinor(context: MarketPriceContext | null | undefined, baseMinor: number): number {
    if (!context?.fx) return baseMinor;
    return resolvePrice({ base: { priceMinor: baseMinor, effectiveMinor: baseMinor }, prices: [], fx: context.fx, incrementMinor: context.incrementMinor }).amountMinor;
}
