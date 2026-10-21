// Buyer product listings: the shop, category and collection pages.
//
// Every statement reads the stored buyer state (`product_buyer_state`, see
// buyer-state.ts): the public set, the card SKU's prices, discount depth and
// availability are indexed columns, so a listing never evaluates the public
// eligibility predicate or ranks SKUs per request.
import { products, categories } from "@scalius/database/schema";
import { and, sql, desc, eq, type SQL, type SQLWrapper } from "drizzle-orm";
import { suggestSearchCorrection } from "./search-correction";
import { marketPriceOrder } from "./market-price-order";
import { productSearchRank, productSearchRelevanceOrder } from "./search-relevance";
import { unixToDate } from "@scalius/shared/utils";
import { fromMinor } from "@scalius/shared/money";
import { planLimits } from "@scalius/shared/plan-limits";
import { cappedCountLimit, capTotal, encodeListCursor } from "@scalius/shared/pagination";
import { invalidCursor, keysetCondition, readListCursor, type KeysetOrder } from "../../utils/keyset";
import {
  presentBuyerPricing,
  quickAddEligibleSql,
  resolveProductCardImages,
  type StorefrontProductFilterInput,
} from "../products";
import type { ProductCondition } from "@scalius/shared/product-condition";
import type { Database } from "@scalius/database/client";
import { marketAmountMinor, marketDecimalPlaces, marketPriceContextOf, marketShopAmounts, priceProductCards, type MarketPricing } from "../price-lists";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import { publicCategoryConditions, publicCategorySubtreeCondition } from "../categories";
import { loadCatalogCardData } from "./card-facts";
import { cardFieldsOfTheme, cardFieldsThemeSql } from "./card-fields";
import {
    translationScopeOf,
    NAME_FIELDS,
    PRODUCT_CARD_FIELDS,
    translateRows,
    translationColumns,
} from "../translations";
import {
    buildCatalogFacetCountQuery,
    readCatalogFacetsWithSummary,
    catalogFacetDrivingSet,
    catalogFacetFilterConditions,
    declareFacetReadWithoutProducts,
    groupCatalogFacets,
    groupCatalogRatingFacet,
    facetLiveScopeLimit,
    type CatalogFacetCountInput,
} from "./facets";
import {
    priceFilterBoundsMinor,
    buildStorefrontBuyerStateConditions,
    getPagination,
    normalizeMinRating,
    presentCardRating,
    reviewStatsJoin,
    productMinRatingCondition,
    reviewStats,
    STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
    publishedCategoryIdSet,
} from "./shared";
import {
    buyerState,
    buyerStateCardSku,
    buyerStateCardSkuJoin,
    buyerStatePricingSelection,
    publicBuyerStateCondition,
} from "./buyer-state";
import {
    brandScopes,
    categoryScope,
    categoryScopes,
    declareListing,
    declareProductCards,
    deps,
    type ListingDependencySet,
} from "./declare-deps";

type StorefrontProductSort = NonNullable<StorefrontProductFilterInput["sort"]>;

type StorefrontProductListRow = {
    id: string;
    name: string;
    productCondition: ProductCondition | null;
    basePriceMinor: number;
    slug: string;
    discountType: string | null;
    discountBps: number;
    discountAmountMinor: number;
    effectivePriceMinor: number;
    maxBuyerPriceMinor: number;
    freeDelivery: boolean;
    categoryId: string | null;
    createdAt: number;
    ratingAvgCenti: number | null;
    reviewCount: number | null;
    /** The sort column as stored (`product_buyer_state`), for the page's cursor. */
    keysetValue: number | null;
};

type StorefrontProductListRowWithVariants = StorefrontProductListRow & {
    hasCustomerOptions: number | boolean;
    availableForSale: number | boolean;
    quickAddEligible: number | boolean;
};

export interface StorefrontCategoryProductCategory {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    imageUrl: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
    canonicalPath: string | null;
    noIndex: boolean;
    excludeFromSitemap: boolean;
    createdAt: string | null;
}

/**
 * The listing order over the buyer state. Newest, price and discount orders
 * are the buyer state's own indexed columns; ties break by product id.
 *
 * `sortAfterScope`: the scope is a set of categories, read through the
 * category index and then sorted. SQLite has no statistics on D1, so a
 * sortable index (newest, price) would otherwise win and walk every public
 * row filtering by the set; the unary `+` keeps the order from choosing it,
 * which bounds the read by the scope's own size.
 *
 * `rating` reads the review stats projection the page left-joins by primary
 * key (`rating_rank_milli`, Bayesian, so one 5★ never outranks many 4.8★):
 * no buyer-state index gives that order, so the scope's own index drives
 * and the page is sorted after it; unreviewed products come last, newest
 * first.
 */
function getStorefrontProductOrderBy(sort: StorefrontProductSort = "newest", sortAfterScope = false): SQL {
    const column = (value: SQLWrapper) => sortAfterScope ? sql`+${value}` : sql`${value}`;
    if (sort === "price-asc") return column(buyerState.fromMinor);
    if (sort === "price-desc") return sql`${column(buyerState.fromMinor)} DESC`;
    if (sort === "name-asc") return sql`${products.name}`;
    if (sort === "name-desc") return desc(products.name);
    if (sort === "discount") return sql`${column(buyerState.discountDepthBps)} DESC`;
    if (sort === "rating") {
        return sql`${reviewStats.ratingRankMilli} DESC NULLS LAST, COALESCE(${reviewStats.reviewCount}, 0) DESC, ${column(buyerState.productCreatedAt)} DESC`;
    }
    return sql`${column(buyerState.productCreatedAt)} DESC`;
}

/**
 * The orders a listing can continue from with a `cursor`: the buyer state's own
 * indexed columns, ties broken by product id ascending (the page's ORDER BY).
 * Name, discount, rating and search relevance order by joined or computed
 * values and page by number only.
 */
const LISTING_KEYSET_SORTS = {
    newest: { column: buyerState.productCreatedAt, direction: "desc" },
    "price-asc": { column: buyerState.fromMinor, direction: "asc" },
    "price-desc": { column: buyerState.fromMinor, direction: "desc" },
} as const satisfies Record<string, { column: SQLWrapper; direction: "asc" | "desc" }>;

// ─────────────────────────────────────────
// Storefront queries
// ─────────────────────────────────────────

type StorefrontCatalogScope = {
    /** A condition on the buyer state (or on `products` with `needsProducts`). */
    condition?: SQL;
    /** The scope condition reads `products` columns. */
    needsProducts?: boolean;
    /** The scope is a small id set that should drive the read by primary key. */
    drivenByIdSet?: boolean;
    /** The scope is a category set read through the category index, then sorted. */
    sortAfterScope?: boolean;
    /**
     * A category subtree's published category ids: the newest and price
     * orders page from each category's own index (`subtreePageIds`).
     */
    subtree?: { categoryIds: SQL };
    orderBy?: SQL;
    fixedCategory?: StorefrontCategoryProductCategory;
    /** The brand's own page: no brand facet. */
    withoutBrandFacet?: boolean;
    /** The cache keys of the scope's set; the whole public catalogue when left out. */
    dependencies?: ListingDependencySet;
    /**
     * The category-tree facet: a category's children with subtree counts;
     * by default the categories the listed products sit in.
     */
    categoryFacet?: CatalogFacetCountInput["categoryFacet"] | null;
    /** Published category landing shelves sample children beyond the normal first page. */
    shelfChildIds?: readonly string[];
    /**
     * The maintained per-scope counts of a category subtree or brand: a plain
     * page (nothing narrows it) reads its facets, total and price range
     * there, at any size.
     */
    precomputed?: CatalogFacetCountInput["precomputed"];
};

/**
 * Reads one catalog page. A search that matches nothing is retried once with
 * the closest catalog words ("kettel" → "kettle", "ব্যাগ" → "bag"); the
 * response then carries `correctedQuery` so the storefront can say so.
 */
async function readStorefrontCatalogPage(
    db: Database,
    params: StorefrontProductFilterInput,
    scope: StorefrontCatalogScope = {},
    pricing: MarketPricing | null = null,
) {
    const result = await readStorefrontCatalogResults(db, params, scope, pricing);
    if (!params.search || result.pagination.total > 0) return { ...result, correctedQuery: null };
    const correctedQuery = await suggestSearchCorrection(db, params.search);
    if (!correctedQuery) return { ...result, correctedQuery: null };
    const corrected = await readStorefrontCatalogResults(db, { ...params, search: correctedQuery }, scope, pricing);
    return corrected.pagination.total > 0
        ? { ...corrected, correctedQuery }
        : { ...result, correctedQuery: null };
}

/**
 * The page ids of a category subtree in the newest or price order: each of
 * its published categories gives its own first `perCategory` rows through
 * its own index (category, newest or category, price: a correlated subquery
 * per category, so no walk crosses categories), and the page is cut from
 * their union. A page reads at most the smaller of the subtree's rows and
 * its categories times `perCategory` index rows, whatever the subtree's size
 * and however its products spread over the newest and price orders.
 * `conditions` read the unaliased buyer state (the per-category rows).
 *
 * Each category's ids travel as one JSON list expanded by `json_each`, a
 * table function of the category row on both engines. PostgreSQL cannot turn
 * a correlated `IN (… LIMIT n)` into a join: it walked every buyer-state row
 * of the store and ran the subquery once per category and row. Exported for
 * the PostgreSQL plan guard.
 */
export function subtreePageIds(input: {
    categoryIds: SQL;
    conditions: SQL[];
    cursor: SQL | undefined;
    sort: keyof typeof LISTING_KEYSET_SORTS;
    perCategory: number;
    limit: number;
    offset: number;
    needsProducts: boolean;
}): SQL {
    const order = (row: string) => {
        if (input.sort === "price-asc") return sql.raw(`${row}.from_minor, ${row}.product_id`);
        if (input.sort === "price-desc") return sql.raw(`${row}.from_minor DESC, ${row}.product_id`);
        return sql.raw(`${row}.product_created_at DESC, ${row}.product_id`);
    };
    return sql`
            SELECT page_row.product_id AS page_product_id
            FROM (
                SELECT (
                    SELECT json_group_array(category_top.product_id) FROM (
                        SELECT ${buyerState.productId} AS product_id FROM ${buyerState}
                        ${input.needsProducts ? sql`INNER JOIN ${products} ON ${products.id} = ${buyerState.productId}` : sql``}
                        WHERE ${buyerState.categoryId} = subtree_category.id
                          AND ${and(...input.conditions, input.cursor)}
                        ORDER BY ${order(`"product_buyer_state"`)}
                        LIMIT ${sql.raw(String(Math.max(1, Math.trunc(input.perCategory))))}
                    ) AS category_top
                ) AS top_ids
                FROM categories AS subtree_category
                WHERE subtree_category.id IN ${input.categoryIds}
            ) AS subtree_top
            CROSS JOIN json_each(subtree_top.top_ids) AS top_id
            INNER JOIN ${buyerState} AS page_row ON page_row.product_id = top_id.value
            ORDER BY ${order("page_row")}
            LIMIT ${sql.raw(String(input.limit))} OFFSET ${sql.raw(String(input.offset))}`;
}

/**
 * Shop-all narrowed by a facet value. Each read (the page, the count, the
 * lowest and the highest price) takes the cheaper of two forms, chosen in
 * SQL from the maintained counts (the value's S public products, and T, the
 * public products with a category):
 *
 * - driven: the value's products, each probed by primary key, then sorted
 *   (about 6 S rows: value rows, buyer state, the other conditions' probes);
 * - walking: the order's index (any public row for the count) until enough
 *   rows match, `needed` of them (about 4 needed T / S rows).
 *
 * Driven while 3 S² <= 2 needed T (the price range: while S <= 1,000, else
 * the public range bounds it). The form not chosen gets LIMIT 0 from the
 * one-row plan (a limit is evaluated before the loop; a WHERE term would be
 * tested on every row walked). The value's public count is the exact total
 * when it is the only selection (`sole`, nothing else narrows the page);
 * any other count is capped like every list total.
 */
type NarrowedSummary = {
    count: number;
    min: number | null;
    max: number | null;
    storeCurrencyCode: string | null;
    cardFieldsTheme: string | null;
    publicCatalogueSize: number;
};

/** The one summary row of a narrowed page (D1 and Turso return objects, the PostgreSQL proxy value arrays). */
async function readNarrowedSummary(db: Database, query: SQL): Promise<NarrowedSummary | undefined> {
    const columns = ["count", "min", "max", "storeCurrencyCode", "cardFieldsTheme", "publicCatalogueSize"] as const;
    const [row] = await db.all<NarrowedSummary | unknown[]>(query);
    if (!row) return undefined;
    return Array.isArray(row)
        ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) as NarrowedSummary
        : row;
}

/** A narrowed shop-all page reads its own price range up to this many products of its value. */
const NARROWED_RANGE_DRIVEN_PRODUCTS = 1_000;

function narrowedShopAllPlan(input: {
    driving: { productIds: SQL; publicCount: SQL<number>; sole: boolean };
    conditions: SQL[];
    drivenConditions: SQL[];
    needsProducts: boolean;
    countLimit: number;
    pageRowsNeeded: number;
}) {
    const plan = sql`listing_plan AS MATERIALIZED (
        SELECT value_size.products AS value_products, (
            SELECT COALESCE(SUM(plan_count.product_count), 0) FROM product_facet_scope_counts AS plan_count
            WHERE plan_count.scope_kind = 'category' AND plan_count.facet_kind = 'products'
        ) AS public_products
        FROM (SELECT ${input.driving.publicCount} AS products) AS value_size
    )`;
    const driven = (needed: number) => sql`(3 * value_products * value_products <= 2 * ${sql.raw(String(Math.max(1, needed)))} * public_products)`;
    const rowsFor = (form: "driven" | "walking", needed: number, rows: SQL) =>
        // A boolean is a CASE condition on every provider (PostgreSQL compares no boolean with 1).
        form === "driven"
            ? sql`(SELECT CASE WHEN ${driven(needed)} THEN ${rows} ELSE 0 END FROM listing_plan)`
            : sql`(SELECT CASE WHEN ${driven(needed)} THEN 0 ELSE ${rows} END FROM listing_plan)`;
    const from = input.needsProducts
        ? sql`${buyerState} INNER JOIN ${products} ON ${products.id} = ${buyerState.productId}`
        : sql`${buyerState}`;
    const where = (form: "driven" | "walking") => and(...(form === "driven" ? input.drivenConditions : input.conditions));
    // The price range: the value's own rows while they are few (driven);
    // past that the public range (two index probes), as the slider's bounds.
    // A walk for the lowest price of a value would read every cheaper public
    // product first: prices and values go together (no 16 GB RAM under the
    // cheapest phone), so no uniform estimate bounds it.
    const fewProducts = sql`(SELECT value_products <= ${sql.raw(String(NARROWED_RANGE_DRIVEN_PRODUCTS))} FROM listing_plan)`;
    const first = (column: SQL, direction: "" | " DESC") => sql`COALESCE(
        (SELECT ${column} FROM ${from} WHERE ${where("driven")} ORDER BY +${column}${sql.raw(direction)}
            LIMIT (SELECT CASE WHEN ${fewProducts} THEN 1 ELSE 0 END)),
        (SELECT ${column} FROM ${buyerState} WHERE ${publicBuyerStateCondition()} ORDER BY ${column}${sql.raw(direction)}
            LIMIT (SELECT CASE WHEN ${fewProducts} THEN 0 ELSE 1 END)))`;
    const countLimit = sql.raw(String(input.countLimit));
    const count = input.driving.sole
        ? sql`(SELECT value_products FROM listing_plan)`
        : sql`(SELECT count(*) FROM (SELECT 1 FROM ${from} WHERE ${where("driven")} LIMIT ${rowsFor("driven", input.countLimit, countLimit)}) AS driven_rows)
            + (SELECT count(*) FROM (SELECT 1 FROM ${from} WHERE ${where("walking")} LIMIT ${rowsFor("walking", input.countLimit, countLimit)}) AS walked_rows)`;
    return {
        drivenConditions: input.drivenConditions,
        /** The count, the lowest and the highest price of the narrowed rows, plus `extra` columns. */
        summary: (extra: SQL) => sql`WITH ${plan}
            SELECT ${count} AS count,
                ${first(sql`${buyerState.fromMinor}`, "")} AS min,
                ${first(sql`${buyerState.toMinor}`, " DESC")} AS max
                ${extra}`,
        /** The page's ids, one form each (the other reads nothing). */
        page: (pageRows: number, ids: (form: "driven" | "walking", rows: SQL) => SQL) => {
            const rows = sql.raw(String(pageRows));
            return sql`WITH ${plan},
            listing_page AS MATERIALIZED (
                SELECT * FROM (${ids("driven", rowsFor("driven", input.pageRowsNeeded, rows))}) AS driven_page
                UNION ALL
                SELECT * FROM (${ids("walking", rowsFor("walking", input.pageRowsNeeded, rows))}) AS walking_page
            )
            SELECT * FROM listing_page`;
        },
    };
}

/** The category's subtree's published category ids (itself included), as a subquery: the subtree listing's own set. */
function publishedSubtreeCategoryIds(categoryId: string): SQL {
    return sql`(
        SELECT subtree.descendant_id FROM category_closure AS subtree
        INNER JOIN categories AS subtree_category ON subtree_category.id = subtree.descendant_id
            AND subtree_category.status = 'published' AND subtree_category.deleted_at IS NULL
        WHERE subtree.ancestor_id = ${categoryId}
    )`;
}

/** The category's closure ancestors (itself included), comma-joined; ids never contain commas. */
function categoryAncestorIdsSql(categoryId: string): SQL<string | null> {
    return sql<string | null>`(SELECT group_concat("category_closure"."ancestor_id", ',') FROM "category_closure" WHERE "category_closure"."descendant_id" = ${categoryId})`;
}

/** At most `limit + 1` public products: enough to tell "more than limit" apart. */
function boundedPublicCatalogueSizeSql(limit: number): SQL<number> {
    return sql<number>`(
        SELECT count(*) FROM (
            SELECT 1 FROM ${buyerState} WHERE ${publicBuyerStateCondition()} LIMIT ${sql.raw(String(limit + 1))}
        ) AS public_catalogue_probe
    )`;
}

async function readStorefrontCatalogResults(
    db: Database,
    params: StorefrontProductFilterInput,
    scope: StorefrontCatalogScope,
    pricing: MarketPricing | null,
) {
    const {
        page = 1,
        limit = 20,
        search,
        sort = search ? "relevance" : "newest",
        cursor,
    } = params;
    const lists = planLimits().lists;
    // A price filter in a market prices its bounds in the market first (FX),
    // and a price order there needs the market's lists before its page.
    const priceSort = sort === "price-asc" || sort === "price-desc";
    const boundsMarket = pricing && (params.minPrice !== undefined || params.maxPrice !== undefined || priceSort)
        ? await pricing.context
        : null;
    const priceBounds = priceFilterBoundsMinor(params, boundsMarket);
    // A live list can price a product anywhere: the price order is the
    // market's own (`marketPriceOrder`), by page number.
    const listedPriceOrder = Boolean(boundsMarket?.listed && priceSort && !scope.orderBy);
    if (listedPriceOrder && cursor) {
        throw invalidCursor("In a market priced by its lists, a price order pages by number, not by a cursor.");
    }
    const unscoped = !scope.condition && !params.category && !params.search && !params.ids;
    // Facet counts apply every selection except their own facet's, so they
    // read the scope conditions before the facet filters are applied.
    const setOptions = { drivenByIdSet: scope.drivenByIdSet };
    const unfiltered = buildStorefrontBuyerStateConditions(db, { ...params, ...priceBounds }, setOptions);
    const priceRange = buildStorefrontBuyerStateConditions(db, params, setOptions);
    const facetBaseConditions = unfiltered.conditions;
    const priceRangeConditions = priceRange.conditions;
    if (scope.condition) {
        facetBaseConditions.push(scope.condition);
        priceRangeConditions.push(scope.condition);
    }
    // Selected facet values, ranges, option axes and brands: probes of the
    // stored facet rows and buyer state, never a `products` read.
    const facetConditions = catalogFacetFilterConditions(params.attributeFilters);
    // "N★ & up": a primary-key probe of the review stats per scoped product.
    const minRating = normalizeMinRating(params.minRating);
    if (minRating !== undefined) facetConditions.push(productMinRatingCondition(buyerState.productId, minRating));
    const conditions = [...facetBaseConditions, ...facetConditions];
    priceRangeConditions.push(...facetConditions);
    // The count and price range join `products` only when a condition reads it.
    const countNeedsProducts = unfiltered.needsProducts || Boolean(scope.needsProducts);
    const priceRangeNeedsProducts = priceRange.needsProducts || Boolean(scope.needsProducts);
    const orderBy = scope.orderBy
        ? [scope.orderBy]
        : sort === "relevance" && search
            ? [...productSearchRelevanceOrder(db, search), desc(buyerState.productCreatedAt)]
            : [getStorefrontProductOrderBy(sort, scope.sortAfterScope)];
    // A `cursor` continues the keyset orders; any other order pages by number
    // (within the plan's offset bound).
    const keysetSort = !scope.orderBy && !(sort === "relevance" && search) && !listedPriceOrder
        ? LISTING_KEYSET_SORTS[sort as keyof typeof LISTING_KEYSET_SORTS]
        : undefined;
    const keysetOrder: KeysetOrder | undefined = keysetSort && {
        // A scope read through its own index and then sorted keeps the order off the sortable
        // index; the keyset predicate must not hand it back (the unary `+`, see above).
        column: scope.sortAfterScope ? sql`+${keysetSort.column}` : keysetSort.column,
        id: buyerState.productId,
        direction: keysetSort.direction,
        idDirection: "asc",
    };
    let cursorCondition: SQL | undefined;
    let plainCursorCondition: SQL | undefined;
    if (cursor) {
        if (!keysetSort || !keysetOrder) {
            throw invalidCursor("A cursor continues the newest, price-asc and price-desc orders of a listing; other orders (relevance, name, discount, rating) page by number.");
        }
        if (page > 1) throw invalidCursor("Use either page or a cursor, not both.");
        const boundary = readListCursor(cursor, { sort, direction: keysetSort.direction, kinds: ["number"] });
        cursorCondition = keysetCondition(keysetOrder, boundary);
        plainCursorCondition = keysetCondition({ ...keysetOrder, column: keysetSort.column }, boundary);
    }
    const offset = cursor ? 0 : (page - 1) * limit;
    // A numbered page this deep is empty: past the last countable page, so the
    // storefront answers 404 (never an indexable empty page) and nothing reads
    // `offset` rows to find that out. Deeper rows are reached with a cursor.
    const pageTooDeep = !cursor && offset >= lists.maxOffset;
    const shelfPreview = Boolean(
        scope.shelfChildIds?.length && page === 1 && !cursor && limit === 20 && sort === "newest"
        && !search && params.minPrice === undefined && params.maxPrice === undefined
        && params.minRating === undefined && !params.freeDelivery && !params.hasDiscount && !params.inStock
        && !params.attributeFilters?.length,
    );

    // The first page alone can be dominated by one child. Fold up to four
    // newest products from each of eight children into the page's existing
    // product statement; card media/facts then enrich the union in its usual
    // second wave. This adds no D1 round trip or batch part.
    const shelfIds = shelfPreview ? sql`
        SELECT preview.product_id FROM (
            SELECT ${buyerState.productId} AS product_id,
                child.name AS child_name,
                row_number() OVER (
                    PARTITION BY child.id
                    ORDER BY ${buyerState.productCreatedAt} DESC, ${buyerState.productId}
                ) AS shelf_rank
            FROM ${buyerState}
            INNER JOIN category_closure AS child_link ON child_link.descendant_id = ${buyerState.categoryId}
            INNER JOIN categories AS child ON child.id = child_link.ancestor_id
                AND child.id IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(scope.shelfChildIds)}))
                AND child.status = 'published' AND child.deleted_at IS NULL
            WHERE ${publicBuyerStateCondition()} AND ${scope.condition!}
        ) AS preview
        WHERE preview.shelf_rank <= 4
        ORDER BY preview.child_name, preview.product_id
        LIMIT 32
    ` : null;
    const pageIds = shelfPreview ? sql`
        SELECT ${buyerState.productId} FROM ${buyerState}
        WHERE ${and(...conditions)}
        ORDER BY ${buyerState.productCreatedAt} DESC, ${buyerState.productId}
        LIMIT ${limit}
    ` : null;

    const rankJoin = !scope.orderBy && sort === "relevance" && search
        ? productSearchRank(db, search)
        : undefined;
    // Rank the matching IDs before reading card-only SKU, rating and translation
    // fields, which are then read for the page's rows alone.
    const relevancePageIds = !scope.orderBy && sort === "relevance" && search ? sql`
            SELECT ${buyerState.productId} AS page_product_id,
                ${orderBy[0]!} AS relevance_tier,
                ${rankJoin ? rankJoin.score : sql`0`} AS relevance_score
            FROM ${buyerState}
            INNER JOIN ${products} ON ${products.id} = ${buyerState.productId}
            ${rankJoin?.join ? sql`LEFT JOIN ${rankJoin.join.table} ON ${rankJoin.join.on}` : sql``}
            WHERE ${and(...conditions)}
            ORDER BY relevance_tier, relevance_score, ${products.name},
                ${buyerState.productCreatedAt} DESC, ${buyerState.productId}
            LIMIT ${limit + 1} OFFSET ${offset}
    ` : null;
    const relevancePage = relevancePageIds ? sql`(
        WITH listing_page AS MATERIALIZED (${relevancePageIds})
        SELECT * FROM listing_page
    ) AS listing_page` : null;
    const plainShopAll = unscoped && conditions.length === 1 && !countNeedsProducts;
    // Shop-all narrowed by a facet value: driven from the value's products
    // while they are few, else the public walk (`narrowedShopAllPlan`).
    const driving = unscoped && !plainShopAll && !pageTooDeep ? catalogFacetDrivingSet(params.attributeFilters) : undefined;
    const narrowedPlan = driving ? narrowedShopAllPlan({
        // The value alone narrows the page (the public condition and its own).
        driving: { ...driving, sole: driving.sole && conditions.length === 2 && !countNeedsProducts },
        conditions,
        drivenConditions: [publicBuyerStateCondition({ drivenByIdSet: true }), ...conditions.slice(1),
            sql`${buyerState.productId} IN ${driving.productIds}`],
        needsProducts: countNeedsProducts,
        countLimit: cappedCountLimit(lists.countCap),
        pageRowsNeeded: offset + limit + 1,
    }) : null;
    // The standard orders pick the page's ids from the buyer state first (with
    // `products` or the review stats only when the order or a condition reads
    // them), so a scope read in full before its sort reads index rows, not
    // card rows. A category subtree pages newest or by price from each of its
    // categories' own index (`subtreePageIds`).
    const standardPage = !relevancePage && !shelfPreview && !scope.orderBy && !pageTooDeep;
    const idsNeedProducts = countNeedsProducts || sort === "name-asc" || sort === "name-desc";
    const pageIdsFor = (order: SQL, where: Array<SQL | undefined>, scopeConditions: SQL[] = conditions, rows: SQL = sql`${limit + 1}`) => sql`
            SELECT ${buyerState.productId} AS page_product_id
            FROM ${buyerState}
            ${idsNeedProducts ? sql`INNER JOIN ${products} ON ${products.id} = ${buyerState.productId}` : sql``}
            ${sort === "rating" ? sql`LEFT JOIN ${reviewStats} ON ${reviewStatsJoin(buyerState.productId)}` : sql``}
            WHERE ${and(...scopeConditions, ...where)}
            ORDER BY ${order}, ${buyerState.productId}
            LIMIT ${rows} OFFSET ${offset}`;
    // A subtree in a keyset order: the page from each category's own index
    // (its first offset + limit + 1 rows), merged (`subtreePageIds`).
    const subtreeTop = standardPage && scope.subtree && keysetSort
        ? subtreePageIds({
            categoryIds: scope.subtree.categoryIds,
            conditions: conditions.filter((condition) => condition !== scope.condition),
            cursor: plainCursorCondition,
            sort: sort as keyof typeof LISTING_KEYSET_SORTS,
            perCategory: offset + limit + 1,
            limit: limit + 1,
            offset,
            needsProducts: idsNeedProducts,
        })
        : null;
    const standardPageIds = standardPage
        ? narrowedPlan
            ? narrowedPlan.page(limit + 1, (form, rows) => pageIdsFor(
                form === "driven" ? getStorefrontProductOrderBy(sort, true) : orderBy[0]!,
                [form === "driven" ? cursorCondition : plainCursorCondition],
                form === "driven" ? narrowedPlan.drivenConditions : conditions,
                rows,
            ))
            : sql`WITH listing_page AS MATERIALIZED (${subtreeTop ?? pageIdsFor(orderBy[0]!, [cursorCondition])}) SELECT * FROM listing_page`
        : null;
    // The market's price order: the page's ids in order, as a JSON list.
    const marketOrder = listedPriceOrder && !pageTooDeep
        ? await marketPriceOrder(db, boundsMarket!, {
            conditions,
            needsProducts: countNeedsProducts,
            key: "from",
            direction: sort === "price-asc" ? "asc" : "desc",
            needed: offset + limit + 1,
        })
        : null;
    const marketPage = marketOrder ? sql`(
        SELECT CAST(market_page.value AS TEXT) AS page_product_id, CAST(market_page.key AS INTEGER) AS page_position
        FROM json_each(${JSON.stringify(marketOrder.slice(offset).map((row) => row.id))}) AS market_page
    ) AS listing_page` : null;
    const idPage = relevancePage ?? marketPage ?? (standardPageIds ? sql`(${standardPageIds}) AS listing_page` : null);
    const cardOrderBy = relevancePage
        ? [sql`listing_page.relevance_tier`, sql`listing_page.relevance_score`, sql`${products.name}`, desc(buyerState.productCreatedAt)]
        : marketPage ? [sql`listing_page.page_position`] : orderBy;
    const cardSku = buyerStateCardSku();
    // A presence page's cards in its language (MARKETS-DESIGN D9); none at the root.
    const translation = translationScopeOf(pricing);
    let cardQuery = db
        .select({
            id: products.id,
            name: products.name,
            productCondition: products.productCondition,
            ...translationColumns(translation, "product", products.id),
            ...buyerStatePricingSelection(cardSku),
            slug: products.slug,
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`.as("createdAt"),
            hasCustomerOptions: buyerState.hasCustomerOptions,
            availableForSale: buyerState.availableForSale,
            quickAddEligible: quickAddEligibleSql({
                availableForSale: buyerState.availableForSale,
                hasCustomerOptions: buyerState.hasCustomerOptions,
                effectivePriceMinor: buyerState.fromMinor,
            }).as("listing_quick_add_eligible"),
            ratingAvgCenti: reviewStats.ratingAvgCenti,
            reviewCount: reviewStats.reviewCount,
            // The sort column as stored: a cursor compares what the ORDER BY compared.
            keysetValue: keysetSort
                ? sql<number | null>`${keysetSort.column}`.as("keyset_value")
                : sql<number | null>`NULL`.as("keyset_value"),
        })
        .from(idPage ?? buyerState)
        .$dynamic();
    if (idPage) {
        cardQuery = cardQuery.innerJoin(buyerState, sql`${buyerState.productId} = listing_page.page_product_id`);
    }
    const query = cardQuery
        .innerJoin(products, eq(products.id, buyerState.productId))
        .leftJoin(cardSku, buyerStateCardSkuJoin(cardSku))
        // The card rating (and the `rating` order): the page's rows by primary key.
        .leftJoin(reviewStats, reviewStatsJoin(buyerState.productId))
        .where(idPage ? undefined : and(...conditions,
            shelfPreview ? sql`${buyerState.productId} IN (
                SELECT product_id FROM (${pageIds}) AS page_sample
                UNION ALL
                SELECT product_id FROM (${shelfIds}) AS shelf_sample
            )` : undefined,
            cursorCondition,
        ))
        .$dynamic();

    // Without a price filter the price range reads exactly the count's rows,
    // so one statement answers both.
    const hasPriceFilter = priceBounds.minPriceMinor !== undefined || priceBounds.maxPriceMinor !== undefined;
    const ancestorsCategoryId = scope.fixedCategory?.id && deps.active() ? scope.fixedCategory.id : null;
    // The plain shop-all page (no scope, no filter): the count stops at the
    // plan's cap and the price range reads one lone MIN and one lone MAX over
    // the public rows, each a single index probe once the buyer state has an
    // index on (is_public, to_minor) (the price index already serves the MIN).
    // Anywhere else the count, MIN and MAX share one scan of the scope's own
    // rows (bounded by the scope, and a lone MIN/MAX there would walk the
    // global price index looking for the scope's rows), and the count is capped
    // when it is reported.
    const publicRows = and(...conditions);
    const plainShopAllCountQuery = () => db
        .select({
            count: sql<number>`(SELECT count(*) FROM (SELECT 1 FROM ${buyerState} WHERE ${publicRows} LIMIT ${sql.raw(String(cappedCountLimit(lists.countCap)))}) AS capped_rows)`,
            storeCurrencyCode: storeCurrencyCodeSql(),
            cardFieldsTheme: cardFieldsThemeSql(),
            min: sql<number | null>`(SELECT MIN(${buyerState.fromMinor}) FROM ${buyerState} WHERE ${publicRows})`,
            max: sql<number | null>`(SELECT MAX(${buyerState.toMinor}) FROM ${buyerState} WHERE ${publicRows})`,
        })
        .from(sql`(SELECT 1) AS shop_all_probe`);
    let countQuery = db
        .select({
            count: sql<number>`count(*)`,
            storeCurrencyCode: storeCurrencyCodeSql(),
            cardFieldsTheme: cardFieldsThemeSql(),
            min: sql<number | null>`MIN(${buyerState.fromMinor})`,
            max: sql<number | null>`MAX(${buyerState.toMinor})`,
            publicCatalogueSize: boundedPublicCatalogueSizeSql(facetLiveScopeLimit()),
        })
        .from(buyerState)
        .$dynamic();
    if (countNeedsProducts) countQuery = countQuery.innerJoin(products, eq(products.id, buyerState.productId));
    countQuery = countQuery.where(and(...conditions));
    const narrowedCountQuery = () => narrowedPlan!.summary(sql`, ${storeCurrencyCodeSql()} AS storeCurrencyCode,
        ${cardFieldsThemeSql()} AS cardFieldsTheme,
        ${boundedPublicCatalogueSizeSql(facetLiveScopeLimit())} AS publicCatalogueSize`);

    let priceRangeQuery = db
        .select({
            min: sql<number | null>`MIN(${buyerState.fromMinor})`,
            max: sql<number | null>`MAX(${buyerState.toMinor})`,
        })
        .from(buyerState)
        .$dynamic();
    if (priceRangeNeedsProducts) {
        priceRangeQuery = priceRangeQuery.innerJoin(products, eq(products.id, buyerState.productId));
    }
    priceRangeQuery = priceRangeQuery.where(and(...priceRangeConditions));

    // Every facet (brand, option axes, attributes) in one statement.
    // Nothing narrows the scope: its counts are maintained (any size).
    const plainScope = !search && !params.ids && !params.category && !params.attributeFilters?.length
        && params.minPrice === undefined && params.maxPrice === undefined && minRating === undefined
        && !params.freeDelivery && !params.hasDiscount && params.inStock !== "true";
    const facetInput: CatalogFacetCountInput = {
        precomputed: plainScope ? scope.precomputed : undefined,
        fallbackCounts: plainScope ? undefined : scope.precomputed,
        baseConditions: facetBaseConditions,
        needsProducts: countNeedsProducts,
        allPublic: plainShopAll,
        filters: params.attributeFilters,
        categoryId: scope.fixedCategory?.id,
        categoryAncestorsDeclared: ancestorsCategoryId !== null,
        brandFacet: !scope.withoutBrandFacet,
        ratingFacet: true,
        minRating,
        categoryFacet: scope.categoryFacet === undefined ? "product-categories" : scope.categoryFacet ?? undefined,
    };
    const facetReads = () => buildCatalogFacetCountQuery(db, facetInput);
    // A scoped listing counts its facets in the first wave; the unscoped one
    // learns the catalogue size from its count first (see the limit above).
    const [fetchedList, separateCount, filteredPriceRange, scopedRead] = await Promise.all([
        // One row past the page tells whether another page follows.
        (pageTooDeep ? Promise.resolve([])
            : shelfPreview || idPage ? query.orderBy(...cardOrderBy, buyerState.productId).all()
                : query.orderBy(...cardOrderBy, buyerState.productId).limit(limit + 1).offset(offset).all()) as Promise<StorefrontProductListRowWithVariants[]>,
        !unscoped ? Promise.resolve(null) : plainShopAll ? plainShopAllCountQuery().get()
            : narrowedPlan ? readNarrowedSummary(db, narrowedCountQuery()) : countQuery.get(),
        hasPriceFilter ? priceRangeQuery.get() : Promise.resolve(null),
        unscoped ? Promise.resolve(null) : readCatalogFacetsWithSummary(db, facetInput, {
            categoryAncestors: ancestorsCategoryId ? categoryAncestorIdsSql(ancestorsCategoryId) : undefined,
            cardFieldsTheme: cardFieldsThemeSql(),
        }),
    ]);
    const totalCount = scopedRead?.summary ?? separateCount;
    const scopedFacets = scopedRead?.rows ?? [];
    const listedRows = shelfPreview ? fetchedList : fetchedList.slice(0, limit);
    // The page's market: its cards and price range in the market's prices.
    const market = await marketPriceContextOf(pricing);
    const decimalPlaces = marketDecimalPlaces(market, storeDecimalPlacesFromCode(totalCount?.storeCurrencyCode));
    const { total, totalIsCapped } = capTotal(totalCount?.count ?? 0, lists.countCap);
    // In a market priced by its lists the range is the market's own: its
    // lowest card price and its highest price, from the same two streams.
    const listedRange = market?.listed && !pageTooDeep
        ? await Promise.all([
            marketPriceOrder(db, market, { conditions: priceRangeConditions, needsProducts: priceRangeNeedsProducts, key: "from", direction: "asc", needed: 1 }),
            marketPriceOrder(db, market, { conditions: priceRangeConditions, needsProducts: priceRangeNeedsProducts, key: "to", direction: "desc", needed: 1 }),
        ])
        : null;
    const rawPriceRange = hasPriceFilter ? filteredPriceRange : totalCount;
    // Shop-all with a selection counts live only while the catalogue is small.
    const shopAllFacetsLive = unscoped && (plainShopAll || Number(
        (separateCount as { publicCatalogueSize?: number } | null)?.publicCatalogueSize ?? 0,
    ) <= facetLiveScopeLimit());

    // A fixed category names every row in it; a subtree listing still reads
    // the sub-categories its other rows sit in (none on a flat store).
    const categoryIds = [...new Set(
        listedRows
            .map((product) => product.categoryId)
            .filter((id): id is string => Boolean(id) && id !== scope.fixedCategory?.id),
    )];
    // A subtree listing also names, for each row's category, the listing
    // category's child whose subtree holds it (shelves group by it).
    const subtreeParentId = scope.categoryFacet && typeof scope.categoryFacet === "object"
        ? scope.categoryFacet.parentId
        : null;
    type ListedCategory = { id: string; name: string; slug: string; subcategoryId: string | null };
    const productIds = listedRows.map((product) => product.id);
    // Card media and card facts share one batch (card-facts.ts); a market's
    // list prices (only when one is live) ride beside them.
    const [productsList, cardData, categoriesData, facetRows] = await Promise.all([
        priceProductCards(db, market, listedRows),
        loadCatalogCardData(db, listedRows, decimalPlaces, marketShopAmounts(market), cardFieldsOfTheme(totalCount?.cardFieldsTheme)),
        categoryIds.length > 0
            ? db
                .select({
                    id: categories.id,
                    name: categories.name,
                    slug: categories.slug,
                    ...translationColumns(translation, "category", categories.id),
                    subcategoryId: subtreeParentId
                        ? sql<string | null>`(
                            SELECT child_link.ancestor_id FROM category_closure AS child_link
                            INNER JOIN category_closure AS listing_child
                                ON listing_child.descendant_id = child_link.ancestor_id
                               AND listing_child.ancestor_id = ${subtreeParentId}
                               AND listing_child.depth = 1
                            WHERE child_link.descendant_id = ${categories.id}
                            LIMIT 1
                        )`
                        : sql<string | null>`NULL`,
                })
                .from(categories)
                .where(and(
                    // One JSON parameter: a 100-card page can name 100 categories,
                    // and 100 ids plus the status bind exceed D1's 100 limit.
                    sql`${categories.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIds)}))`,
                    ...publicCategoryConditions(),
                ))
                .all() as Promise<ListedCategory[]>
            : Promise.resolve([] as ListedCategory[]),
        shopAllFacetsLive ? facetReads() : Promise.resolve(scopedFacets),
    ]);
    // A live list's prices order, bound and range a market's listing: any list price can move them.
    if (market?.listed) deps.table("price_list_prices");
    declareListing(scope.dependencies ?? { scopes: ["all"] }, params, {
        facets: !unscoped || shopAllFacetsLive,
    });
    declareProductCards(productIds, cardData.media);
    if (productIds.length === 0) {
        // An empty page shows no product, yet its statements name the card
        // SKU (and the facet axis lookup): only coarse keys cover those reads.
        const facetsRead = !unscoped || shopAllFacetsLive;
        if (facetsRead) declareFacetReadWithoutProducts(facetRows);
        if (!facetRows.some((row) => row.facetKind === "option")) deps.table("product_variants");
    }
    // The category of each card (published state, name, slug).
    deps.categories(categoryIds);
    if (ancestorsCategoryId) {
        const ancestors = (totalCount as { categoryAncestors?: string | null } | undefined)?.categoryAncestors;
        deps.categories(ancestors ? ancestors.split(",") : []);
    }
    deps.category(scope.fixedCategory?.id);
    const listedCategories = translateRows(translation, "category", categoriesData, NAME_FIELDS);
    const categoryMap = new Map(listedCategories.map(({ subcategoryId: _subcategoryId, ...category }) => [category.id, category]));
    const subcategoryIds = new Map(listedCategories.map((category) => [category.id, category.subcategoryId]));
    const productsWithImages = translateRows(translation, "product", productsList, PRODUCT_CARD_FIELDS).map(({
        hasCustomerOptions,
        availableForSale,
        quickAddEligible,
        ratingAvgCenti,
        reviewCount,
        keysetValue: _keysetValue,
        ...product
    }) => {
        // A card names its category (id, name, slug), never the page's whole
        // category record.
        const category = scope.fixedCategory && product.categoryId === scope.fixedCategory.id
            ? { id: scope.fixedCategory.id, name: scope.fixedCategory.name, slug: scope.fixedCategory.slug }
            : product.categoryId ? categoryMap.get(product.categoryId) ?? null : null;
        return {
            ...presentBuyerPricing(product, decimalPlaces),
            categoryId: category?.id ?? null,
            hasVariants: Boolean(hasCustomerOptions),
            availableForSale: Boolean(availableForSale),
            quickAddEligible: Boolean(quickAddEligible),
            ...resolveProductCardImages(cardData.media.get(product.id) ?? []),
            rating: presentCardRating(ratingAvgCenti, reviewCount),
            cardFacts: cardData.facts(product.id),
            fields: cardData.fields.get(product.id) ?? {},
            category,
            ...(subtreeParentId
                ? { subcategoryId: product.categoryId ? subcategoryIds.get(product.categoryId) ?? null : null }
                : {}),
            createdAt: unixToDate(product.createdAt)?.toISOString() ?? null,
        };
    });

    return {
        products: shelfPreview ? productsWithImages.slice(0, limit) : productsWithImages,
        shelfProducts: shelfPreview ? productsWithImages : [],
        pagination: { ...getPagination(cursor ? 0 : page, limit, total), totalIsCapped },
        // The cursor of the last card, for the orders a cursor continues; a
        // shelf preview's page is the first `limit` of its ordered rows.
        pageInfo: {
            hasNextPage: !pageTooDeep && (shelfPreview
                ? totalIsCapped || total > limit
                : fetchedList.length > limit),
            endCursor: keysetSort && productsList.length > 0
                ? encodeListCursor({
                    sort,
                    direction: keysetSort.direction,
                    values: [productsList[Math.min(limit, productsList.length) - 1]!.keysetValue],
                    id: productsList[Math.min(limit, productsList.length) - 1]!.id,
                })
                : null,
        },
        priceRange: listedRange ? {
            min: fromMinor(listedRange[0][0]?.price ?? 0, decimalPlaces),
            max: fromMinor(listedRange[1][0]?.price ?? 0, decimalPlaces),
        } : {
            min: fromMinor(marketAmountMinor(market, rawPriceRange?.min ?? 0), decimalPlaces),
            max: fromMinor(marketAmountMinor(market, rawPriceRange?.max ?? 0), decimalPlaces),
        },
        facets: groupCatalogFacets(facetRows, params.attributeFilters),
        ratingFacet: groupCatalogRatingFacet(facetRows, minRating),
    };
}

/**
 * Returns a paginated list of active storefront products with images and categories.
 * This is the unified query backing the Hono GET /api/storefront/products route.
 */
export async function getStorefrontProducts(db: Database, params: StorefrontProductFilterInput, pricing: MarketPricing | null = null) {
    return readStorefrontCatalogPage(db, params, {}, pricing);
}

/**
 * Returns category-scoped storefront products using the shared public product
 * filtering/sort core, without the extra variant/category enrichment needed by
 * the global product list endpoint.
 */
export async function getStorefrontCategoryProducts(
    db: Database,
    category: StorefrontCategoryProductCategory,
    params: StorefrontProductFilterInput,
    options: StorefrontCategoryListingOptions = {},
) {
    // `lm:cat:<id>` covers the category and every descendant; a subtree also
    // depends on which descendants are published.
    if (options.includeDescendants) deps.anyCategory();
    return readStorefrontCatalogPage(db, params, {
        dependencies: { scopes: [categoryScope(category.id)] },
        // The buyer state's category index: (is_public, category_id, newest).
        condition: options.includeDescendants
            ? publicCategorySubtreeCondition(buyerState.categoryId, category.id)
            : eq(buyerState.categoryId, category.id),
        subtree: options.includeDescendants ? { categoryIds: publishedSubtreeCategoryIds(category.id) } : undefined,
        sortAfterScope: options.includeDescendants === true,
        fixedCategory: category,
        // Its sub-categories with their subtree counts; a leaf has none.
        categoryFacet: options.includeDescendants ? { parentId: category.id } : null,
        shelfChildIds: options.shelfPreview && options.includeDescendants ? options.shelfChildIds : undefined,
        precomputed: {
            kind: "category",
            categoryIds: options.includeDescendants ? publishedSubtreeCategoryIds(category.id) : sql`(SELECT ${category.id})`,
        },
    }, options.pricing ?? null);
}

// ── Catalogue 1a: category subtrees and brand listings ────────────────────
// Kept as one block so the projection rewrite of the reads above can rebase
// onto it: both are scopes of readStorefrontCatalogPage and nothing else.

export interface StorefrontCategoryListingOptions {
    /**
     * List the category's published sub-categories too (closure read; a
     * draft or internal descendant's products stay out of the parent).
     */
    includeDescendants?: boolean;
    /** Include bounded child-category previews for an unfiltered landing. */
    shelfPreview?: boolean;
    /** Only the children included in the public category detail. */
    shelfChildIds?: readonly string[];
    /** A market-keyed read's market pricing (null at the root). */
    pricing?: MarketPricing | null;
}

/** A brand page's products: the storefront catalogue scoped to one brand. */
export async function getStorefrontBrandProducts(
    db: Database,
    brand: { id: string },
    params: StorefrontProductFilterInput,
    pricing: MarketPricing | null = null,
) {
    deps.brand(brand.id);
    return readStorefrontCatalogPage(db, params, {
        dependencies: { scopes: brandScopes(brand.id) },
        // The buyer state's brand index: (is_public, brand_id, newest).
        condition: eq(buyerState.brandId, brand.id),
        withoutBrandFacet: true,
        precomputed: { kind: "brand", brandId: brand.id },
    }, pricing);
}

// ── End of the catalogue 1a block ─────────────────────────────────────────

interface StorefrontCollectionMembership {
    productIds?: string[];
    categoryIds?: string[];
}

/** A collection's members: its picked products and every product in its published categories. */
function storefrontCollectionMembership(membership: StorefrontCollectionMembership) {
    const productIds = Array.from(new Set(
        (membership.productIds ?? []).map((id) => id.trim()).filter(Boolean),
    )).slice(0, STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE);
    const categoryIds = Array.from(new Set(
        (membership.categoryIds ?? []).map((id) => id.trim()).filter(Boolean),
    )).slice(0, STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE);
    const membershipEntries = [
        ...productIds.map((id) => ({ kind: "product", id })),
        ...categoryIds.map((id) => ({ kind: "category", id })),
    ];
    const membershipJson = JSON.stringify(membershipEntries);
    // One member-id set probed by primary key, rather than a json_each probe
    // per product (11-17 s for a 90-product collection on a 30k-product
    // catalogue) or an OR of two sets (which SQLite answers by walking every
    // public row): the picked ids, plus the public products of the
    // collection's published categories through the category index. UNION
    // ALL: `IN` removes duplicates itself, and a UNION would favour an
    // id-ordered index that walks every public row.
    const branches: SQL[] = [];
    if (productIds.length > 0) {
        branches.push(sql`SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(productIds)})`);
    }
    if (categoryIds.length > 0) {
        branches.push(sql`SELECT collection_member.product_id
            FROM ${buyerState} AS collection_member
            WHERE collection_member.is_public = 1
              AND collection_member.category_id IN ${publishedCategoryIdSet(sql`${categories.id} IN (
                  SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIds)})
              )`)}`);
    }
    const condition = branches.length > 0
        ? sql`${buyerState.productId} IN (${sql.join(branches, sql` UNION ALL `)})`
        : sql`0 = 1`;
    return { productIds, categoryIds, membershipJson, condition };
}

/**
 * How many of a collection's products buyers see: the storefront catalog's
 * own count (public products with a buyer-resolvable SKU), for batching.
 */
export function storefrontCollectionVisibleCountQuery(db: Database, membership: StorefrontCollectionMembership) {
    const { condition } = storefrontCollectionMembership(membership);
    return db
        .select({ count: sql<number>`count(*)` })
        .from(buyerState)
        .where(and(publicBuyerStateCondition({ drivenByIdSet: true }), condition));
}

export async function getStorefrontCollectionProducts(
    db: Database,
    membership: StorefrontCollectionMembership,
    params: StorefrontProductFilterInput,
    pricing: MarketPricing | null = null,
) {
    const { productIds, categoryIds, membershipJson, condition } = storefrontCollectionMembership(membership);
    // A dynamic collection lists its categories' public products (each
    // category's published state included); a manual one its picked ids.
    deps.categories(categoryIds);
    return readStorefrontCatalogPage(db, params, {
        dependencies: { scopes: categoryScopes(categoryIds), members: productIds },
        condition,
        drivenByIdSet: true,
        orderBy: productIds.length > 0 && (!params.sort || params.sort === "newest")
            ? sql`COALESCE((
                SELECT CAST(key AS INTEGER)
                FROM json_each(${membershipJson}) AS curated_membership
                WHERE json_extract(curated_membership.value, '$.kind') = 'product'
                    AND json_extract(curated_membership.value, '$.id') = ${buyerState.productId}
            ), 2147483647), ${getStorefrontProductOrderBy(params.sort ?? "newest")}`
            : undefined,
    }, pricing);
}
