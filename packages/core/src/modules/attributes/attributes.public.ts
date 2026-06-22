// src/modules/attributes/attributes.public.ts
// Public/storefront attribute queries for use by API routes.

import { productAttributes, productAttributeValues, products } from "@scalius/database/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { publicProductHasBuyerResolvableSku } from "../products/products.public-eligibility";

export interface PublicAttributeFilter {
    id: string;
    name: string;
    slug: string;
    values: string[];
}

export interface PublicAttributeQueryFilter {
    slug: string;
    value: string;
}

/**
 * Resolves attribute filters from raw public query parameters.
 * Route schemas own the standard query keys; any remaining key that matches a
 * known product attribute slug is treated as an attribute filter.
 */
export async function resolvePublicAttributeFilters(
    db: Database,
    queryParams: Record<string, string>,
    standardQueryKeys: Iterable<string>,
): Promise<PublicAttributeQueryFilter[]> {
    const knownKeys = new Set(standardQueryKeys);
    const potentialAttributeKeys = Object.keys(queryParams).filter(
        (key) => !knownKeys.has(key) && queryParams[key],
    );

    if (potentialAttributeKeys.length === 0) return [];

    const attributes = await db
        .select({ slug: productAttributes.slug })
        .from(productAttributes)
        .where(inArray(productAttributes.slug, potentialAttributeKeys));

    const validSlugs = new Set(attributes.map((attribute) => attribute.slug));
    return potentialAttributeKeys
        .filter((key) => validSlugs.has(key))
        .map((key) => ({ slug: key, value: queryParams[key] ?? "" }));
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
        );

    if (filterableAttributes.length === 0) {
        return { filters: [] };
    }

    const attributeIds = filterableAttributes.map((attr) => attr.id);
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
        .where(inArray(productAttributeValues.attributeId, attributeIds));

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
        );

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
        .where(inArray(productAttributeValues.productId, productIds));

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
            attributeMap.set(item.attributeId, {
                id: item.attributeId,
                name: item.attributeName,
                slug: item.attributeSlug,
                values: new Set(),
            });
        }
        attributeMap.get(item.attributeId)!.values.add(item.value);
    }

    return Array.from(attributeMap.values()).map((attr) => ({
        id: attr.id,
        name: attr.name,
        slug: attr.slug,
        values: Array.from(attr.values).sort(),
    }));
}
