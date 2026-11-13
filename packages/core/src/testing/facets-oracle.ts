// Test-only: a narrowed listing's facet counts as the one statement they were
// before they became one pass over the scope (SQLite 3.54.1 refused it: its
// scope CTE expanded seven times, 197 cursors with a price filter). The
// live-scope branch of catalogFacetCountRows, frozen with its helpers and its
// JavaScript ranking, as the oracle of facets-live.oracle.d1.test.ts; never
// call it elsewhere.
import { brands, productAttributes, attributeValues } from "@scalius/database/schema";
import { and, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { REVIEW_RATING_FACET_STARS } from "@scalius/shared/reviews";
import type { CatalogFacetFilter } from "../modules/products";
import { buyerState } from "../modules/catalog/buyer-state";
import { productMinRatingCondition, reviewStats } from "../modules/catalog/shared";
import { reviewsEnabledSql, storeCurrencyCodeSql } from "../modules/settings";
import {
    BRAND_FACET_KEY,
    BRAND_FACET_VALUE_LIMIT,
    CATEGORY_FACET_KEY,
    FACET_ATTRIBUTE_LIMIT,
    FACET_VALUE_LIMIT,
    OPTION_FACET_PREFIX,
    facetLiveScopeLimit,
    type CatalogFacetCountInput,
    type CatalogFacetCountRow,
    type CatalogListingSummary,
} from "../modules/catalog/facets";

const OPEN_RANGE = 1e15;

type ListingSummaryInput = { categoryAncestors?: SQL<string | null>; cardFieldsTheme?: SQL<string | null> };
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

function boundedLimit(value: number | undefined, max: number): number {
    return Math.min(Math.max(Math.trunc(value ?? max), 1), max);
}

async function namedRows<T extends Record<string, unknown>>(rows: Promise<unknown[]>, columns: ReadonlyArray<keyof T & string>): Promise<T[]> {
    return (await rows).map((row) => Array.isArray(row)
        ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) as T
        : row as T);
}

function jsonTextSet(values: readonly string[]): SQL {
    return sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(values)}))`;
}

function productAttributeMissSql(product: SQL, filters: readonly CatalogFacetFilter[]): SQL {
    const discrete = filters.filter((filter) => filter.keys.length > 0).map((filter) => ({ key: filter.id, keys: filter.keys }));
    const ranges = filters.filter((filter) => filter.range).map((filter) => ({
        key: filter.id, min: filter.range!.min ?? -OPEN_RANGE, max: filter.range!.max ?? OPEN_RANGE,
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

/** The frozen statement: a narrowed scope (never `precomputed` or `allPublic`), with its summary when asked. */
export async function oracleLiveCatalogFacets(
    db: Database, input: CatalogFacetCountInput, summary?: ListingSummaryInput,
): Promise<{ rows: CatalogFacetCountRow[]; summary: CatalogListingSummary | null }> {
    if (input.precomputed || input.allPublic) throw new Error("The facet oracle covers the live scope only.");
    const sets = {
        attributes: (input.filters ?? []).filter((filter) => filter.kind === "attribute"),
        options: (input.filters ?? []).filter((filter) => filter.kind === "option" && filter.keys.length > 0),
        brand: (input.filters ?? []).find((filter) => filter.kind === "brand" && filter.keys.length > 0),
    };
    const minRatingCenti = input.minRating === undefined ? undefined : input.minRating * 100;
    const readsRating = Boolean(input.ratingFacet) || minRatingCenti !== undefined;
    const ratingMatch = minRatingCenti === undefined ? sql`` : sql` AND facet_scope.rating_match = 1`;
    const truth = (condition: SQL | undefined) => condition ?? sql`1 = 1`;
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
    const scopeFrom = readsRating
        ? sql`${scopeProducts} LEFT JOIN ${reviewStats} AS facet_rating ON facet_rating.product_id = ${buyerState.productId} AND ${reviewsEnabledSql()} = 1`
        : scopeProducts;
    const scopeQuery = sql`
        SELECT ${buyerState.productId} AS product_id, ${buyerState.brandId} AS brand_id,
            ${buyerState.categoryId} AS category_id,
            ${productAttributeMissSql(scopeProduct, sets.attributes)} AS attribute_miss,
            CASE WHEN ${truth(productMatchesOptionFilters(scopeProduct, sets.options))} THEN 1 ELSE 0 END AS option_match,
            CASE WHEN ${truth(sets.brand ? sql`${buyerState.brandId} IN ${jsonTextSet(sets.brand.keys)}` : undefined)} THEN 1 ELSE 0 END AS brand_match,
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
    const countScope = input.fallbackCounts;
    const scopeCountRows = (kinds: string) => countScope?.kind === "category"
        ? sql`product_facet_scope_counts AS scope_count
            WHERE scope_count.scope_kind = 'category' AND scope_count.scope_id IN ${countScope.categoryIds}
              AND scope_count.facet_kind IN (${sql.raw(kinds)})`
        : sql`product_facet_scope_counts AS scope_count
            WHERE scope_count.scope_kind = 'brand' AND scope_count.scope_id = ${countScope?.kind === "brand" ? countScope.brandId : ""}
              AND scope_count.facet_kind IN (${sql.raw(kinds)})`;
    const brandBranch = input.brandFacet === false ? sql`` : sql`
            UNION ALL
            SELECT 'brand', 'brand', facet_scope.brand_id,
                SUM(CASE WHEN ${attributeMatch()} AND ${optionMatch}${ratingMatch} THEN 1 ELSE 0 END),
                NULL, NULL, NULL, NULL
            FROM facet_scope
            WHERE facet_scope.brand_id IS NOT NULL
            GROUP BY facet_scope.brand_id`;
    const ratingStars = [...new Set<number>([
        ...REVIEW_RATING_FACET_STARS,
        ...(input.minRating === undefined ? [] : [input.minRating]),
    ])];
    const ratingCounts = ratingStars.map((stars, index) => sql`
        SUM(CASE WHEN facet_scope.rating_centi >= ${stars * 100}
            AND ${attributeMatch()} AND ${optionMatch} AND ${brandMatch} THEN 1 ELSE 0 END)
            AS ${sql.raw(`rating_count_${index}`)}`);
    const ratingValueCount = sql`CASE CAST(rating_min.key AS INTEGER)
                    ${sql.join(ratingStars.map((_, index) => sql`
                        WHEN ${sql.raw(String(index))} THEN rating_counts.${sql.raw(`rating_count_${index}`)}`), sql` `)}
                END`;
    const ratingBranch = input.ratingFacet ? sql`
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
            WHERE rating_counts.rated_count > 0` : sql``;
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
            INNER JOIN category_closure AS child_link ON child_link.descendant_id = facet_scope.category_id
            WHERE child_link.ancestor_id IN (
                  SELECT listing_child.descendant_id FROM category_closure AS listing_child
                  WHERE listing_child.ancestor_id = ${input.categoryFacet.parentId} AND listing_child.depth = 1
              )
            GROUP BY child_link.ancestor_id`;
    const isSelectedValue = (facetId: SQL, valueKey: SQL) => sql`EXISTS (
        SELECT 1 FROM json_each(${selected}) AS facet_selected
        WHERE CAST(json_extract(facet_selected.value, '$.id') AS TEXT) = ${facetId}
          AND ${valueKey} IN (SELECT CAST(value AS TEXT) FROM json_each(json_extract(facet_selected.value, '$.keys')))
    )`;
    const skuMatch = sets.options.length > 0
        ? skuMatchesOptionFilters(sql.raw("facet_row.variant_id"), sets.options, sql.raw("facet_row.facet_key"))
        : undefined;
    const valueCounts = sql`
            SELECT CASE WHEN facet_row.variant_id IS NULL THEN 'attribute' ELSE 'option' END AS facet_kind,
                facet_row.facet_key AS facet_id, facet_row.value_key AS value_key,
                CASE WHEN facet_row.variant_id IS NULL
                    THEN SUM(CASE WHEN ${attributeMatch(sql.raw("facet_row.facet_key"))} AND ${optionMatch} AND ${brandMatch}${ratingMatch} THEN 1 ELSE 0 END)
                    ELSE COUNT(DISTINCT CASE
                        WHEN ${truth(skuMatch)}
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
    const sampleProductOwner = sql`(
                    SELECT MIN(sample_owner_row.owner_id) FROM product_facet_values AS sample_owner_row
                    WHERE sample_owner_row.product_id = counted.sample_product
                      AND sample_owner_row.facet_key = counted.facet_id AND sample_owner_row.value_key = counted.value_key
                )`;
    const shownSamples = sql`
                SELECT counted.facet_kind, counted.facet_id, counted.value_key, counted.value_count,
                    COALESCE(counted.sample_owner, ${sampleProductOwner}) AS sample_owner
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
    const scopeSummary = sql`
        SELECT COUNT(*) AS listing_count, MIN(listing_from_minor) AS listing_min, MAX(listing_to_minor) AS listing_max
        FROM facet_scope
        WHERE ${attributeMatch()} AND ${optionMatch} AND ${brandMatch}
          AND ${input.minRating === undefined ? sql`1 = 1`
                : productMinRatingCondition(sql`facet_scope.product_id`, input.minRating)}`;
    const results = await namedRows<FacetResultRow>(db.all(sql`
        WITH facet_scope AS MATERIALIZED (${scopeQuery}),
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
    ]);
    const summaryRow = results.find((row) => row.recordType === "summary");
    const rows = rankFacetRows(results.filter((row) => row.recordType !== "summary").map((row) => {
        const { recordType: _recordType, listingCount: _count, listingMin: _min, listingMax: _max,
            listingCurrency: _currency, listingAncestors: _ancestors, listingTheme: _theme, ...facet } = row;
        return facet;
    }), {
        attributeLimit: boundedLimit(input.attributeLimit, FACET_ATTRIBUTE_LIMIT),
        valueLimit,
        brandValueLimit,
    });
    return {
        rows,
        summary: summaryRow ? {
            count: Number(summaryRow.listingCount), min: summaryRow.listingMin ?? null,
            max: summaryRow.listingMax ?? null, storeCurrencyCode: summaryRow.listingCurrency ?? null,
            categoryAncestors: summaryRow.listingAncestors ?? null,
            cardFieldsTheme: summaryRow.listingTheme ?? null,
        } : null,
    };
}
