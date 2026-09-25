// Listing filters and result-scoped facet counts (attributes and option axes).
import {
    products,
    productVariants,
    productAttributeValues,
    productAttributes,
    productOptionDefinitions,
    productOptionValues,
    productVariantOptionValues,
} from "@scalius/database/schema";
import { alias } from "drizzle-orm/sqlite-core";
import { normalizeProductOptionIdentity } from "@scalius/shared/product-options";
import { and, sql, eq, isNull, type SQL } from "drizzle-orm";
import type { StorefrontProductFilterInput } from "../products/types";
import type { Database } from "@scalius/database/client";
import type { buyerState } from "./buyer-state";

/** The public set a facet count joins: the stored buyer state (catalog/buyer-state.ts). */
type PublicBuyerSet = typeof buyerState;

type AttributeFilter = NonNullable<StorefrontProductFilterInput["attributeFilters"]>[number];

export function buildAttributeProductSubquery(
    db: Database,
    attributeFilters: AttributeFilter[],
    alias: string,
) {
    if (attributeFilters.length === 0) return null;
    const filtersJson = JSON.stringify(attributeFilters);
    return db
        .select({ productId: productAttributeValues.productId })
        .from(productAttributeValues)
        .innerJoin(productAttributes, eq(productAttributeValues.attributeId, productAttributes.id))
        .where(
            and(
                eq(productAttributes.filterable, true),
                isNull(productAttributes.deletedAt),
                sql`EXISTS (
                    SELECT 1
                    FROM json_each(${filtersJson}) AS selected_filter
                    CROSS JOIN json_each(json_extract(selected_filter.value, '$.values')) AS selected_value
                    WHERE CAST(json_extract(selected_filter.value, '$.slug') AS TEXT) = ${productAttributes.slug}
                      AND CAST(selected_value.value AS TEXT) = ${productAttributeValues.value}
                )`,
            ),
        )
        .groupBy(productAttributeValues.productId)
        .having(sql`count(*) = ${attributeFilters.length}`)
        .as(alias);
}

export interface PublicProductFacetValue {
    value: string;
    count: number;
}

export interface PublicProductFacet {
    id: string;
    name: string;
    slug: string;
    values: PublicProductFacetValue[];
}

export type PublicProductFacetRow = {
    id: string;
    name: string;
    slug: string;
    value: string;
    count: number;
    position?: number;
};

/** URL/facet key prefix for merchant option axes, e.g. `option.size`. */
export const OPTION_FACET_PREFIX = "option.";

export function isOptionFilter(filter: AttributeFilter): boolean {
    return filter.slug.startsWith(OPTION_FACET_PREFIX);
}

// Option axes are merchant-defined per product; products share a facet when
// their axis names normalize to the same key ("Size", " size " → `option.size`).
const OPTION_AXIS_KEY_SQL = (axis: string) => sql.raw(`replace(${axis}.normalized_name, ' ', '-')`);

/**
 * The SKU carries one of the selected values on every selected option axis
 * (OR within an axis, AND across axes). Matching one SKU, not the product,
 * keeps "Chalk + 42" to products that sell a Chalk 42 (Shopify's variant
 * filtering). `exceptAxis` skips the axis whose own facet counts are being
 * computed.
 */
function skuMatchesOptionFilters(optionFilters: AttributeFilter[], skuId: SQL, exceptAxis?: SQL): SQL {
    const filtersJson = JSON.stringify(optionFilters.map((filter) => ({
        key: filter.slug.slice(OPTION_FACET_PREFIX.length),
        values: filter.values.map(normalizeProductOptionIdentity),
    })));
    return sql`NOT EXISTS (
        SELECT 1
        FROM json_each(${filtersJson}) AS selected_option
        WHERE ${exceptAxis ? sql`CAST(json_extract(selected_option.value, '$.key') AS TEXT) <> ${exceptAxis} AND ` : sql``}NOT EXISTS (
            SELECT 1
            FROM product_variant_option_values AS option_filter_assignment
            INNER JOIN product_option_definitions AS option_filter_axis
                ON option_filter_axis.id = option_filter_assignment.option_definition_id
               AND option_filter_axis.deleted_at IS NULL
            INNER JOIN product_option_values AS option_filter_value
                ON option_filter_value.id = option_filter_assignment.option_value_id
               AND option_filter_value.deleted_at IS NULL
            WHERE option_filter_assignment.variant_id = ${skuId}
              AND ${OPTION_AXIS_KEY_SQL("option_filter_axis")} = CAST(json_extract(selected_option.value, '$.key') AS TEXT)
              AND option_filter_value.normalized_value IN (
                  SELECT CAST(value AS TEXT)
                  FROM json_each(json_extract(selected_option.value, '$.values'))
              )
        )
    )`;
}

/** Products with a live SKU that matches every selected option axis. */
export function buildOptionFilterCondition(optionFilters: AttributeFilter[]): SQL | undefined {
    if (optionFilters.length === 0) return undefined;
    return sql`EXISTS (
        SELECT 1
        FROM product_variants AS option_filter_sku
        WHERE option_filter_sku.product_id = ${products.id}
          AND option_filter_sku.deleted_at IS NULL
          AND ${skuMatchesOptionFilters(optionFilters, sql.raw("option_filter_sku.id"))}
    )`;
}

export function buildResultScopedOptionFacetQuery(
    db: Database,
    publicSet: PublicBuyerSet,
    baseConditions: SQL[],
    attributeFilters: AttributeFilter[],
    optionFilters: AttributeFilter[],
) {
    const facetSku = alias(productVariants, "facet_option_sku");
    const facetAssignment = alias(productVariantOptionValues, "facet_option_assignment");
    const facetAxis = alias(productOptionDefinitions, "facet_option_axis");
    const facetValue = alias(productOptionValues, "facet_option_value");
    const axisKey = OPTION_AXIS_KEY_SQL("facet_option_axis");
    // A value counts products whose SKU with that value also matches the
    // other selected axes and attributes, so every offered value leads to a
    // real product. Values that match nothing stay listed with a zero count.
    const attributeSubquery = buildAttributeProductSubquery(db, attributeFilters, "option_facet_filtered_products");
    const matchesOtherSelectedAxes = and(
        optionFilters.length > 0 ? skuMatchesOptionFilters(optionFilters, sql`${facetSku.id}`, axisKey) : undefined,
        attributeSubquery ? sql`${attributeSubquery.productId} IS NOT NULL` : undefined,
    ) ?? sql`1 = 1`;
    let query = db
        .select({
            id: sql<string>`${OPTION_FACET_PREFIX} || ${axisKey}`,
            name: sql<string>`MIN(${facetAxis.name})`,
            slug: sql<string>`${OPTION_FACET_PREFIX} || ${axisKey}`,
            value: sql<string>`MIN(${facetValue.value})`,
            position: sql<number>`MIN(${facetValue.position})`,
            count: sql<number>`COUNT(DISTINCT CASE
                WHEN ${matchesOtherSelectedAxes} THEN ${products.id}
                ELSE NULL
            END)`,
        })
        .from(products)
        .innerJoin(publicSet, eq(publicSet.productId, products.id))
        .innerJoin(facetSku, and(eq(facetSku.productId, products.id), isNull(facetSku.deletedAt)))
        .innerJoin(facetAssignment, eq(facetAssignment.variantId, facetSku.id))
        .innerJoin(facetAxis, and(
            eq(facetAxis.id, facetAssignment.optionDefinitionId),
            isNull(facetAxis.deletedAt),
        ))
        .innerJoin(facetValue, and(
            eq(facetValue.id, facetAssignment.optionValueId),
            isNull(facetValue.deletedAt),
        ))
        .where(and(...baseConditions))
        .groupBy(axisKey, facetValue.normalizedValue)
        .$dynamic();
    if (attributeSubquery) {
        query = query.leftJoin(attributeSubquery, eq(products.id, attributeSubquery.productId));
    }
    return query;
}

export function buildResultScopedFacetQuery(
    db: Database,
    publicSet: PublicBuyerSet,
    baseConditions: SQL[],
    attributeFilters: AttributeFilter[],
    optionCondition: SQL | undefined,
) {
    const filtersJson = JSON.stringify(attributeFilters);
    const matchesOtherSelectedAttributes = sql`NOT EXISTS (
        SELECT 1
        FROM json_each(${filtersJson}) AS selected_filter
        WHERE CAST(json_extract(selected_filter.value, '$.slug') AS TEXT) <> ${productAttributes.slug}
          AND NOT EXISTS (
              SELECT 1
              FROM product_attribute_values AS selected_product_value
              INNER JOIN product_attributes AS selected_product_attribute
                  ON selected_product_attribute.id = selected_product_value.attribute_id
              WHERE selected_product_value.product_id = ${products.id}
                AND selected_product_attribute.deleted_at IS NULL
                AND selected_product_attribute.filterable = 1
                AND selected_product_attribute.slug = CAST(json_extract(selected_filter.value, '$.slug') AS TEXT)
                AND selected_product_value.value IN (
                    SELECT CAST(value AS TEXT)
                    FROM json_each(json_extract(selected_filter.value, '$.values'))
                )
          )
    )`;
    const matchesOtherSelectedFacets = optionCondition
        ? sql`${matchesOtherSelectedAttributes} AND ${optionCondition}`
        : matchesOtherSelectedAttributes;

    return db
        .select({
            id: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
            value: productAttributeValues.value,
            count: sql<number>`COUNT(DISTINCT CASE
                WHEN ${matchesOtherSelectedFacets} THEN ${products.id}
                ELSE NULL
            END)`,
        })
        .from(productAttributeValues)
        .innerJoin(
            productAttributes,
            eq(productAttributeValues.attributeId, productAttributes.id),
        )
        .innerJoin(products, eq(productAttributeValues.productId, products.id))
        .innerJoin(publicSet, eq(publicSet.productId, products.id))
        .where(and(
            eq(productAttributes.filterable, true),
            isNull(productAttributes.deletedAt),
            ...baseConditions,
        ))
        .groupBy(
            productAttributes.id,
            productAttributes.name,
            productAttributes.slug,
            productAttributeValues.value,
        )
        .orderBy(productAttributes.name, productAttributeValues.value);
}

export function groupResultScopedFacets(
    rows: PublicProductFacetRow[],
    selectedFilters: AttributeFilter[],
): PublicProductFacet[] {
    const facetsBySlug = new Map<string, PublicProductFacet>();
    const positions = new Map<string, number>();
    for (const row of rows) {
        positions.set(row.value, Number(row.position) || 0);
        const facet = facetsBySlug.get(row.slug) ?? {
            id: row.id,
            name: row.name,
            slug: row.slug,
            values: [],
        };
        facet.values.push({ value: row.value, count: Number(row.count) || 0 });
        facetsBySlug.set(row.slug, facet);
    }

    for (const selected of selectedFilters) {
        const facet = facetsBySlug.get(selected.slug) ?? {
            id: selected.id,
            name: selected.name,
            slug: selected.slug,
            values: [],
        };
        const knownValues = new Set(facet.values.map(({ value }) => value));
        for (const value of selected.values) {
            if (!knownValues.has(value)) facet.values.push({ value, count: 0 });
        }
        facetsBySlug.set(selected.slug, facet);
    }

    return Array.from(facetsBySlug.values())
        .map(({ id, name, slug, values }) => ({
            id,
            name,
            slug,
            values: values
                .sort((a, b) => (positions.get(a.value) ?? 0) - (positions.get(b.value) ?? 0)
                    || a.value.localeCompare(b.value, undefined, { numeric: true }))
                .map(({ value, count }) => ({ value, count })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
