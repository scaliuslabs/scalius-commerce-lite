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
import { brands, productAttributes, attributeValues, categoryClosure } from "@scalius/database/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
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
import type { CatalogFacetFilter } from "../products";
import { publicCategorySubtreeCondition } from "../categories";
import { buyerState, publicBuyerStateCondition } from "./buyer-state";
import { buildStorefrontBuyerStateConditions, productMinRatingCondition, reviewStats } from "./shared";
import { categoryScope, deps } from "./declare-deps";
import { reviewsEnabledSql, storeCurrencyCodeSql } from "../settings";
import { REVIEW_RATING_FACET_STARS } from "@scalius/shared/reviews";
import { planLimits } from "@scalius/shared/plan-limits";

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
/**
 * A narrowed listing (search, filters, selections) counts attribute and
 * option values from its scope's own facet rows only while the scope holds at
 * most this many products (`planLimits().lists.facetLiveProducts`: about a
 * dozen facet rows a product, so Free's 1,000 stays inside its rows-read
 * budget). A larger narrowed scope still gets its brand, category and rating
 * facets, which read the scope rows alone. Plain category, brand and shop-all
 * pages read the maintained counts at any size (`precomputed`, `allPublic`).
 */
export function facetLiveScopeLimit(): number {
    return planLimits().lists.facetLiveProducts;
}

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

    // Slugs, enum values and brand slugs are looked up by value: any
    // definition or brand change can make a parameter resolve differently.
    if (slugs.length > 0) deps.anyAttribute();
    if (brandSlugs.length > 0) deps.anyBrand();
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
          ${filters.length > 1 ? sql`AND ${skuMatchesOptionFilters(sql.raw("option_sku.owner_id"), filters)}` : sql``}
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

/**
 * The products of the first selected attribute or option value set, as an
 * index range of `product_facet_values_value_idx`, and their public count
 * from the maintained counts (an upper bound: a product with two selected
 * values counts twice). A listing narrowed by it can be driven from these
 * ids instead of walking every public product (`listing.ts`).
 */
export function catalogFacetDrivingSet(filters: readonly CatalogFacetFilter[] | undefined): {
    productIds: SQL;
    publicCount: SQL<number>;
    /** The only selection is this one value (no range, no other facet): its public count is the listing's exact size. */
    sole: boolean;
} | undefined {
    const filter = (filters ?? []).find((candidate) => (candidate.kind === "attribute" || candidate.kind === "option") && candidate.keys.length > 0);
    if (!filter) return undefined;
    const keys = jsonTextSet(filter.keys);
    return {
        sole: (filters ?? []).length === 1 && filter.keys.length === 1 && !filter.range,
        productIds: sql`(SELECT drive_row.product_id FROM product_facet_values AS drive_row
            WHERE drive_row.facet_key = ${filter.id} AND drive_row.value_key IN ${keys})`,
        publicCount: sql<number>`(SELECT COALESCE(SUM(drive_count.product_count), 0) FROM product_facet_public_counts AS drive_count
            WHERE drive_count.facet_kind = ${filter.kind} AND drive_count.facet_key = ${filter.id} AND drive_count.value_key IN ${keys})`,
    };
}

// ─── Facet counts ───────────────────────────────────────────────────────

export interface CatalogFacetCountInput {
    /** The listing scope before facet filters (public set, category, search, price…). */
    baseConditions: SQL[];
    /** A base condition reads `products` columns. */
    needsProducts: boolean;
    /**
     * The scope is every public product and nothing is selected (the plain
     * shop-all page): attribute and option values come from the maintained
     * public counts, brands and categories from the buyer state's own indexes,
     * whatever the catalogue's size. It has no rating facet (that would read
     * every product's review stats).
     */
    allPublic?: boolean;
    filters: readonly CatalogFacetFilter[] | undefined;
    /** A category listing: its effective attribute set orders and restricts the attribute facets. */
    categoryId?: string;
    /** Count the brand facet (not on a brand's own page). */
    brandFacet?: boolean;
    /**
     * The caller declares `c:` for the category and its ancestors from a
     * statement it already runs (listing.ts reads them with its count), so
     * the facet read adds no ancestor lookup of its own.
     */
    categoryAncestorsDeclared?: boolean;
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
    /**
     * The scope is a plain category subtree or brand page and nothing narrows
     * it (no selection, search, price or stock filter): every count comes from
     * the maintained per-scope counts (`product_facet_scope_counts`, 0174), so
     * the read is bounded by the scope's categories and values, never by its
     * products. `categoryIds` selects the subtree's published category ids.
     */
    precomputed?: CatalogFacetScopeCounts;
    /**
     * A narrowed category or brand listing's own scope counts: past the live
     * limit its attribute and option values show the scope's counts (the
     * other selections not applied), so a large category keeps its filters
     * after one is picked.
     */
    fallbackCounts?: CatalogFacetScopeCounts;
    /** Defaults: FACET_ATTRIBUTE_LIMIT attribute facets, FACET_VALUE_LIMIT values per facet. */
    attributeLimit?: number;
    valueLimit?: number;
}

/** A category subtree (its published category ids) or a brand, in `product_facet_scope_counts`. */
export type CatalogFacetScopeCounts = { kind: "category"; categoryIds: SQL } | { kind: "brand"; brandId: string };

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
    /** An option value's sample SKU's product: the facet's axis name is read from it. */
    sampleProductId?: string | null;
};

export interface CatalogListingSummary {
    count: number;
    min: number | null;
    max: number | null;
    storeCurrencyCode: string | null;
    categoryAncestors: string | null;
    cardFieldsTheme: string | null;
}

type ListingSummaryInput = { categoryAncestors?: SQL<string | null>; cardFieldsTheme?: SQL<string | null> };
type FacetRead = { rows: CatalogFacetCountRow[]; summary: CatalogListingSummary | null };
type ResolvedFacetRow = Omit<CatalogFacetCountRow, "rangeMin" | "rangeMax"> & { isSelected: number | boolean | null };
type FacetResultRow = ResolvedFacetRow & {
    recordType?: string;
    listingCount?: number;
    listingMin?: number | null;
    listingMax?: number | null;
    listingCurrency?: string | null;
    listingAncestors?: string | null;
    listingTheme?: string | null;
};

/**
 * Every facet's value counts in one statement: attribute values, option
 * values and brands of the scoped public products, each counted against the
 * other facets' selections (a value's count is what ticking it would show).
 * Values are capped per facet (the most common, plus selected ones), range
 * facets return one row with their bounds, and at most
 * `FACET_ATTRIBUTE_LIMIT` attribute facets are kept.
 *
 * Plan shape (the same SQL on every provider): the scope is read once
 * through the listing's own index and materialized with each product's
 * match flags; attribute and option values then probe each scoped product's
 * facet rows, only while the scope holds at most facetLiveScopeLimit()
 * products (`allPublic` reads the public counts instead).
 */
export function buildCatalogFacetCountQuery(db: Database, input: CatalogFacetCountInput): Promise<CatalogFacetCountRow[]> {
    return readCatalogFacets(db, input).then(result => result.rows);
}

/** Scoped listing totals share the existing materialized facet scope. */
export async function readCatalogFacetsWithSummary(
    db: Database, input: CatalogFacetCountInput, summary: ListingSummaryInput = {},
): Promise<{ rows: CatalogFacetCountRow[]; summary: CatalogListingSummary }> {
    const result = await readCatalogFacets(db, input, summary);
    if (!result.summary) throw new Error("The listing facet read did not return its summary.");
    return { rows: result.rows, summary: result.summary };
}

function readCatalogFacets(db: Database, input: CatalogFacetCountInput, summary?: ListingSummaryInput): Promise<FacetRead> {
    // Facet names, units, displays and enum labels come from the attribute
    // definitions of whatever the scope holds; brand facets from brand rows.
    deps.anyAttribute();
    if (input.brandFacet !== false) deps.anyBrand();
    // The category facet: which categories are published, and the tree.
    if (input.categoryFacet) deps.anyCategory();
    const rows = catalogFacetCountRows(db, input, summary).then((result) => {
        declareOptionFacetNames(result.rows);
        return result;
    });
    if (!input.categoryId || input.categoryAncestorsDeclared || !deps.active()) return rows;
    // The category's effective attribute set is its own and its ancestors'
    // (category_attribute_sets advances only `c:<the set's category>`).
    const ancestors = db
        .select({ id: categoryClosure.ancestorId })
        .from(categoryClosure)
        .where(eq(categoryClosure.descendantId, input.categoryId))
        .all()
        .then((ancestorRows: Array<{ id: string }>) => deps.categories(ancestorRows.map((row) => row.id)));
    return Promise.all([rows, ancestors]).then(([facetRows]) => facetRows);
}

/** An option facet's name is its axis name on the value's sample SKU, a `p:` fact of that SKU's product. */
function declareOptionFacetNames(rows: readonly CatalogFacetCountRow[]): void {
    if (!deps.active()) return;
    deps.products(rows.filter((row) => row.facetKind === "option").map((row) => row.sampleProductId));
}

/**
 * A facet read that shows no product at all (no card, no option value) still
 * names the option tables in its axis-name lookup, though nothing it returns
 * depends on them. Coverage is decided per table and kind, so only the
 * tables' own coarse keys can cover that read: a cheap, empty entry.
 */
export function declareFacetReadWithoutProducts(rows: readonly CatalogFacetCountRow[]): void {
    if (!deps.active() || rows.some((row) => row.facetKind === "option")) return;
    deps.table("product_option_definitions");
    deps.table("product_variant_option_values");
    deps.table("product_variants");
}

function catalogFacetCountRows(db: Database, input: CatalogFacetCountInput, summary?: ListingSummaryInput): Promise<FacetRead> {
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
    // Left joins by primary key after the scope's own index: they never drive.
    const scopeProducts = input.needsProducts
        ? sql`${buyerState} INNER JOIN "products" ON "products"."id" = ${buyerState.productId}`
        : sql`${buyerState}`;
    const scopeFrom = readsRating
        ? sql`${scopeProducts} LEFT JOIN ${reviewStats} AS facet_rating ON facet_rating.product_id = ${buyerState.productId} AND ${reviewsEnabledSql()} = 1`
        : scopeProducts;
    const scopeQuery = sql`
        SELECT ${buyerState.productId} AS product_id, ${buyerState.brandId} AS brand_id,
            ${buyerState.categoryId} AS category_id,
            ${productAttributeMissSql(scopeProduct, sets.attributes)} AS attribute_miss,
            CASE WHEN ${truth(productMatchesOptionFilters(scopeProduct, sets.options))} THEN 1 ELSE 0 END AS option_match,
            CASE WHEN ${truth(brandMatches(sql`${buyerState.brandId}`, sets.brand))} THEN 1 ELSE 0 END AS brand_match,
            ${readsRating ? sql`facet_rating.rating_avg_centi` : sql`NULL`} AS rating_centi,
            ${minRatingCenti === undefined
                ? sql`1`
                : sql`CASE WHEN facet_rating.rating_avg_centi >= ${minRatingCenti} THEN 1 ELSE 0 END`} AS rating_match
            ${summary ? sql`, ${buyerState.fromMinor} AS listing_from_minor, ${buyerState.toMinor} AS listing_to_minor` : sql``}
        FROM ${scopeFrom}
        WHERE ${and(...input.baseConditions) ?? sql`1 = 1`}`;
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

    const valueLimit = boundedLimit(input.valueLimit, FACET_VALUE_LIMIT);
    const brandValueLimit = input.valueLimit === undefined ? BRAND_FACET_VALUE_LIMIT : valueLimit;
    // The maintained counts of a plain scope (or of the plain shop-all page):
    // rows of its categories or its brand, summed.
    const precomputed = input.precomputed;
    const countScope = precomputed ?? input.fallbackCounts;
    const scopeCountRows = (kinds: string) => countScope?.kind === "category"
        ? sql`product_facet_scope_counts AS scope_count
            WHERE scope_count.scope_kind = 'category' AND scope_count.scope_id IN ${countScope.categoryIds}
              AND scope_count.facet_kind IN (${sql.raw(kinds)})`
        : sql`product_facet_scope_counts AS scope_count
            WHERE scope_count.scope_kind = 'brand' AND scope_count.scope_id = ${countScope?.kind === "brand" ? countScope.brandId : ""}
              AND scope_count.facet_kind IN (${sql.raw(kinds)})`;
    // Brands are counted from the materialized scope, never by walking every
    // branded product in the store. A legacy attribute with the slug "brand"
    // is never offered, since "brand" is the brand entity's query key. A
    // plain scope sums its categories' brand rows; shop-all reads each
    // brand's own product count.
    const brandBranch = input.brandFacet === false
        ? sql``
        : precomputed || input.allPublic
            // Nothing is selected here, so the brands past the shown ones (in
            // the facet's own order) are cut before they are resolved.
            ? sql`
            UNION ALL
            SELECT 'brand', 'brand', shown_brands.brand_id, shown_brands.products, NULL, NULL, NULL, NULL FROM (
                SELECT brand_count.brand_id, brand_count.products
                FROM (${precomputed
                    ? sql`SELECT scope_count.value_key AS brand_id, SUM(scope_count.product_count) AS products
                        FROM ${scopeCountRows("'brand'")} GROUP BY scope_count.value_key`
                    : sql`SELECT scope_count.scope_id AS brand_id, scope_count.product_count AS products
                        FROM product_facet_scope_counts AS scope_count
                        WHERE scope_count.scope_kind = 'brand' AND scope_count.facet_kind = 'products'`}) AS brand_count
                INNER JOIN ${brands} AS counted_brand ON counted_brand.id = brand_count.brand_id
                    AND counted_brand.status = 'published' AND counted_brand.deleted_at IS NULL
                WHERE brand_count.products > 0
                ORDER BY brand_count.products DESC, counted_brand.sort_order, brand_count.brand_id
                LIMIT ${sql.raw(String(brandValueLimit))}
            ) AS shown_brands`
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
    // Count all thresholds in one scope pass, then expand the aggregate row.
    const ratingCounts = ratingStars.map((stars, index) => sql`
        SUM(CASE WHEN facet_scope.rating_centi >= ${stars * 100}
            AND ${attributeMatch()} AND ${optionMatch} AND ${brandMatch} THEN 1 ELSE 0 END)
            AS ${sql.raw(`rating_count_${index}`)}`);
    const ratingValueCount = sql`CASE CAST(rating_min.key AS INTEGER)
                    ${sql.join(ratingStars.map((_, index) => sql`
                        WHEN ${sql.raw(String(index))} THEN rating_counts.${sql.raw(`rating_count_${index}`)}`), sql` `)}
                END`;
    // A plain scope counts its rated products by whole star: "N★ & up" sums
    // the stars from N (a product's floor(average) >= N exactly when its
    // average is at least N stars).
    const precomputedRatingCounts = ratingStars.map((stars, index) => sql`
        SUM(CASE WHEN CAST(scope_count.value_key AS INTEGER) >= ${stars} THEN scope_count.product_count ELSE 0 END)
            AS ${sql.raw(`rating_count_${index}`)}`);
    const ratingBranch = input.ratingFacet && precomputed
        ? sql`
            UNION ALL
            SELECT 'rating', 'rating', CAST(rating_min.value AS TEXT),
                ${ratingValueCount},
                NULL, NULL, NULL, NULL
            FROM (
                SELECT COALESCE(SUM(scope_count.product_count), 0) AS rated_count, ${sql.join(precomputedRatingCounts, sql`, `)}
                FROM ${scopeCountRows("'rating'")} AND ${reviewsEnabledSql()} = 1
            ) AS rating_counts
            CROSS JOIN json_each(${JSON.stringify(ratingStars)}) AS rating_min
            WHERE rating_counts.rated_count > 0`
        : input.ratingFacet && !input.allPublic
        ? sql`
            UNION ALL
            SELECT 'rating', 'rating', CAST(rating_min.value AS TEXT),
                ${ratingValueCount},
                NULL, NULL, NULL, NULL
            FROM (
                SELECT COUNT(*) AS rated_count, ${sql.join(ratingCounts, sql`, `)}
                FROM facet_scope
                WHERE facet_scope.rating_centi IS NOT NULL
            ) AS rating_counts
            CROSS JOIN json_each(${JSON.stringify(ratingStars)}) AS rating_min
            WHERE rating_counts.rated_count > 0`
        : sql``;

    // Sub-listings are counted from the materialized scope too: each scoped
    // product counts once for the child whose subtree holds its category
    // (closure rows by descendant), or for its own published category.
    const everySelection = sql`${attributeMatch()} AND ${optionMatch} AND ${brandMatch}${ratingMatch}`;
    const categoryBranch = !input.categoryFacet
        ? sql``
        : (precomputed || input.allPublic) && input.categoryFacet === "product-categories"
            // A brand's categories (its category rows), or every category's own products.
            ? sql`
            UNION ALL
            SELECT 'category', ${CATEGORY_FACET_KEY}, shown_categories.category_id, shown_categories.products, NULL, NULL, NULL, NULL FROM (
                SELECT category_count.category_id, category_count.products
                FROM (${precomputed
                    ? sql`SELECT scope_count.value_key AS category_id, SUM(scope_count.product_count) AS products
                        FROM ${scopeCountRows("'category'")} GROUP BY scope_count.value_key`
                    : sql`SELECT scope_count.scope_id AS category_id, scope_count.product_count AS products
                        FROM product_facet_scope_counts AS scope_count
                        WHERE scope_count.scope_kind = 'category' AND scope_count.facet_kind = 'products'`}) AS category_count
                INNER JOIN categories AS counted_category ON counted_category.id = category_count.category_id
                    AND counted_category.status = 'published' AND counted_category.deleted_at IS NULL
                WHERE category_count.products > 0
                ORDER BY category_count.products DESC, category_count.category_id
                LIMIT ${sql.raw(String(valueLimit))}
            ) AS shown_categories`
        : precomputed?.kind === "category" && input.categoryFacet !== "product-categories"
            // Each child: the products of its subtree's published categories.
            ? sql`
            UNION ALL
            SELECT 'category', ${CATEGORY_FACET_KEY}, listing_child.descendant_id, SUM(scope_count.product_count),
                NULL, NULL, NULL, NULL
            FROM category_closure AS listing_child
            INNER JOIN category_closure AS child_subtree ON child_subtree.ancestor_id = listing_child.descendant_id
            INNER JOIN product_facet_scope_counts AS scope_count
                ON scope_count.scope_kind = 'category' AND scope_count.scope_id = child_subtree.descendant_id
               AND scope_count.facet_kind = 'products'
            WHERE listing_child.ancestor_id = ${input.categoryFacet.parentId} AND listing_child.depth = 1
              AND child_subtree.descendant_id IN ${precomputed.categoryIds}
            GROUP BY listing_child.descendant_id`
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
            INNER JOIN category_closure AS child_link ON child_link.descendant_id = facet_scope.category_id
            WHERE child_link.ancestor_id IN (
                  SELECT listing_child.descendant_id FROM category_closure AS listing_child
                  WHERE listing_child.ancestor_id = ${input.categoryFacet.parentId} AND listing_child.depth = 1
              )
            GROUP BY child_link.ancestor_id`;

    // A value of a selected filter (shown even when nothing in scope has it).
    const isSelectedValue = (facetId: SQL, valueKey: SQL) => sql`EXISTS (
        SELECT 1 FROM json_each(${selected}) AS facet_selected
        WHERE CAST(json_extract(facet_selected.value, '$.id') AS TEXT) = ${facetId}
          AND ${valueKey} IN (SELECT CAST(value AS TEXT) FROM json_each(json_extract(facet_selected.value, '$.keys')))
    )`;
    // Attribute and option value counts: the plain shop-all page reads the
    // maintained public counts, a plain category or brand its scope counts;
    // any other scope counts its products' own facet rows, read once each
    // through product_facet_values_product_idx alone (a NULL variant is an
    // attribute row, whose owner is its product; an option row's owner is its
    // SKU), only while it holds at most facetLiveScopeLimit()
    // products (a one-time check on every engine). The scope drives: a LEFT
    // JOIN keeps it outer, where a planner without statistics would rather walk
    // every facet row in GROUP BY order; HAVING drops the NULL group.
    const valueCounts = precomputed ? sql`
            SELECT scope_count.facet_kind AS facet_kind, scope_count.facet_key AS facet_id, scope_count.value_key AS value_key,
                SUM(scope_count.product_count) AS value_count, NULL AS sample_owner,
                MIN(scope_count.sample_product_id) AS sample_product
            FROM ${scopeCountRows("'attribute', 'option'")}
            GROUP BY scope_count.facet_kind, scope_count.facet_key, scope_count.value_key
            HAVING SUM(scope_count.product_count) > 0` : input.allPublic ? sql`
            SELECT facet_kind, facet_key AS facet_id, value_key, product_count AS value_count, NULL AS sample_owner,
                NULL AS sample_product
            FROM product_facet_public_counts WHERE product_count > 0` : sql`
            SELECT CASE WHEN facet_row.variant_id IS NULL THEN 'attribute' ELSE 'option' END AS facet_kind,
                facet_row.facet_key AS facet_id, facet_row.value_key AS value_key,
                CASE WHEN facet_row.variant_id IS NULL
                    THEN SUM(CASE WHEN ${attributeMatch(sql.raw("facet_row.facet_key"))} AND ${optionMatch} AND ${brandMatch}${ratingMatch} THEN 1 ELSE 0 END)
                    ELSE COUNT(DISTINCT CASE
                        WHEN ${truth(skuMatchesOptionFilters(sql.raw("facet_row.variant_id"), sets.options, sql.raw("facet_row.facet_key")))}
                         AND ${attributeMatch()} AND ${brandMatch}${ratingMatch}
                        THEN facet_row.product_id
                    END)
                END AS value_count,
                MIN(coalesce(facet_row.variant_id, facet_row.product_id)) AS sample_owner,
                NULL AS sample_product
            FROM facet_scope
            LEFT JOIN product_facet_values AS facet_row ON facet_row.product_id = facet_scope.product_id
            WHERE (SELECT products FROM facet_size) <= ${sql.raw(String(facetLiveScopeLimit()))}
            GROUP BY facet_row.facet_key, facet_row.value_key, facet_row.variant_id IS NULL
            HAVING facet_row.facet_key IS NOT NULL${input.fallbackCounts ? sql`
            UNION ALL
            SELECT scope_count.facet_kind, scope_count.facet_key, scope_count.value_key, SUM(scope_count.product_count), NULL,
                MIN(scope_count.sample_product_id)
            FROM ${scopeCountRows("'attribute', 'option'")}
              AND (SELECT products FROM facet_size) > ${sql.raw(String(facetLiveScopeLimit()))}
            GROUP BY scope_count.facet_kind, scope_count.facet_key, scope_count.value_key
            HAVING SUM(scope_count.product_count) > 0` : sql``}`;
    // Only values that can be shown (every count tie within the value cap, a
    // selected value, every value of a number attribute for its range) read
    // their label, order, number and sample SKU, from one row of the value in
    // the scope: the counting pass keeps its smallest owner, and a maintained
    // scope count its own sample product (every counted value has one). A row
    // of a product outside the scope advances only its own scopes' `lf:`
    // keys, never this listing's, so it cannot be the sample. The plain
    // shop-all page counts from the public counts, so its sample is the
    // value's first public row, found once per shown value (`facet_samples`
    // is materialized: a sample referenced four times is never looked up four
    // times). Point lookups by primary key only.
    // The value's first public product in id order (the value index's own
    // order, so the walk stops at the first public row), then that product's
    // smallest owner of the value.
    const firstPublicOwner = sql`(
                    SELECT MIN(sample_owner_row.owner_id) FROM product_facet_values AS sample_owner_row
                    WHERE sample_owner_row.facet_key = counted.facet_id AND sample_owner_row.value_key = counted.value_key
                      AND sample_owner_row.product_id = (
                        SELECT first_row.product_id FROM product_facet_values AS first_row
                        WHERE first_row.facet_key = counted.facet_id AND first_row.value_key = counted.value_key
                          AND EXISTS (SELECT 1 FROM product_buyer_state AS first_buyer
                            WHERE first_buyer.product_id = first_row.product_id AND first_buyer.is_public = 1)
                        ORDER BY first_row.product_id LIMIT 1
                      )
                )`;
    // A maintained scope count names its sample product (one of the scope's
    // own products with the value); that product's smallest owner of the
    // value is the sample row.
    const sampleProductOwner = sql`(
                    SELECT MIN(sample_owner_row.owner_id) FROM product_facet_values AS sample_owner_row
                    WHERE sample_owner_row.product_id = counted.sample_product
                      AND sample_owner_row.facet_key = counted.facet_id AND sample_owner_row.value_key = counted.value_key
                )`;
    const shownSamples = sql`
                SELECT counted.facet_kind, counted.facet_id, counted.value_key, counted.value_count,
                    ${input.allPublic ? firstPublicOwner : sql`COALESCE(counted.sample_owner, ${sampleProductOwner})`} AS sample_owner
                FROM (
                    SELECT value_counts.*, RANK() OVER (
                        PARTITION BY value_counts.facet_kind, value_counts.facet_id ORDER BY value_counts.value_count DESC
                    ) AS count_rank
                    FROM value_counts
                ) AS counted
                LEFT JOIN ${productAttributes} AS counted_attribute
                    ON counted.facet_kind = 'attribute' AND counted_attribute.id = counted.facet_id
                WHERE counted.count_rank <= ${sql.raw(String(valueLimit))} OR counted_attribute.value_type = 'number'
                   OR ${isSelectedValue(sql.raw("counted.facet_id"), sql.raw("counted.value_key"))}`;
    const shownValues = sql`
            SELECT shown.facet_kind, shown.facet_id, shown.value_key, shown.value_count,
                sample_row.value_label AS value_label, sample_row.sort_order AS value_sort,
                sample_row.value_number AS value_number, sample_row.variant_id AS sample_sku
            FROM facet_samples AS shown
            LEFT JOIN product_facet_values AS sample_row
                ON sample_row.owner_id = shown.sample_owner AND sample_row.facet_key = shown.facet_id
    `;
    const precomputedSummary = precomputed?.kind === "category" ? sql`
        SELECT (SELECT COALESCE(SUM(scope_count.product_count), 0) FROM ${scopeCountRows("'products'")}) AS listing_count,
            MIN(category_price.low) AS listing_min, MAX(category_price.high) AS listing_max
        FROM (
            SELECT (SELECT MIN(price_low.from_minor) FROM product_buyer_state AS price_low
                    WHERE price_low.is_public = 1 AND price_low.category_id = scope_category.id) AS low,
                (SELECT MAX(price_high.to_minor) FROM product_buyer_state AS price_high
                    WHERE price_high.is_public = 1 AND price_high.category_id = scope_category.id) AS high
            FROM categories AS scope_category WHERE scope_category.id IN ${precomputed.categoryIds}
        ) AS category_price` : precomputed ? sql`
        SELECT (SELECT COALESCE(SUM(scope_count.product_count), 0) FROM ${scopeCountRows("'products'")}) AS listing_count,
            (SELECT MIN(price_low.from_minor) FROM product_buyer_state AS price_low
                WHERE price_low.is_public = 1 AND price_low.brand_id = ${precomputed.brandId}) AS listing_min,
            (SELECT MAX(price_high.to_minor) FROM product_buyer_state AS price_high
                WHERE price_high.is_public = 1 AND price_high.brand_id = ${precomputed.brandId}) AS listing_max` : null;
    const scopeSummary = precomputedSummary ?? sql`
        SELECT COUNT(*) AS listing_count, MIN(listing_from_minor) AS listing_min, MAX(listing_to_minor) AS listing_max
        FROM facet_scope
        WHERE ${attributeMatch()} AND ${optionMatch} AND ${brandMatch}
          AND ${input.minRating === undefined ? sql`1 = 1`
                : productMinRatingCondition(sql`facet_scope.product_id`, input.minRating)}`;
    return namedRows<FacetResultRow>(db.all(sql`
        WITH facet_scope AS ${precomputed ? sql`NOT MATERIALIZED (
            SELECT NULL AS product_id, NULL AS brand_id, NULL AS category_id, '' AS attribute_miss, 1 AS option_match,
                1 AS brand_match, NULL AS rating_centi, 1 AS rating_match WHERE 0 = 1
        )` : input.allPublic ? sql`NOT MATERIALIZED (
            SELECT product_id, brand_id, category_id, '' AS attribute_miss, 1 AS option_match, 1 AS brand_match,
                NULL AS rating_centi, 1 AS rating_match
            FROM ${buyerState} WHERE ${publicBuyerStateCondition()}
        )` : sql`MATERIALIZED (${scopeQuery})`},
        facet_size AS (SELECT COUNT(*) AS products FROM facet_scope),
        value_counts AS (${valueCounts}),
        facet_samples AS MATERIALIZED (${shownSamples}),
        facet_counts AS (
            ${shownValues}
            ${brandBranch}${ratingBranch}${categoryBranch}
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
                CASE WHEN ${isSelectedValue(sql.raw("facet_counts.facet_id"), sql.raw("facet_counts.value_key"))}
                    THEN 1 ELSE 0 END AS is_selected
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
        )
        SELECT facet_kind AS facetKind, facet_id AS facetId, value_key AS valueKey,
            value_count AS valueCount, display_label AS valueLabel, display_sort AS valueSort,
            value_number AS valueNumber, facet_name AS facetName, facet_slug AS facetSlug,
            facet_display AS facetDisplay, facet_unit AS facetUnit, facet_order AS facetOrder,
            url_value AS urlValue, swatch, is_selected AS isSelected,
            CASE WHEN facet_kind = 'option' THEN (
                SELECT sample_variant.product_id FROM product_variants AS sample_variant
                WHERE sample_variant.id = facet_resolved.sample_sku
            ) END AS sampleProductId
            ${summary ? sql`, 'facet' AS recordType, NULL AS listingCount, NULL AS listingMin,
                NULL AS listingMax, NULL AS listingCurrency, NULL AS listingAncestors, NULL AS listingTheme` : sql``}
        FROM facet_resolved
        ${summary ? sql`
        UNION ALL
        SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            'summary', listing_count, listing_min, listing_max,
            ${storeCurrencyCodeSql()}, ${summary.categoryAncestors ?? sql`NULL`}, ${summary.cardFieldsTheme ?? sql`NULL`}
        FROM (${scopeSummary}) AS listing_summary` : sql``}
    `), [
        "facetKind", "facetId", "valueKey", "valueCount", "valueLabel", "valueSort", "valueNumber", "facetName",
        "facetSlug", "facetDisplay", "facetUnit", "facetOrder", "urlValue", "swatch", "isSelected",
        "sampleProductId",
        ...(summary ? ["recordType", "listingCount", "listingMin", "listingMax", "listingCurrency", "listingAncestors", "listingTheme"] as const : []),
    ]).then<FacetRead>((results) => {
        const summaryRow = results.find(row => row.recordType === "summary");
        const rows = rankFacetRows(results.filter(row => row.recordType !== "summary").map((row) => {
            const { recordType: _recordType, listingCount: _count, listingMin: _min, listingMax: _max,
                listingCurrency: _currency, listingAncestors: _ancestors, listingTheme: _theme, ...facet } = row;
            return facet;
        }), {
            attributeLimit: boundedLimit(input.attributeLimit, FACET_ATTRIBUTE_LIMIT),
            valueLimit,
            brandValueLimit,
        });
        return { rows, summary: summaryRow ? {
            count: Number(summaryRow.listingCount), min: summaryRow.listingMin ?? null,
            max: summaryRow.listingMax ?? null, storeCurrencyCode: summaryRow.listingCurrency ?? null,
            categoryAncestors: summaryRow.listingAncestors ?? null,
            cardFieldsTheme: summaryRow.listingTheme ?? null,
        } : null };
    });
}

/** SQLite's order: NULL first, then numbers, then text. */
function compareSql(left: unknown, right: unknown): number {
    if (left === right) return 0;
    if (left === null || left === undefined) return -1;
    if (right === null || right === undefined) return 1;
    if (typeof left === "number" && typeof right === "number") return left - right;
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The shown rows of the resolved facet values, ranked in JavaScript (a
 * window pass in SQL re-read every resolved row three times): per facet the
 * selected values, then the most common, then the value order and key;
 * every range facet's bounds over its counted values, as its one row; and
 * at most `attributeLimit` attribute facets, by facet order, name and id.
 */
function rankFacetRows(
    rows: readonly ResolvedFacetRow[],
    limits: { attributeLimit: number; valueLimit: number; brandValueLimit: number },
): CatalogFacetCountRow[] {
    const facets = new Map<string, ResolvedFacetRow[]>();
    for (const row of rows) {
        const key = `${row.facetKind}\u0000${row.facetId}`;
        const list = facets.get(key);
        if (list) list.push(row);
        else facets.set(key, [row]);
    }
    const attributeFacets = [...facets.values()]
        .filter((values) => values[0]!.facetKind === "attribute")
        .map((values) => values[0]!)
        .sort((left, right) => compareSql(left.facetOrder, right.facetOrder)
            || compareSql(left.facetName, right.facetName) || compareSql(left.facetId, right.facetId));
    const keptAttributes = new Set<string>();
    let rank = 0;
    let previous: ResolvedFacetRow | null = null;
    for (const facet of attributeFacets) {
        // DENSE_RANK: facets that tie on (order, name, id) share a rank.
        if (!previous || compareSql(previous.facetOrder, facet.facetOrder) || compareSql(previous.facetName, facet.facetName)
            || compareSql(previous.facetId, facet.facetId)) rank += 1;
        previous = facet;
        if (rank <= limits.attributeLimit) keptAttributes.add(facet.facetId);
    }
    const shown: CatalogFacetCountRow[] = [];
    for (const values of facets.values()) {
        const first = values[0]!;
        if (first.facetKind === "attribute" && !keptAttributes.has(first.facetId)) continue;
        const counted = values.filter((value) => Number(value.valueCount) > 0 && value.valueNumber !== null && value.valueNumber !== undefined)
            .map((value) => Number(value.valueNumber));
        const rangeMin = counted.length > 0 ? Math.min(...counted) : null;
        const rangeMax = counted.length > 0 ? Math.max(...counted) : null;
        const ordered = [...values].sort((left, right) => compareSql(Number(Boolean(right.isSelected)), Number(Boolean(left.isSelected)))
            || compareSql(Number(right.valueCount), Number(left.valueCount))
            || compareSql(left.valueSort, right.valueSort) || compareSql(left.valueKey, right.valueKey));
        const cap = first.facetKind === "brand" ? limits.brandValueLimit : limits.valueLimit;
        ordered.forEach((value, index) => {
            const valueRank = index + 1;
            if (!(valueRank <= cap || Boolean(value.isSelected))) return;
            if (value.facetDisplay === "range" && valueRank !== 1) return;
            const { isSelected: _isSelected, ...row } = value;
            shown.push({ ...row, rangeMin, rangeMax });
        });
    }
    return shown;
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
    // Counts change with the scope's facet rows and with its membership
    // (whatever order a refresh writes them in); the subtree with which
    // descendants are published.
    deps.listFacets(categoryScope(categoryId));
    deps.listMembership(categoryScope(categoryId));
    deps.anyCategory();
    const rows = await buildCatalogFacetCountQuery(db, {
        baseConditions: [publicBuyerStateCondition(), publicCategorySubtreeCondition(buyerState.categoryId, categoryId)],
        needsProducts: false,
        filters: [],
        categoryId,
        ...DEFINITION_FACET_LIMITS,
    });
    declareFacetReadWithoutProducts(rows);
    return { facets: groupCatalogFacets(rows) };
}

/** The facets of a search's public hits (optionally inside a category, by slug or id). */
export async function getPublicSearchFacets(
    db: Database,
    search: string,
    category?: string,
): Promise<{ facets: PublicProductFacet[] }> {
    deps.listFacets("all");
    deps.listMembership("all");
    deps.search();
    deps.anyCategory();
    const { conditions, needsProducts } = buildStorefrontBuyerStateConditions(db, { search, category });
    const rows = await buildCatalogFacetCountQuery(db, {
        baseConditions: conditions,
        needsProducts,
        filters: [],
        ...DEFINITION_FACET_LIMITS,
    });
    declareFacetReadWithoutProducts(rows);
    return { facets: groupCatalogFacets(rows) };
}
