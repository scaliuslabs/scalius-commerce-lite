// src/modules/attributes/attributes.public.ts
// Public/storefront attribute queries for use by API routes.

import { productAttributes, productAttributeValues, products } from "@scalius/database/schema";
import { eq, and, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { publicProductHasBuyerResolvableSku } from "../products/products.public-eligibility";
import { ValidationError } from "@scalius/core/errors";
import { ftsMatch } from "../../search/fts5";

export interface PublicAttributeFilter {
    id: string;
    name: string;
    slug: string;
    values: string[];
}

export interface PublicAttributeQueryFilter {
    id: string;
    name: string;
    slug: string;
    values: string[];
}

const MAX_PUBLIC_ATTRIBUTE_FILTER_VALUES = 90;
export const PUBLIC_ATTRIBUTE_FACET_ATTRIBUTE_LIMIT = 50;
export const PUBLIC_ATTRIBUTE_FACET_VALUE_LIMIT = 100;
export const PUBLIC_ATTRIBUTE_FACET_ROW_LIMIT = 2_000;

type PublicQueryValues = Record<string, string | string[]>;

/**
 * Resolves attribute filters from raw public query parameters.
 * Route schemas own the standard query keys; any remaining key that matches a
 * known product attribute slug is treated as an attribute filter.
 */
export async function resolvePublicAttributeFilters(
    db: Database,
    queryParams: PublicQueryValues,
    standardQueryKeys: Iterable<string>,
): Promise<PublicAttributeQueryFilter[]> {
    const knownKeys = new Set(standardQueryKeys);
    const requestedFilters = Object.entries(queryParams)
        .filter(([key]) => !knownKeys.has(key))
        .map(([slug, rawValues]) => ({
            slug: slug.trim(),
            values: Array.from(new Set(
                (Array.isArray(rawValues) ? rawValues : [rawValues])
                    .map((value) => value.trim())
                    .filter(Boolean),
            )),
        }))
        .filter((filter) => filter.slug && filter.values.length > 0);

    if (requestedFilters.length === 0) return [];
    const requestedValueCount = requestedFilters.reduce(
        (total, filter) => total + filter.values.length,
        0,
    );
    if (requestedValueCount > MAX_PUBLIC_ATTRIBUTE_FILTER_VALUES) {
        throw new ValidationError(
            `At most ${MAX_PUBLIC_ATTRIBUTE_FILTER_VALUES} attribute filter values are allowed.`,
        );
    }

    const requestedJson = JSON.stringify(requestedFilters);
    const matchedValues = await db
        .selectDistinct({
            id: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
            value: productAttributeValues.value,
        })
        .from(productAttributes)
        .innerJoin(
            productAttributeValues,
            eq(productAttributeValues.attributeId, productAttributes.id),
        )
        .innerJoin(
            products,
            and(
                eq(productAttributeValues.productId, products.id),
                eq(products.isActive, true),
                isNull(products.deletedAt),
                publicProductHasBuyerResolvableSku(),
            ),
        )
        .where(and(
            eq(productAttributes.filterable, true),
            isNull(productAttributes.deletedAt),
            sql`EXISTS (
                SELECT 1
                FROM json_each(${requestedJson}) AS requested_filter
                CROSS JOIN json_each(json_extract(requested_filter.value, '$.values')) AS requested_value
                WHERE CAST(json_extract(requested_filter.value, '$.slug') AS TEXT) = ${productAttributes.slug}
                  AND CAST(requested_value.value AS TEXT) = ${productAttributeValues.value}
            )`,
        ));

    const matchedBySlug = new Map<string, PublicAttributeQueryFilter>();
    for (const row of matchedValues) {
        const filter = matchedBySlug.get(row.slug) ?? {
            id: row.id,
            name: row.name,
            slug: row.slug,
            values: [],
        };
        filter.values.push(row.value);
        matchedBySlug.set(row.slug, filter);
    }

    return requestedFilters
        .map((requested) => {
            const matched = matchedBySlug.get(requested.slug);
            if (!matched) return null;
            const available = new Set(matched.values);
            const values = requested.values.filter((value) => available.has(value));
            return values.length > 0 ? { ...matched, values } : null;
        })
        .filter((filter): filter is PublicAttributeQueryFilter => filter !== null);
}

/**
 * Returns all filterable attributes with their distinct values.
 * Used for the global filter sidebar.
 */
export async function getPublicFilterableAttributes(db: Database): Promise<{ filters: PublicAttributeFilter[] }> {
    const filterableAttributes = await db
        .select({
            id: productAttributes.id,
            name: productAttributes.name,
            slug: productAttributes.slug,
        })
        .from(productAttributes)
        .where(
            and(
                eq(productAttributes.filterable, true),
                isNull(productAttributes.deletedAt),
            ),
        )
        .orderBy(productAttributes.id)
        .limit(PUBLIC_ATTRIBUTE_FACET_ATTRIBUTE_LIMIT);

    if (filterableAttributes.length === 0) {
        return { filters: [] };
    }

    const attributeIdsJson = JSON.stringify(filterableAttributes.map((attr) => attr.id));
    const uniqueValues = await db
        .selectDistinct({
            attributeId: productAttributeValues.attributeId,
            value: productAttributeValues.value,
        })
        .from(productAttributeValues)
        .innerJoin(
            products,
            and(
                eq(productAttributeValues.productId, products.id),
                eq(products.isActive, true),
                isNull(products.deletedAt),
                publicProductHasBuyerResolvableSku(),
            ),
        )
        .where(sql`${productAttributeValues.attributeId} IN (
            SELECT CAST(value AS TEXT) FROM json_each(${attributeIdsJson})
        )`)
        .orderBy(productAttributeValues.attributeId, productAttributeValues.value)
        .limit(PUBLIC_ATTRIBUTE_FACET_ROW_LIMIT);

    const filters = filterableAttributes
        .map((attr) => ({
            id: attr.id,
            name: attr.name,
            slug: attr.slug,
            values: uniqueValues
                .filter((uv) => uv.attributeId === attr.id)
                .map((uv) => uv.value)
                .sort(),
        }))
        .filter((filter) => filter.values.length > 0);

    return { filters };
}

/**
 * Returns filterable attributes scoped to a specific category (by ID).
 * Only includes attributes that have values on active products in the category.
 */
export async function getPublicAttributesByCategory(
    db: Database,
    categoryId: string,
): Promise<{ filters: PublicAttributeFilter[] }> {
    const categoryAttributes = await db
        .selectDistinct({
            attributeId: productAttributeValues.attributeId,
            attributeName: productAttributes.name,
            attributeSlug: productAttributes.slug,
            value: productAttributeValues.value,
        })
        .from(productAttributeValues)
        .innerJoin(
            productAttributes,
            and(
                eq(productAttributeValues.attributeId, productAttributes.id),
                eq(productAttributes.filterable, true),
                isNull(productAttributes.deletedAt),
            ),
        )
        .innerJoin(
            products,
            and(
                eq(productAttributeValues.productId, products.id),
                eq(products.categoryId, categoryId),
                eq(products.isActive, true),
                isNull(products.deletedAt),
                publicProductHasBuyerResolvableSku(),
            ),
        )
        .orderBy(productAttributeValues.attributeId, productAttributeValues.value)
        .limit(PUBLIC_ATTRIBUTE_FACET_ROW_LIMIT);

    return { filters: groupAttributeValues(categoryAttributes) };
}

/**
 * Returns filterable attributes scoped to a set of product IDs.
 * Used for search results filtering.
 */
export async function getPublicAttributesByProductIds(
    db: Database,
    productIds: string[],
): Promise<{ filters: PublicAttributeFilter[] }> {
    if (productIds.length === 0) return { filters: [] };

    const productIdsJson = JSON.stringify([...new Set(productIds)]);
    const attrs = await db
        .selectDistinct({
            attributeId: productAttributeValues.attributeId,
            attributeName: productAttributes.name,
            attributeSlug: productAttributes.slug,
            value: productAttributeValues.value,
        })
        .from(productAttributeValues)
        .innerJoin(
            productAttributes,
            and(
                eq(productAttributeValues.attributeId, productAttributes.id),
                eq(productAttributes.filterable, true),
                isNull(productAttributes.deletedAt),
            ),
        )
        .innerJoin(
            products,
            and(
                eq(productAttributeValues.productId, products.id),
                eq(products.isActive, true),
                isNull(products.deletedAt),
                publicProductHasBuyerResolvableSku(),
            ),
        )
        .where(sql`${productAttributeValues.productId} IN (
            SELECT CAST(value AS TEXT) FROM json_each(${productIdsJson})
        )`)
        .orderBy(productAttributeValues.attributeId, productAttributeValues.value)
        .limit(PUBLIC_ATTRIBUTE_FACET_ROW_LIMIT);

    return { filters: groupAttributeValues(attrs) };
}

/**
 * Returns facets from the exact buyer-visible product set matched by search.
 * This deliberately keeps the FTS predicate in the attribute query: expanding
 * from matching category IDs would advertise values that produce zero results.
 */
export async function getPublicAttributesForSearch(
    db: Database,
    search: string,
    categoryId?: string,
): Promise<{ filters: PublicAttributeFilter[] }> {
    const searchCondition = ftsMatch(db, "products_fts", "products", search);
    if (!searchCondition) return { filters: [] };

    const productConditions: SQL[] = [
        eq(products.isActive, true),
        isNull(products.deletedAt),
        publicProductHasBuyerResolvableSku(),
        searchCondition,
    ];
    if (categoryId) productConditions.push(eq(products.categoryId, categoryId));

    const attrs = await db
        .selectDistinct({
            attributeId: productAttributeValues.attributeId,
            attributeName: productAttributes.name,
            attributeSlug: productAttributes.slug,
            value: productAttributeValues.value,
        })
        .from(productAttributeValues)
        .innerJoin(
            productAttributes,
            and(
                eq(productAttributeValues.attributeId, productAttributes.id),
                eq(productAttributes.filterable, true),
                isNull(productAttributes.deletedAt),
            ),
        )
        .innerJoin(
            products,
            and(
                eq(productAttributeValues.productId, products.id),
                ...productConditions,
            ),
        )
        .orderBy(productAttributeValues.attributeId, productAttributeValues.value)
        .limit(PUBLIC_ATTRIBUTE_FACET_ROW_LIMIT);

    return { filters: groupAttributeValues(attrs) };
}

// ─────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────

function groupAttributeValues(
    rows: { attributeId: string; attributeName: string; attributeSlug: string; value: string }[],
): PublicAttributeFilter[] {
    const attributeMap = new Map<string, { id: string; name: string; slug: string; values: Set<string> }>();

    for (const item of rows) {
        if (!attributeMap.has(item.attributeId)) {
            if (attributeMap.size >= PUBLIC_ATTRIBUTE_FACET_ATTRIBUTE_LIMIT) continue;
            attributeMap.set(item.attributeId, {
                id: item.attributeId,
                name: item.attributeName,
                slug: item.attributeSlug,
                values: new Set(),
            });
        }
        const values = attributeMap.get(item.attributeId)!.values;
        if (values.size < PUBLIC_ATTRIBUTE_FACET_VALUE_LIMIT) values.add(item.value);
    }

    return Array.from(attributeMap.values()).map((attr) => ({
        id: attr.id,
        name: attr.name,
        slug: attr.slug,
        values: Array.from(attr.values).sort(),
    }));
}
