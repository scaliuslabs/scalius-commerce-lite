// Listing facets over the catalogue projections (migration 0090):
// `product_buyer_state` is the public set, `product_facet_values` holds one
// row per product attribute value (owner = the product) and per live SKU
// option value (owner = the SKU). Filters and counts are index probes on
// those rows, bounded by the listing's own scope; nothing here evaluates
// public eligibility, the SKU pricing window or raw attribute text per
// request. Readers join only live, filterable attribute definitions and
// published brands, so definition writes (filterable, display, unit, order,
// trash) take effect without touching the projection.
//
// URL contract (`resolvePublicAttributeFilters`): `?<attribute slug>=<value>`
// (repeatable: OR within a facet, AND across facets), `?<slug>.min=` /
// `?<slug>.max=` for number attributes, `?option.<axis>=<value>` for merchant
// option axes (matched on one SKU, so "Chalk + 42" needs a Chalk 42 SKU) and
// `?brand=<brand slug>` for the brand entity. Values are normalised: text and
// enum values lowercased and trimmed, numbers canonical ("15.6"), booleans
// "1"/"0".
import { brands, productAttributes, attributeValues } from "@scalius/database/schema";
import { and, sql, type SQL } from "drizzle-orm";
import {
    OPTION_FACET_KEY_PREFIX,
    canonicalAttributeNumber,
    normalizeAttributeValue,
    parseAttributeNumber,
    type AttributeFacetDisplay,
} from "@scalius/shared/catalog-attributes";
import { normalizeProductOptionIdentity } from "@scalius/shared/product-options";
import { ValidationError } from "@scalius/core/errors";
import type { Database } from "@scalius/database/client";
import type { CatalogFacetFilter } from "../products/types";
import { publicCategorySubtreeCondition } from "../categories/categories.tree";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";
import { buildStorefrontBuyerStateConditions, reviewStats } from "./shared";
import { reviewsEnabledSql } from "../settings/documents";
import { REVIEW_RATING_FACET_STARS } from "@scalius/shared/reviews";

/** URL/facet key prefix for merchant option axes, e.g. `option.size`. */
export const OPTION_FACET_PREFIX = OPTION_FACET_KEY_PREFIX;
/** The query key and facet id of the brand entity facet. */
export const BRAND_FACET_KEY = "brand";
/** The facet kind and id of the "N★ & up" rating rows (`minRating`). */
export const RATING_FACET_KEY = "rating";
/** Attribute facets per listing. */
export const FACET_ATTRIBUTE_LIMIT = 50;
/** Values per facet: the most common ones, plus every selected value. */
export const FACET_VALUE_LIMIT = 100;
/**
 * Values of the brand facet: a large category can hold hundreds of brands,
 * and "See more" with its search must reach every one of them.
 */
export const BRAND_FACET_VALUE_LIMIT = 500;
/** The query key and facet id of the category-tree facet (links, never a filter). */
export const CATEGORY_FACET_KEY = "category";
/** Filter values one request may carry. */
export const MAX_PUBLIC_FACET_FILTER_VALUES = 90;

const RANGE_QUERY_KEY = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.(min|max)$/;
const FACET_KEY_MAX_LENGTH = 200;
/** Stand-ins for an open range end; attribute numbers stay below 1e12. */
const OPEN_RANGE = 1e15;

/**
 * A facet's source. `category` is the category-tree facet: its values are
 * sub-listings with their counts (links to category pages), never a filter.
 */
export type PublicProductFacetKind = CatalogFacetFilter["kind"] | "category";

export interface PublicProductFacetValue {
    /** The URL value (`?<slug>=<value>`). */
    value: string;
    /** The buyer-facing text. */
    label: string;
    count: number;
    /** `#rrggbb` of an enum value, for swatch facets. */
    swatch: string | null;
}

export interface PublicProductFacet {
    id: string;
    name: string;
    slug: string;
    kind: PublicProductFacetKind;
    display: AttributeFacetDisplay;
    unit: string | null;
    values: PublicProductFacetValue[];
    /** `display: "range"` only: the value bounds over products matching the other selections. */
    range: { min: number; max: number } | null;
}

type PublicQueryValues = Record<string, string | string[]>;

function jsonTextSet(values: readonly string[]): SQL {
    return sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(values)}))`;
}

function parseBooleanFacetValue(value: string): "0" | "1" | null {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "হ্যাঁ"].includes(text)) return "1";
    if (["0", "false", "no", "না"].includes(text)) return "0";
    return null;
}

function boundedLimit(value: number | undefined, max: number): number {
    return Math.min(Math.max(Math.trunc(value ?? max), 1), max);
}

/**
 * Rows of a raw `db.all` read as objects. D1 and Turso return objects; the
 * PostgreSQL proxy returns value arrays in select-list order.
 */
async function namedRows<T extends Record<string, unknown>>(
    rows: Promise<unknown[]>,
    columns: ReadonlyArray<keyof T & string>,
): Promise<T[]> {
    return (await rows).map((row) => Array.isArray(row)
        ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) as T
        : row as T);
}

function uniqueStrings(values: Iterable<string>): string[] {
    return [...new Set(values)];
}

// ─── Resolving the request's filters ────────────────────────────────────

/**
 * Resolves raw public query parameters into facet filters. Route schemas own
 * their standard keys; any other key is an attribute slug (or its `.min` /
 * `.max` range bound), an `option.<axis>`, or `brand`. Unknown attribute
 * slugs, unknown enum values and unpublished brands are dropped, so junk
 * parameters narrow nothing. One statement, and none when only option axes
 * are requested.
 */
export async function resolvePublicAttributeFilters(
    db: Database,
    queryParams: PublicQueryValues,
    standardQueryKeys: Iterable<string>,
    options: { brand?: boolean } = {},
): Promise<CatalogFacetFilter[]> {
    const knownKeys = new Set(standardQueryKeys);
    const requested = Object.entries(queryParams)
        .filter(([key]) => !knownKeys.has(key))
        .map(([key, rawValues]) => ({
            key: key.trim(),
            values: uniqueStrings(
                (Array.isArray(rawValues) ? rawValues : [rawValues])
                    .map((value) => value.trim())
                    .filter(Boolean),
            ),
        }))
        .filter((entry) => entry.key && entry.values.length > 0);
    if (requested.length === 0) return [];
    const requestedValueCount = requested.reduce((total, entry) => total + entry.values.length, 0);
    if (requestedValueCount > MAX_PUBLIC_FACET_FILTER_VALUES) {
        throw new ValidationError(`At most ${MAX_PUBLIC_FACET_FILTER_VALUES} attribute filter values are allowed.`);
    }

    const optionFilters: CatalogFacetFilter[] = [];
    const requestedValues = new Map<string, string[]>();
    const rangeBounds = new Map<string, { min: number | null; max: number | null }>();
    let brandSlugs: string[] = [];
    for (const { key, values } of requested) {
        if (key.startsWith(OPTION_FACET_PREFIX)) {
            if (key.length <= OPTION_FACET_PREFIX.length || key.length > 120) continue;
            const keys = uniqueStrings(values
                .map((value) => normalizeProductOptionIdentity(value).slice(0, FACET_KEY_MAX_LENGTH))
                .filter(Boolean));
            if (keys.length > 0) {
                optionFilters.push({
                    kind: "option",
                    id: key,
                    name: key.slice(OPTION_FACET_PREFIX.length),
                    slug: key,
                    values: keys,
                    labels: keys.map((normalized) => values.find((value) => normalizeProductOptionIdentity(value) === normalized) ?? normalized),
                    keys,
                });
            }
            continue;
        }
        if (key === BRAND_FACET_KEY) {
            if (options.brand !== false) brandSlugs = uniqueStrings(values.map((value) => value.toLowerCase()));
            continue;
        }
        const range = RANGE_QUERY_KEY.exec(key);
        if (range) {
            const bound = parseAttributeNumber(values.at(-1)!);
            if (bound === null) continue;
            const current = rangeBounds.get(range[1]!) ?? { min: null, max: null };
            current[range[2] as "min" | "max"] = bound;
            rangeBounds.set(range[1]!, current);
            continue;
        }
        requestedValues.set(key, values);
    }

    const slugs = uniqueStrings([...requestedValues.keys(), ...rangeBounds.keys()]);
    if (slugs.length === 0 && brandSlugs.length === 0) return optionFilters;

    const enumCandidates = uniqueStrings([...requestedValues.values()].flat().map(normalizeAttributeValue));
    // The slug indexes drive every branch; `status || ''` (a unary + on text
    // does not compile on PostgreSQL) keeps the brand status index from
    // winning over the slug.
    type ResolvedRow = {
        kind: "attribute" | "enum" | "brand";
        id: string;
        name: string | null;
        slug: string;
        valueType: string | null;
        valueId: string | null;
        valueKey: string | null;
        valueLabel: string | null;
    };
    const rows = await namedRows<ResolvedRow>(db.all(sql`
        SELECT 'attribute' AS kind, ${productAttributes.id} AS id, ${productAttributes.name} AS name,
            ${productAttributes.slug} AS slug, ${productAttributes.valueType} AS valueType,
            NULL AS valueId, NULL AS valueKey, NULL AS valueLabel
        FROM ${productAttributes}
        WHERE ${productAttributes.slug} IN ${jsonTextSet(slugs)}
          AND ${productAttributes.filterable} = 1
          AND ${productAttributes.deletedAt} IS NULL
        UNION ALL
        SELECT 'enum', ${productAttributes.id}, NULL, ${productAttributes.slug}, NULL,
            ${attributeValues.id}, ${attributeValues.normalizedValue}, ${attributeValues.value}
        FROM ${productAttributes}
        INNER JOIN ${attributeValues}
            ON ${attributeValues.attributeId} = ${productAttributes.id}
           AND ${attributeValues.deletedAt} IS NULL
        WHERE ${productAttributes.slug} IN ${jsonTextSet(slugs)}
          AND ${productAttributes.valueType} = 'enum'
          AND ${productAttributes.filterable} = 1
          AND ${productAttributes.deletedAt} IS NULL
          AND ${attributeValues.normalizedValue} IN ${jsonTextSet(enumCandidates)}
        UNION ALL
        SELECT 'brand', ${brands.id}, ${brands.name}, ${brands.slug}, NULL, NULL, NULL, NULL
        FROM ${brands}
        WHERE ${brands.slug} IN ${jsonTextSet(brandSlugs)}
          AND ${brands.status} || '' = 'published'
          AND ${brands.deletedAt} IS NULL
    `), ["kind", "id", "name", "slug", "valueType", "valueId", "valueKey", "valueLabel"]);

    const enumIds = new Map<string, Map<string, { id: string; label: string }>>();
    for (const row of rows) {
        if (row.kind !== "enum" || !row.valueKey || !row.valueId) continue;
        const ids = enumIds.get(row.id) ?? new Map<string, { id: string; label: string }>();
        ids.set(row.valueKey, { id: row.valueId, label: row.valueLabel ?? row.valueKey });
        enumIds.set(row.id, ids);
    }

    const attributeFilters: CatalogFacetFilter[] = [];
    const brandRows = rows.filter((row) => row.kind === "brand");
    for (const row of rows) {
        if (row.kind !== "attribute") continue;
        const values: string[] = [];
        const labels: string[] = [];
        const keys: string[] = [];
        for (const raw of requestedValues.get(row.slug) ?? []) {
            let value: string | null = null;
            let key: string | null = null;
            let label = raw;
            if (row.valueType === "number") {
                const number = parseAttributeNumber(raw);
                if (number !== null) value = key = canonicalAttributeNumber(number);
            } else if (row.valueType === "boolean") {
                value = key = parseBooleanFacetValue(raw);
            } else if (row.valueType === "enum") {
                value = normalizeAttributeValue(raw);
                const known = enumIds.get(row.id)?.get(value);
                key = known?.id ?? null;
                label = known?.label ?? raw;
            } else {
                value = key = normalizeAttributeValue(raw).slice(0, FACET_KEY_MAX_LENGTH) || null;
            }
            if (value !== null && key !== null && !keys.includes(key)) {
                values.push(value);
                labels.push(label);
                keys.push(key);
            }
        }
        const range = row.valueType === "number" ? rangeBounds.get(row.slug) : undefined;
        if (keys.length === 0 && !range) continue;
        attributeFilters.push({
            kind: "attribute",
            id: row.id,
            name: row.name ?? row.slug,
            slug: row.slug,
            values,
            labels,
            keys,
            ...(range ? { range } : {}),
        });
    }
    attributeFilters.sort((left, right) => slugs.indexOf(left.slug) - slugs.indexOf(right.slug));

    const brandFilters: CatalogFacetFilter[] = brandRows.length > 0
        ? [{
            kind: "brand",
            id: BRAND_FACET_KEY,
            name: "Brand",
            slug: BRAND_FACET_KEY,
            values: brandRows.map((row) => row.slug),
            labels: brandRows.map((row) => row.name ?? row.slug),
            keys: brandRows.map((row) => row.id),
        }]
        : [];
    return [...brandFilters, ...optionFilters, ...attributeFilters];
}

// ─── Filter predicates ──────────────────────────────────────────────────

interface FacetFilterSets {
    attributes: CatalogFacetFilter[];
    options: CatalogFacetFilter[];
    brand: CatalogFacetFilter | undefined;
}

function splitFacetFilters(filters: readonly CatalogFacetFilter[] = []): FacetFilterSets {
    return {
        attributes: filters.filter((filter) => filter.kind === "attribute"),
        options: filters.filter((filter) => filter.kind === "option" && filter.keys.length > 0),
        brand: filters.find((filter) => filter.kind === "brand" && filter.keys.length > 0),
    };
}

/**
 * The product carries a selected value (and lies in the selected range) of
 * every selected attribute, except `exceptKey` (the facet being counted).
 * Probes `product_facet_values` by primary key (owner = product, facet key).
 */
function productMatchesAttributeFilters(product: SQL, filters: readonly CatalogFacetFilter[], exceptKey?: SQL): SQL | undefined {
    const discrete = filters
        .filter((filter) => filter.keys.length > 0)
        .map((filter) => ({ key: filter.id, keys: filter.keys }));
    const ranges = filters
        .filter((filter) => filter.range)
        .map((filter) => ({
            key: filter.id,
            min: filter.range!.min ?? -OPEN_RANGE,
            max: filter.range!.max ?? OPEN_RANGE,
        }));
    const except = (selected: string) => exceptKey
        ? sql`CAST(json_extract(${sql.raw(selected)}.value, '$.key') AS TEXT) <> ${exceptKey} AND `
        : sql``;
    const parts: SQL[] = [];
    if (discrete.length > 0) {
        parts.push(sql`NOT EXISTS (
            SELECT 1 FROM json_each(${JSON.stringify(discrete)}) AS attribute_selected
            WHERE ${except("attribute_selected")}NOT EXISTS (
                SELECT 1 FROM product_facet_values AS attribute_selected_row
                WHERE attribute_selected_row.owner_id = ${product}
                  AND attribute_selected_row.facet_key = CAST(json_extract(attribute_selected.value, '$.key') AS TEXT)
                  AND attribute_selected_row.value_key IN (
                      SELECT CAST(value AS TEXT) FROM json_each(json_extract(attribute_selected.value, '$.keys'))
                  )
            )
        )`);
    }
    if (ranges.length > 0) {
        parts.push(sql`NOT EXISTS (
            SELECT 1 FROM json_each(${JSON.stringify(ranges)}) AS range_selected
            WHERE ${except("range_selected")}NOT EXISTS (
                SELECT 1 FROM product_facet_values AS range_selected_row
                WHERE range_selected_row.owner_id = ${product}
                  AND range_selected_row.facet_key = CAST(json_extract(range_selected.value, '$.key') AS TEXT)
                  AND range_selected_row.value_number >= CAST(json_extract(range_selected.value, '$.min') AS REAL)
                  AND range_selected_row.value_number <= CAST(json_extract(range_selected.value, '$.max') AS REAL)
            )
        )`);
    }
    return parts.length > 0 ? and(...parts) : undefined;
}

/**
 * Which selected attribute the product misses, computed once per product for
 * the facet counts: '' when it matches every selected attribute, the one
 * attribute id it misses, or NULL when it misses two or more. A value of
 * attribute K then counts when the result is '' or K.
 */
function productAttributeMissSql(product: SQL, filters: readonly CatalogFacetFilter[]): SQL {
    const discrete = filters
        .filter((filter) => filter.keys.length > 0)
        .map((filter) => ({ key: filter.id, keys: filter.keys }));
    const ranges = filters
        .filter((filter) => filter.range)
        .map((filter) => ({
            key: filter.id,
            min: filter.range!.min ?? -OPEN_RANGE,
            max: filter.range!.max ?? OPEN_RANGE,
        }));
    const branches: SQL[] = [];
    if (discrete.length > 0) {
        branches.push(sql`
            SELECT CAST(json_extract(attribute_selected.value, '$.key') AS TEXT) AS attribute_id
            FROM json_each(${JSON.stringify(discrete)}) AS attribute_selected
            WHERE NOT EXISTS (
                SELECT 1 FROM product_facet_values AS attribute_selected_row
                WHERE attribute_selected_row.owner_id = ${product}
                  AND attribute_selected_row.facet_key = CAST(json_extract(attribute_selected.value, '$.key') AS TEXT)
                  AND attribute_selected_row.value_key IN (
                      SELECT CAST(value AS TEXT) FROM json_each(json_extract(attribute_selected.value, '$.keys'))
                  )
            )`);
    }
    if (ranges.length > 0) {
        branches.push(sql`
            SELECT CAST(json_extract(range_selected.value, '$.key') AS TEXT) AS attribute_id
            FROM json_each(${JSON.stringify(ranges)}) AS range_selected
            WHERE NOT EXISTS (
                SELECT 1 FROM product_facet_values AS range_selected_row
                WHERE range_selected_row.owner_id = ${product}
                  AND range_selected_row.facet_key = CAST(json_extract(range_selected.value, '$.key') AS TEXT)
                  AND range_selected_row.value_number >= CAST(json_extract(range_selected.value, '$.min') AS REAL)
                  AND range_selected_row.value_number <= CAST(json_extract(range_selected.value, '$.max') AS REAL)
            )`);
    }
    if (branches.length === 0) return sql`''`;
    return sql`(
        SELECT CASE count(DISTINCT missed.attribute_id) WHEN 0 THEN '' WHEN 1 THEN MIN(missed.attribute_id) END
        FROM (${sql.join(branches, sql` UNION ALL `)}) AS missed
    )`;
}

/** The SKU (`skuOwner`) carries a selected value on every selected option axis except `exceptKey`. */
function skuMatchesOptionFilters(skuOwner: SQL, filters: readonly CatalogFacetFilter[], exceptKey?: SQL): SQL | undefined {
    if (filters.length === 0) return undefined;
    const selected = JSON.stringify(filters.map((filter) => ({ key: filter.id, keys: filter.keys })));
    return sql`NOT EXISTS (
        SELECT 1 FROM json_each(${selected}) AS option_selected
        WHERE ${exceptKey ? sql`CAST(json_extract(option_selected.value, '$.key') AS TEXT) <> ${exceptKey} AND ` : sql``}NOT EXISTS (
            SELECT 1 FROM product_facet_values AS option_selected_row
            WHERE option_selected_row.owner_id = ${skuOwner}
              AND option_selected_row.facet_key = CAST(json_extract(option_selected.value, '$.key') AS TEXT)
              AND option_selected_row.value_key IN (
                  SELECT CAST(value AS TEXT) FROM json_each(json_extract(option_selected.value, '$.keys'))
              )
        )
    )`;
}

/**
 * One live SKU of the product carries a selected value on every selected
 * axis (Shopify's variant filtering). Driven by the first axis's rows on the
 * product (`product_facet_values_product_idx`).
 */
function productMatchesOptionFilters(product: SQL, filters: readonly CatalogFacetFilter[]): SQL | undefined {
    const [first] = filters;
    if (!first) return undefined;
    return sql`EXISTS (
        SELECT 1 FROM product_facet_values AS option_sku
        WHERE option_sku.product_id = ${product}
          AND option_sku.facet_key = ${first.id}
          AND option_sku.value_key IN ${jsonTextSet(first.keys)}
          AND ${skuMatchesOptionFilters(sql.raw("option_sku.owner_id"), filters)}
    )`;
}

function brandMatches(brandColumn: SQL, filter: CatalogFacetFilter | undefined): SQL | undefined {
    return filter ? sql`${brandColumn} IN ${jsonTextSet(filter.keys)}` : undefined;
}

/**
 * The listing conditions of the request's facet filters, over the buyer
 * state alone (no `products` join): selected attribute values and ranges,
 * option axes on one SKU, and brands.
 */
export function catalogFacetFilterConditions(filters: readonly CatalogFacetFilter[] | undefined): SQL[] {
    const sets = splitFacetFilters(filters);
    const product = sql`${buyerState.productId}`;
    return [
        brandMatches(sql`${buyerState.brandId}`, sets.brand),
        productMatchesOptionFilters(product, sets.options),
        productMatchesAttributeFilters(product, sets.attributes),
    ].filter((condition): condition is SQL => Boolean(condition));
}

// ─── Facet counts ───────────────────────────────────────────────────────

export interface CatalogFacetCountInput {
    /** The listing scope before facet filters (public set, category, search, price…). */
    baseConditions: SQL[];
    /** A base condition reads `products` columns. */
    needsProducts: boolean;
    filters: readonly CatalogFacetFilter[] | undefined;
    /** A category listing: its effective attribute set orders and restricts the attribute facets. */
    categoryId?: string;
    /** Count the brand facet (not on a brand's own page). */
    brandFacet?: boolean;
    /**
     * Count the "N★ & up" rating facet (listings; `groupCatalogRatingFacet`),
     * read from `product_review_stats` by primary key per scoped product (R9).
     */
    ratingFacet?: boolean;
    /** The selected "N★ & up" (whole stars 1-4): every other facet counts only products it keeps. */
    minRating?: number;
    /**
     * The category-tree facet: `{ parentId }` counts each published child of
     * the listing's category over its subtree (Star Tech's sub-category
     * pills, Daraz's category list); `"product-categories"` counts the
     * published categories the scoped products sit in (search, collection
     * and brand listings). Each count applies every facet selection.
     */
    categoryFacet?: { parentId: string } | "product-categories";
    /** Defaults: FACET_ATTRIBUTE_LIMIT attribute facets, FACET_VALUE_LIMIT values per facet. */
    attributeLimit?: number;
    valueLimit?: number;
}

export type CatalogFacetCountRow = {
    facetKind: PublicProductFacetKind | typeof RATING_FACET_KEY;
    facetId: string;
    valueKey: string;
    valueCount: number;
    valueLabel: string | null;
    valueSort: number | null;
    valueNumber: number | null;
    facetName: string | null;
    facetSlug: string | null;
    facetDisplay: string | null;
    facetUnit: string | null;
    facetOrder: number | null;
    urlValue: string | null;
    swatch: string | null;
    rangeMin: number | null;
    rangeMax: number | null;
};

/**
 * Every facet's value counts in one statement: attribute values, option
 * values and brands of the scoped public products, each counted against the
 * other facets' selections (a value's count is what ticking it would show).
 * Values are capped per facet (the most common, plus selected ones), range
 * facets return one row with their bounds, and at most
 * `FACET_ATTRIBUTE_LIMIT` attribute facets are kept.
 *
 * Plan shape: the scope is read once through the listing's own index and
 * materialized with each product's match flags; the facet rows are then
 * probed per scoped product (`CROSS JOIN` fixes that order, since SQLite has
 * no statistics on D1 and would otherwise walk every option row in the store).
 */
export function buildCatalogFacetCountQuery(db: Database, input: CatalogFacetCountInput) {
    const sets = splitFacetFilters(input.filters);
    const minRatingCenti = input.minRating === undefined ? undefined : input.minRating * 100;
    const readsRating = Boolean(input.ratingFacet) || minRatingCenti !== undefined;
    // The selected rating narrows every other facet's count (never its own).
    const ratingMatch = minRatingCenti === undefined ? sql`` : sql` AND facet_scope.rating_match = 1`;
    const truth = (condition: SQL | undefined) => condition ?? sql`1 = 1`;
    // Each product's matches against the selections are computed once, in the
    // materialized scope, not once per facet row.
    const scopeProduct = sql`${buyerState.productId}`;
    const attributeMatch = (except?: SQL) => except
        ? sql`(facet_scope.attribute_miss = '' OR facet_scope.attribute_miss = ${except})`
        : sql`facet_scope.attribute_miss = ''`;
    const optionMatch = sql`facet_scope.option_match = 1`;
    const brandMatch = sql`facet_scope.brand_match = 1`;
    const selected = JSON.stringify((input.filters ?? []).map((filter) => ({
        id: filter.kind === "brand" ? BRAND_FACET_KEY : filter.id,
        keys: filter.keys,
    })));
    const scopeProducts = input.needsProducts
        ? sql`${buyerState} INNER JOIN "products" ON "products"."id" = ${buyerState.productId}`
        : sql`${buyerState}`;
    // A left join by primary key after the scope's own index: it never drives.
    const scopeFrom = readsRating
        ? sql`${scopeProducts} LEFT JOIN ${reviewStats} AS facet_rating ON facet_rating.product_id = ${buyerState.productId} AND ${reviewsEnabledSql()} = 1`
        : scopeProducts;
    const categorySet = input.categoryId
        ? sql`(
            SELECT set_row.attribute_id AS attribute_id,
                MIN((3 - set_closure.depth) * 100000 + set_row.sort_order) AS set_order
            FROM category_closure AS set_closure
            INNER JOIN category_attribute_sets AS set_row ON set_row.category_id = set_closure.ancestor_id
            WHERE set_closure.descendant_id = ${input.categoryId}
            GROUP BY set_row.attribute_id
        )`
        : sql`(SELECT CAST(NULL AS TEXT) AS attribute_id, CAST(NULL AS INTEGER) AS set_order WHERE 0 = 1)`;
    const categoryHasSet = input.categoryId
        ? sql`EXISTS (
            SELECT 1 FROM category_closure AS any_set_closure
            INNER JOIN category_attribute_sets AS any_set_row ON any_set_row.category_id = any_set_closure.ancestor_id
            WHERE any_set_closure.descendant_id = ${input.categoryId}
        )`
        : sql`0 = 1`;

    // Brands are counted from the materialized scope, never by walking every
    // branded product in the store. A legacy attribute with the slug "brand"
    // is never offered, since "brand" is the brand entity's query key.
    const brandBranch = input.brandFacet === false
        ? sql``
        : sql`
            UNION ALL
            SELECT 'brand', 'brand', facet_scope.brand_id,
                SUM(CASE WHEN ${attributeMatch()} AND ${optionMatch}${ratingMatch} THEN 1 ELSE 0 END),
                NULL, NULL, NULL, NULL
            FROM facet_scope
            WHERE facet_scope.brand_id IS NOT NULL
            GROUP BY facet_scope.brand_id`;
    // "N★ & up": one row per offered threshold (plus a selected one), each
    // counted against the other facets' selections. Emitted only when a
    // scoped product has a published review, so an unreviewed scope has none.
    const ratingStars = [...new Set<number>([
        ...REVIEW_RATING_FACET_STARS,
        ...(input.minRating === undefined ? [] : [input.minRating]),
    ])];
    const ratingBranch = input.ratingFacet
        ? sql`
            UNION ALL
            SELECT 'rating', 'rating', CAST(rating_min.value AS TEXT),
                SUM(CASE WHEN facet_scope.rating_centi >= CAST(rating_min.value AS INTEGER) * 100
                    AND ${attributeMatch()} AND ${optionMatch} AND ${brandMatch} THEN 1 ELSE 0 END),
                NULL, NULL, NULL, NULL
            FROM json_each(${JSON.stringify(ratingStars)}) AS rating_min
            CROSS JOIN facet_scope
            WHERE facet_scope.rating_centi IS NOT NULL
            GROUP BY rating_min.value`
        : sql``;

    // Sub-listings are counted from the materialized scope too: each scoped
    // product counts once for the child whose subtree holds its category
    // (closure rows by descendant), or for its own published category.
    const everySelection = sql`${attributeMatch()} AND ${optionMatch} AND ${brandMatch}${ratingMatch}`;
    const categoryBranch = !input.categoryFacet
        ? sql``
        : input.categoryFacet === "product-categories"
            ? sql`
            UNION ALL
            SELECT 'category', ${CATEGORY_FACET_KEY}, facet_scope.category_id,
                SUM(CASE WHEN ${everySelection} THEN 1 ELSE 0 END),
                NULL, NULL, NULL, NULL
            FROM facet_scope
            WHERE facet_scope.category_id IS NOT NULL
            GROUP BY facet_scope.category_id`
            : sql`
            UNION ALL
            SELECT 'category', ${CATEGORY_FACET_KEY}, child_link.ancestor_id,
                SUM(CASE WHEN ${everySelection} THEN 1 ELSE 0 END),
                NULL, NULL, NULL, NULL
            FROM facet_scope
            CROSS JOIN category_closure AS child_link
            WHERE child_link.descendant_id = facet_scope.category_id
              AND child_link.ancestor_id IN (
                  SELECT listing_child.descendant_id FROM category_closure AS listing_child
                  WHERE listing_child.ancestor_id = ${input.categoryFacet.parentId} AND listing_child.depth = 1
              )
            GROUP BY child_link.ancestor_id`;
    const valueLimit = boundedLimit(input.valueLimit, FACET_VALUE_LIMIT);
    const brandValueLimit = input.valueLimit === undefined ? BRAND_FACET_VALUE_LIMIT : valueLimit;

    return namedRows<CatalogFacetCountRow>(db.all(sql`
        WITH facet_scope AS MATERIALIZED (
            SELECT ${buyerState.productId} AS product_id, ${buyerState.brandId} AS brand_id,
                ${buyerState.categoryId} AS category_id,
                ${productAttributeMissSql(scopeProduct, sets.attributes)} AS attribute_miss,
                CASE WHEN ${truth(productMatchesOptionFilters(scopeProduct, sets.options))} THEN 1 ELSE 0 END AS option_match,
                CASE WHEN ${truth(brandMatches(sql`${buyerState.brandId}`, sets.brand))} THEN 1 ELSE 0 END AS brand_match,
                ${readsRating ? sql`facet_rating.rating_avg_centi` : sql`NULL`} AS rating_centi,
                ${minRatingCenti === undefined
                    ? sql`1`
                    : sql`CASE WHEN facet_rating.rating_avg_centi >= ${minRatingCenti} THEN 1 ELSE 0 END`} AS rating_match
            FROM ${scopeFrom}
            WHERE ${and(...input.baseConditions) ?? sql`1 = 1`}
        ),
        facet_counts AS (
            SELECT 'attribute' AS facet_kind, attribute_row.facet_key AS facet_id, attribute_row.value_key AS value_key,
                SUM(CASE WHEN ${attributeMatch(sql.raw("attribute_row.facet_key"))} AND ${optionMatch} AND ${brandMatch}${ratingMatch} THEN 1 ELSE 0 END) AS value_count,
                MIN(attribute_row.value_label) AS value_label,
                MIN(attribute_row.sort_order) AS value_sort,
                MIN(attribute_row.value_number) AS value_number,
                NULL AS sample_sku
            FROM facet_scope
            CROSS JOIN product_facet_values AS attribute_row
            WHERE attribute_row.owner_id = facet_scope.product_id
              AND attribute_row.facet_kind = 'attribute'
            GROUP BY attribute_row.facet_key, attribute_row.value_key
            UNION ALL
            SELECT 'option', option_row.facet_key, option_row.value_key,
                COUNT(DISTINCT CASE
                    WHEN ${truth(skuMatchesOptionFilters(sql.raw("option_row.owner_id"), sets.options, sql.raw("option_row.facet_key")))}
                     AND ${attributeMatch()} AND ${brandMatch}${ratingMatch}
                    THEN option_row.product_id
                END),
                MIN(option_row.value_label), MIN(option_row.sort_order), NULL, MIN(option_row.variant_id)
            FROM facet_scope
            CROSS JOIN product_facet_values AS option_row
            WHERE option_row.product_id = facet_scope.product_id
              AND option_row.facet_key > ${OPTION_FACET_PREFIX}
              AND option_row.facet_key < ${`${OPTION_FACET_PREFIX.slice(0, -1)}/`}
              AND option_row.facet_kind = 'option'
            GROUP BY option_row.facet_key, option_row.value_key
            ${brandBranch}
            ${ratingBranch}
            ${categoryBranch}
        ),
        facet_resolved AS (
            SELECT facet_counts.*,
                CASE facet_counts.facet_kind
                    WHEN 'attribute' THEN facet_attribute.name
                    WHEN 'brand' THEN 'Brand'
                    WHEN 'rating' THEN 'Rating'
                    WHEN 'category' THEN 'Category'
                    ELSE (
                        SELECT axis.name
                        FROM product_variant_option_values AS axis_assignment
                        INNER JOIN product_option_definitions AS axis
                            ON axis.id = axis_assignment.option_definition_id
                           AND axis.deleted_at IS NULL
                        WHERE axis_assignment.variant_id = facet_counts.sample_sku
                          AND ${OPTION_FACET_PREFIX} || replace(axis.normalized_name, ' ', '-') = facet_counts.facet_id
                        LIMIT 1
                    )
                END AS facet_name,
                CASE facet_counts.facet_kind WHEN 'attribute' THEN facet_attribute.slug ELSE facet_counts.facet_id END AS facet_slug,
                CASE facet_counts.facet_kind WHEN 'attribute' THEN facet_attribute.facet_display ELSE 'checkbox' END AS facet_display,
                CASE facet_counts.facet_kind WHEN 'attribute' THEN facet_attribute.unit ELSE NULL END AS facet_unit,
                CASE facet_counts.facet_kind
                    WHEN 'attribute' THEN COALESCE(category_set.set_order, 1000000) * 100000 + facet_attribute.sort_order
                    ELSE 0
                END AS facet_order,
                CASE facet_counts.facet_kind
                    WHEN 'brand' THEN facet_brand.slug
                    WHEN 'category' THEN facet_category.slug
                    WHEN 'attribute' THEN CASE WHEN facet_attribute.value_type = 'enum' THEN facet_enum.normalized_value ELSE facet_counts.value_key END
                    ELSE facet_counts.value_key
                END AS url_value,
                CASE facet_counts.facet_kind
                    WHEN 'brand' THEN facet_brand.name
                    WHEN 'category' THEN facet_category.name
                    WHEN 'attribute' THEN COALESCE(facet_enum.value, facet_counts.value_label)
                    ELSE facet_counts.value_label
                END AS display_label,
                CASE facet_counts.facet_kind
                    WHEN 'brand' THEN facet_brand.sort_order
                    WHEN 'attribute' THEN COALESCE(facet_enum.sort_order, facet_counts.value_sort)
                    ELSE facet_counts.value_sort
                END AS display_sort,
                facet_enum.swatch_hex AS swatch,
                CASE WHEN EXISTS (
                    SELECT 1 FROM json_each(${selected}) AS facet_selected
                    WHERE CAST(json_extract(facet_selected.value, '$.id') AS TEXT) = facet_counts.facet_id
                      AND facet_counts.value_key IN (
                          SELECT CAST(value AS TEXT) FROM json_each(json_extract(facet_selected.value, '$.keys'))
                      )
                ) THEN 1 ELSE 0 END AS is_selected
            FROM facet_counts
            LEFT JOIN ${productAttributes} AS facet_attribute
                ON facet_counts.facet_kind = 'attribute' AND facet_attribute.id = facet_counts.facet_id
            LEFT JOIN ${attributeValues} AS facet_enum
                ON facet_counts.facet_kind = 'attribute'
               AND facet_attribute.value_type = 'enum'
               AND facet_enum.id = facet_counts.value_key
            LEFT JOIN ${brands} AS facet_brand
                ON facet_counts.facet_kind = 'brand' AND facet_brand.id = facet_counts.value_key
            LEFT JOIN "categories" AS facet_category
                ON facet_counts.facet_kind = 'category' AND facet_category.id = facet_counts.value_key
            LEFT JOIN ${categorySet} AS category_set
                ON facet_counts.facet_kind = 'attribute' AND category_set.attribute_id = facet_counts.facet_id
            WHERE (facet_counts.facet_kind <> 'attribute' OR (
                    facet_attribute.filterable = 1
                    AND facet_attribute.deleted_at IS NULL
                    AND facet_attribute.slug <> 'brand'
                    AND (facet_attribute.value_type <> 'enum' OR facet_enum.id IS NOT NULL)
                    AND (category_set.attribute_id IS NOT NULL OR NOT (${categoryHasSet}))
                ))
              AND (facet_counts.facet_kind <> 'brand' OR (
                    facet_brand.status = 'published' AND facet_brand.deleted_at IS NULL
                ))
              AND (facet_counts.facet_kind <> 'category' OR (
                    facet_category.status = 'published' AND facet_category.deleted_at IS NULL
                ))
        ),
        facet_ranked AS (
            SELECT facet_resolved.*,
                ROW_NUMBER() OVER (
                    PARTITION BY facet_kind, facet_id
                    ORDER BY is_selected DESC, value_count DESC, display_sort, value_key
                ) AS value_rank,
                MIN(CASE WHEN value_count > 0 THEN value_number END) OVER (PARTITION BY facet_kind, facet_id) AS range_min,
                MAX(CASE WHEN value_count > 0 THEN value_number END) OVER (PARTITION BY facet_kind, facet_id) AS range_max,
                DENSE_RANK() OVER (PARTITION BY facet_kind ORDER BY facet_order, facet_name, facet_id) AS facet_rank
            FROM facet_resolved
        )
        SELECT facet_kind AS facetKind, facet_id AS facetId, value_key AS valueKey,
            value_count AS valueCount, display_label AS valueLabel, display_sort AS valueSort,
            value_number AS valueNumber, facet_name AS facetName, facet_slug AS facetSlug,
            facet_display AS facetDisplay, facet_unit AS facetUnit, facet_order AS facetOrder,
            url_value AS urlValue, swatch, range_min AS rangeMin, range_max AS rangeMax
        FROM facet_ranked
        WHERE (facet_kind <> 'attribute' OR facet_rank <= ${sql.raw(String(boundedLimit(input.attributeLimit, FACET_ATTRIBUTE_LIMIT)))})
          AND (value_rank <= CASE facet_kind WHEN 'brand' THEN ${sql.raw(String(brandValueLimit))} ELSE ${sql.raw(String(valueLimit))} END OR is_selected = 1)
          AND (facet_display <> 'range' OR value_rank = 1)
    `), [
        "facetKind", "facetId", "valueKey", "valueCount", "valueLabel", "valueSort", "valueNumber", "facetName",
        "facetSlug", "facetDisplay", "facetUnit", "facetOrder", "urlValue", "swatch", "rangeMin", "rangeMax",
    ]);
}

const KIND_ORDER: Record<PublicProductFacetKind, number> = { category: 0, brand: 1, option: 2, attribute: 3 };

/** One "N★ & up" row: products in scope whose published-review average is at least `min` stars. */
export interface PublicRatingFacetValue {
    min: number;
    count: number;
}

/**
 * The rating facet from the count rows, highest threshold first. Empty when
 * no product in the listing's scope has a published review (the storefront
 * also hides the group while the store has none, `hasReviews`); otherwise
 * every offered threshold (4, 3, 2) plus a selected one, counts possibly 0.
 * A selected `minRating` always keeps its row so the buyer can untick it.
 */
export function groupCatalogRatingFacet(
    rows: readonly CatalogFacetCountRow[],
    minRating?: number,
): PublicRatingFacetValue[] {
    const values = rows
        .filter((row) => row.facetKind === RATING_FACET_KEY)
        .map((row) => ({ min: Number(row.valueKey), count: Number(row.valueCount) || 0 }));
    if (values.length === 0 && minRating !== undefined) values.push({ min: minRating, count: 0 });
    return values.sort((left, right) => right.min - left.min);
}

function compareFacetValues(
    left: PublicProductFacetValue & { sort: number; number: number | null },
    right: PublicProductFacetValue & { sort: number; number: number | null },
): number {
    if (left.number !== null && right.number !== null && left.number !== right.number) return left.number - right.number;
    return left.sort - right.sort || left.label.localeCompare(right.label, undefined, { numeric: true });
}

/**
 * Facets from the count rows: brand first, then option axes by name, then
 * attributes in the category's spec order (then their own order and name).
 * Selected values that match nothing in the scope stay listed with a zero
 * count so the buyer can untick them.
 */
export function groupCatalogFacets(
    rows: readonly CatalogFacetCountRow[],
    filters: readonly CatalogFacetFilter[] = [],
): PublicProductFacet[] {
    type Building = PublicProductFacet & { order: number; valuesSorted: Array<PublicProductFacetValue & { sort: number; number: number | null }> };
    const facets = new Map<string, Building>();
    const facetKey = (kind: string, id: string) => `${kind}:${id}`;
    for (const row of rows) {
        if (row.facetKind === RATING_FACET_KEY) continue; // groupCatalogRatingFacet
        const key = facetKey(row.facetKind, row.facetId);
        let facet = facets.get(key);
        if (!facet) {
            const display = (row.facetDisplay ?? "checkbox") as AttributeFacetDisplay;
            facet = {
                id: row.facetId,
                name: row.facetName ?? row.facetId.replace(OPTION_FACET_PREFIX, ""),
                slug: row.facetSlug ?? row.facetId,
                kind: row.facetKind,
                display,
                unit: row.facetUnit ?? null,
                values: [],
                range: display === "range" && row.rangeMin !== null && row.rangeMax !== null
                    ? { min: Number(row.rangeMin), max: Number(row.rangeMax) }
                    : null,
                order: Number(row.facetOrder) || 0,
                valuesSorted: [],
            };
            facets.set(key, facet);
        } else if (row.facetKind === "option" && row.facetName && row.facetName < facet.name) {
            // Axis names differ in case between products ("Size", "size"): one stable pick.
            facet.name = row.facetName;
        }
        if (facet.display === "range" || row.urlValue === null) continue;
        facet.valuesSorted.push({
            value: row.urlValue,
            label: row.valueLabel ?? row.urlValue,
            count: Number(row.valueCount) || 0,
            swatch: row.swatch ?? null,
            sort: Number(row.valueSort) || 0,
            number: row.valueNumber === null ? null : Number(row.valueNumber),
        });
    }

    for (const filter of filters) {
        const key = facetKey(filter.kind, filter.kind === "brand" ? BRAND_FACET_KEY : filter.id);
        const facet = facets.get(key) ?? {
            id: filter.kind === "brand" ? BRAND_FACET_KEY : filter.id,
            name: filter.name,
            slug: filter.slug,
            kind: filter.kind,
            display: filter.range && filter.keys.length === 0 ? "range" as const : "checkbox" as const,
            unit: null,
            values: [],
            range: null,
            order: Number.MAX_SAFE_INTEGER,
            valuesSorted: [],
        };
        if (facet.display !== "range") {
            const known = new Set(facet.valuesSorted.map(({ value }) => value));
            filter.values.forEach((value, index) => {
                if (known.has(value)) return;
                const label = filter.labels?.[index] ?? value;
                facet.valuesSorted.push({ value, label, count: 0, swatch: null, sort: Number.MAX_SAFE_INTEGER, number: null });
            });
        }
        facets.set(key, facet);
    }

    return [...facets.values()]
        // One category is no choice: the category-tree facet needs two.
        .filter((facet) => facet.kind !== "category" || facet.valuesSorted.length >= 2)
        .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
            || left.order - right.order
            || left.name.localeCompare(right.name))
        .map(({ order: _order, valuesSorted, ...facet }) => ({
            ...facet,
            values: valuesSorted
                .sort(compareFacetValues)
                .map(({ sort: _sort, number: _number, ...value }) => value),
        }));
}

// ─── Facet definitions outside a listing ────────────────────────────────

/** Facets for agents and tools: fewer values, so a response stays bounded. */
const DEFINITION_FACET_LIMITS = { attributeLimit: 20, valueLimit: 30 };

/**
 * The facets of a published category and its published sub-categories, with
 * counts over their public products (the category's attribute set orders
 * and restricts the attribute facets).
 */
export async function getPublicCategoryFacets(db: Database, categoryId: string): Promise<{ facets: PublicProductFacet[] }> {
    const rows = await buildCatalogFacetCountQuery(db, {
        baseConditions: [publicBuyerStateCondition(), publicCategorySubtreeCondition(buyerState.categoryId, categoryId)],
        needsProducts: false,
        filters: [],
        categoryId,
        ...DEFINITION_FACET_LIMITS,
    });
    return { facets: groupCatalogFacets(rows) };
}

/** The facets of a search's public hits (optionally inside a category, by slug or id). */
export async function getPublicSearchFacets(
    db: Database,
    search: string,
    category?: string,
): Promise<{ facets: PublicProductFacet[] }> {
    const { conditions, needsProducts } = buildStorefrontBuyerStateConditions(db, { search, category });
    const rows = await buildCatalogFacetCountQuery(db, {
        baseConditions: conditions,
        needsProducts,
        filters: [],
        ...DEFINITION_FACET_LIMITS,
    });
    return { facets: groupCatalogFacets(rows) };
}
