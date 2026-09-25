// Card facts: what a product card can say beyond its title, price and photo
// (Star Tech's spec bullets, Amazon's "Options: 5 sizes" and "bought in past
// month", Daraz's "129 sold", Target's brand line, Chaldal's pack size, a
// delivery line). Every fact comes from stored data and is left out when the
// data is missing: no zero states, no invented numbers. Ratings are not read
// here because the store has no reviews yet.
//
// One statement for a page of cards, bounded by the page's product ids. It
// never adds a round trip: listings batch it with their card media
// (`loadCatalogCardData`), and homepage and collection plans put it in the
// batch they already run (`selectProductCardFactRows` with the same id
// subquery as their media statement).
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import { fromMinor } from "@scalius/shared/money";
import {
    PRODUCT_MEDIA_QUERY_CHUNK,
    resolveProductMediaProjectionRows,
    selectProductMediaProjectionRows,
    type ProductMediaProjection,
    type ProductMediaProjectionRow,
} from "../products/media";

/** Key specs a card lists (Star Tech shows four). */
export const CARD_KEY_SPECS_MAX = 4;
/** Swatches a card shows per colour axis (Amazon shows three to five). */
export const CARD_SWATCHES_MAX = 5;
/** Units sold in 30 days below which a card says nothing about sales (owner decision, 2026-09-25). */
export const CARD_SOLD_MIN = 10;
/**
 * Attributes that carry a grocery pack size, most specific first (Chaldal
 * "500 gm"). Only a value the merchant saved under one of these slugs shows
 * (a laptop's "weight" is not a pack size).
 */
export const CARD_PACK_SIZE_SLUGS = ["pack-size", "net-weight", "net-volume", "net-quantity", "pack"] as const;

export type ProductCardOptionKind = "color" | "size" | "other";

export interface ProductCardOptionFact {
    /** The merchant's axis name ("Size", "Colour", "রং"). */
    name: string;
    kind: ProductCardOptionKind;
    /** Values sold on at least one live SKU. */
    count: number;
    /** Colour axes only: the first values, with the merchant's swatch colour when a swatch attribute names it. */
    swatches: Array<{ label: string; hex: string | null }>;
}

export interface ProductCardFacts {
    brand: { name: string; slug: string } | null;
    /** "Processor: Intel Core i5-1235U", at most CARD_KEY_SPECS_MAX, in spec-table order. */
    keySpecs: string[];
    /** Option axes in position order, only those with two or more values. */
    options: ProductCardOptionFact[];
    /** Units sold in the last 30 days (`product_sales_stats`), only from CARD_SOLD_MIN. */
    soldLast30Days: number | null;
    packSize: string | null;
    /**
     * The store's delivery line: free for this product, or the cheapest
     * active delivery rate (major units). Null when the store has no rate.
     */
    delivery: { free: true } | { free: false; feeFrom: number } | null;
}

export const EMPTY_PRODUCT_CARD_FACTS: ProductCardFacts = Object.freeze({
    brand: null,
    keySpecs: [],
    options: [],
    soldLast30Days: null,
    packSize: null,
    delivery: null,
}) as ProductCardFacts;

/**
 * One row per fact, `kind` says which. A `product` row carries the brand
 * (label, value = slug), units sold (amount), the pack size (extra) and the
 * store's cheapest delivery rate in minor units (fee); `spec`, `axis` and
 * `swatch` rows one each.
 */
export interface ProductCardFactRow {
    productId: string;
    kind: "product" | "spec" | "axis" | "swatch";
    label: string | null;
    value: string | null;
    amount: number | null;
    position: number | null;
    extra: string | null;
    fee: number | null;
}

/**
 * The product ids, written once as the `card_ids` CTE: a caller's id query
 * can be large (a home list's pricing projection), and inlining it in each
 * of the four terms can pass D1's statement length limit.
 */
function cardIdsCte(productIds: readonly string[] | SQLWrapper): SQL {
    if (Array.isArray(productIds)) {
        const ids = [...new Set(productIds.map((id) => id.trim()).filter(Boolean))];
        return sql`card_ids(id) AS (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
    }
    // An embedded query renders parenthesized, which a CTE body cannot be.
    return sql`card_ids(id) AS (SELECT * FROM ${productIds as SQLWrapper})`;
}

function idScope(column: string): SQL {
    return sql`${sql.raw(column)} IN (SELECT id FROM card_ids)`;
}

/** A colour axis by its standard mapping or its name. */
const COLOUR_AXIS = sql.raw(`(axis."standard_mapping" = 'color' OR axis."normalized_name" IN ('color', 'colour', 'colours', 'colors', 'রং'))`);
/** A size axis by its standard mapping or its name. */
const SIZE_AXIS = sql.raw(`(axis."standard_mapping" = 'size' OR axis."normalized_name" IN ('size', 'sizes', 'সাইজ'))`);
/** The option value is sold on a live SKU. */
const VALUE_ON_LIVE_SKU = sql.raw(`EXISTS (
    SELECT 1 FROM "product_variant_option_values" assignment
    INNER JOIN "product_variants" sku ON sku."id" = assignment."variant_id" AND sku."deleted_at" IS NULL
    WHERE assignment."option_value_id" = axis_value."id"
)`);

/**
 * The card facts of the products `productIds` names (a list, or the id
 * subquery of a card statement), one fact per row. Batchable. Column names
 * are qualified by hand: drizzle renders column references inside a raw
 * subquery unqualified.
 */
export function selectProductCardFactRows(db: Database, productIds: readonly string[] | SQLWrapper) {
    const packSlugs = CARD_PACK_SIZE_SLUGS.map((slug) => `'${slug}'`).join(", ");
    const packRank = CARD_PACK_SIZE_SLUGS.map((slug, index) => `WHEN '${slug}' THEN ${index}`).join(" ");
    // Four terms: D1 refuses a compound SELECT of more than five.
    const facts = sql`(
        WITH ${cardIdsCte(productIds)}
        SELECT CAST(card_product."id" AS TEXT) AS product_id, CAST('product' AS TEXT) AS kind,
            CAST(card_brand."name" AS TEXT) AS label, CAST(card_brand."slug" AS TEXT) AS value,
            CAST(sales."sold_30d" AS INTEGER) AS amount, CAST(NULL AS INTEGER) AS position,
            CAST((
                SELECT COALESCE(pack_enum."value", pack_value."value")
                FROM "product_attribute_values" pack_value
                INNER JOIN "product_attributes" pack ON pack."id" = pack_value."attribute_id"
                    AND pack."slug" IN (${sql.raw(packSlugs)}) AND pack."deleted_at" IS NULL
                LEFT JOIN "attribute_values" pack_enum ON pack_enum."id" = pack_value."value_id"
                WHERE pack_value."product_id" = card_product."id"
                ORDER BY CASE pack."slug" ${sql.raw(packRank)} ELSE 99 END
                LIMIT 1
            ) AS TEXT) AS extra,
            CAST((
                SELECT min(rate."fee_minor") FROM "shipping_methods" rate
                WHERE rate."is_active" = 1 AND rate."deleted_at" IS NULL AND rate."kind" = 'delivery'
            ) AS INTEGER) AS fee
        FROM "products" card_product
        LEFT JOIN "brands" card_brand ON card_brand."id" = card_product."brand_id"
            AND card_brand."status" = 'published' AND card_brand."deleted_at" IS NULL
        LEFT JOIN "product_sales_stats" sales ON sales."product_id" = card_product."id"
            AND sales."sold_30d" >= ${CARD_SOLD_MIN}
        WHERE ${idScope(`card_product."id"`)}
        UNION ALL
        SELECT ranked_spec.product_id, 'spec', ranked_spec.label, ranked_spec.value, NULL, ranked_spec.spec_rank, NULL, NULL
        FROM (
            SELECT spec_value."product_id" AS product_id, spec."name" AS label,
                COALESCE(spec_enum."value", spec_value."value") AS value,
                ROW_NUMBER() OVER (
                    PARTITION BY spec_value."product_id"
                    ORDER BY COALESCE(spec_group."sort_order", 1000000), spec."sort_order", spec."name", spec."id"
                ) AS spec_rank
            FROM "product_attribute_values" spec_value
            INNER JOIN "product_attributes" spec ON spec."id" = spec_value."attribute_id"
                AND spec."key_spec" = 1 AND spec."deleted_at" IS NULL
            LEFT JOIN "attribute_groups" spec_group ON spec_group."id" = spec."group_id" AND spec_group."deleted_at" IS NULL
            LEFT JOIN "attribute_values" spec_enum ON spec_enum."id" = spec_value."value_id"
            WHERE ${idScope(`spec_value."product_id"`)}
        ) AS ranked_spec
        WHERE ranked_spec.spec_rank <= ${CARD_KEY_SPECS_MAX}
        UNION ALL
        SELECT axis."product_id", 'axis', axis."name",
            CASE WHEN ${COLOUR_AXIS} THEN 'color' WHEN ${SIZE_AXIS} THEN 'size' ELSE 'other' END,
            (SELECT count(*) FROM "product_option_values" axis_value
                WHERE axis_value."option_definition_id" = axis."id" AND axis_value."deleted_at" IS NULL
                  AND ${VALUE_ON_LIVE_SKU}),
            axis."position", NULL, NULL
        FROM "product_option_definitions" axis
        WHERE ${idScope(`axis."product_id"`)} AND axis."deleted_at" IS NULL
        UNION ALL
        SELECT ranked_swatch.product_id, 'swatch', ranked_swatch.label, NULL, NULL, ranked_swatch.axis_position,
            (SELECT swatch_value."swatch_hex" FROM "product_attributes" swatch_attribute
                INNER JOIN "attribute_values" swatch_value ON swatch_value."attribute_id" = swatch_attribute."id"
                    AND swatch_value."normalized_value" = ranked_swatch.normalized_value
                    AND swatch_value."deleted_at" IS NULL AND swatch_value."swatch_hex" IS NOT NULL
                WHERE swatch_attribute."facet_display" = 'swatch' AND swatch_attribute."deleted_at" IS NULL
                ORDER BY swatch_attribute."sort_order", swatch_attribute."id"
                LIMIT 1), NULL
        FROM (
            SELECT axis."product_id" AS product_id, axis_value."value" AS label,
                axis_value."normalized_value" AS normalized_value, axis."position" AS axis_position,
                ROW_NUMBER() OVER (PARTITION BY axis."id" ORDER BY axis_value."position", axis_value."id") AS swatch_rank
            FROM "product_option_definitions" axis
            INNER JOIN "product_option_values" axis_value ON axis_value."option_definition_id" = axis."id"
                AND axis_value."deleted_at" IS NULL
            WHERE ${idScope(`axis."product_id"`)} AND axis."deleted_at" IS NULL
              AND ${COLOUR_AXIS} AND ${VALUE_ON_LIVE_SKU}
        ) AS ranked_swatch
        WHERE ranked_swatch.swatch_rank <= ${CARD_SWATCHES_MAX}
    ) AS card_fact`;
    return db
        .select({
            productId: sql<string>`card_fact.product_id`,
            kind: sql<ProductCardFactRow["kind"]>`card_fact.kind`,
            label: sql<string | null>`card_fact.label`,
            value: sql<string | null>`card_fact.value`,
            amount: sql<number | null>`card_fact.amount`,
            position: sql<number | null>`card_fact.position`,
            extra: sql<string | null>`card_fact.extra`,
            fee: sql<number | null>`card_fact.fee`,
        })
        .from(facts);
}

function clean(text: string | null | undefined): string {
    return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/**
 * Each product's card facts from the rows of `selectProductCardFactRows`; a
 * product without stored facts still gets the store's delivery line.
 * `freeDelivery` names the products whose own flag makes delivery free.
 */
export function resolveProductCardFacts(
    rows: readonly ProductCardFactRow[],
    decimalPlaces: number,
    freeDelivery: ReadonlySet<string> = new Set(),
): (productId: string) => ProductCardFacts {
    const byProduct = new Map<string, {
        brand: ProductCardFacts["brand"];
        specs: Array<{ rank: number; text: string }>;
        axes: Array<ProductCardOptionFact & { position: number }>;
        swatches: Array<{ position: number; label: string; hex: string | null }>;
        sold: number | null;
        packSize: string | null;
    }>();
    let deliveryFeeMinor: number | null = null;
    const entry = (productId: string) => {
        let facts = byProduct.get(productId);
        if (!facts) {
            facts = { brand: null, specs: [], axes: [], swatches: [], sold: null, packSize: null };
            byProduct.set(productId, facts);
        }
        return facts;
    };
    for (const row of rows) {
        if (!row.productId) continue;
        const facts = entry(row.productId);
        const label = clean(row.label);
        const value = clean(row.value);
        if (row.kind === "product") {
            if (label && value) facts.brand = { name: label, slug: value };
            const sold = Math.floor(Number(row.amount) || 0);
            if (sold >= CARD_SOLD_MIN) facts.sold = sold;
            const packSize = clean(row.extra);
            if (packSize) facts.packSize = packSize;
            const fee = Number(row.fee);
            if (row.fee !== null && Number.isFinite(fee) && fee >= 0) deliveryFeeMinor = fee;
        } else if (row.kind === "spec" && label && value) {
            facts.specs.push({ rank: Number(row.position) || 0, text: `${label}: ${value}` });
        } else if (row.kind === "axis" && label) {
            const count = Math.floor(Number(row.amount) || 0);
            const kind: ProductCardOptionKind = value === "color" || value === "size" ? value : "other";
            if (count >= 2) facts.axes.push({ name: label, kind, count, swatches: [], position: Number(row.position) || 0 });
        } else if (row.kind === "swatch" && label) {
            const hex = typeof row.extra === "string" && /^#[0-9a-f]{6}$/i.test(row.extra) ? row.extra.toLowerCase() : null;
            facts.swatches.push({ position: Number(row.position) || 0, label, hex });
        }
    }

    // A zero rate is some zone's, not every buyer's: only the product's own
    // flag says "free delivery".
    const delivery = (productId: string): ProductCardFacts["delivery"] => {
        if (freeDelivery.has(productId)) return { free: true };
        return deliveryFeeMinor === null || deliveryFeeMinor === 0
            ? null
            : { free: false, feeFrom: fromMinor(deliveryFeeMinor, decimalPlaces) };
    };
    return (productId: string): ProductCardFacts => {
        const facts = byProduct.get(productId);
        if (!facts) return { ...EMPTY_PRODUCT_CARD_FACTS, keySpecs: [], options: [], delivery: delivery(productId) };
        return {
            brand: facts.brand,
            keySpecs: [...facts.specs]
                .sort((left, right) => left.rank - right.rank)
                .slice(0, CARD_KEY_SPECS_MAX)
                .map((spec) => spec.text),
            options: [...facts.axes]
                .sort((left, right) => left.position - right.position)
                .map(({ position, ...axis }) => ({
                    ...axis,
                    swatches: axis.kind === "color"
                        ? facts.swatches
                            .filter((swatch) => swatch.position === position)
                            .slice(0, CARD_SWATCHES_MAX)
                            .map(({ label, hex }) => ({ label, hex }))
                        : [],
                })),
            soldLast30Days: facts.sold,
            packSize: facts.packSize,
            delivery: delivery(productId),
        };
    };
}

/**
 * A listing page's card media and card facts in one batch per chunk of 90
 * products (the media chunk): the same round trips the media read alone
 * took, so listings stay inside their D1 budget.
 */
export async function loadCatalogCardData(
    db: Database,
    products: ReadonlyArray<{ id: string; freeDelivery?: boolean | number | null }>,
    decimalPlaces: number,
): Promise<{ media: Map<string, ProductMediaProjection[]>; facts: (productId: string) => ProductCardFacts }> {
    const uniqueIds = [...new Set(products.map((product) => product.id.trim()).filter(Boolean))];
    const media = new Map<string, ProductMediaProjection[]>();
    const factRows: ProductCardFactRow[] = [];
    for (let index = 0; index < uniqueIds.length; index += PRODUCT_MEDIA_QUERY_CHUNK) {
        const chunk = uniqueIds.slice(index, index + PRODUCT_MEDIA_QUERY_CHUNK);
        const [mediaRows, chunkFacts] = await safeBatch(db, [
            selectProductMediaProjectionRows(db, chunk),
            selectProductCardFactRows(db, chunk),
        ] as const);
        for (const [productId, projections] of resolveProductMediaProjectionRows(mediaRows as ProductMediaProjectionRow[])) {
            media.set(productId, [...(media.get(productId) ?? []), ...projections]);
        }
        factRows.push(...(chunkFacts as ProductCardFactRow[]));
    }
    const freeDelivery = new Set(products.filter((product) => Boolean(product.freeDelivery)).map((product) => product.id));
    return { media, facts: resolveProductCardFacts(factRows, decimalPlaces, freeDelivery) };
}
