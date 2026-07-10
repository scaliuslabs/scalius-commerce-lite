import { products } from "@scalius/database/schema";
import { eq, isNull, sql, type SQL } from "drizzle-orm";

function hasCustomerOptionPredicate(alias: string): SQL {
    return sql`(
        trim(coalesce(${sql.raw(`${alias}.size`)}, '')) <> ''
        OR trim(coalesce(${sql.raw(`${alias}.color`)}, '')) <> ''
    )`;
}

function activePersistedSkuPredicate(alias: string, productId: SQL): SQL {
    return sql`
        ${sql.raw(`${alias}.product_id`)} = ${productId}
        AND ${sql.raw(`${alias}.deleted_at`)} IS NULL
        AND ${sql.raw(`${alias}.id`)} <> 'default'
    `;
}

function availableSkuPredicate(alias: string): SQL {
    return sql`(
        ${sql.raw(`${alias}.track_inventory`)} = 0
        OR (${sql.raw(`${alias}.stock`)} - ${sql.raw(`${alias}.reserved_stock`)}) > 0
    )`;
}

function buyerOptionTopologyPredicate(
    productId: SQL,
    aliasPrefix: "buyer" | "buyer_available",
    requireAvailable: boolean,
): SQL {
    const optionAlias = `${aliasPrefix}_option_sku`;
    const shapeAlias = `${aliasPrefix}_option_shape_sku`;
    const availability = requireAvailable
        ? sql`AND ${availableSkuPredicate(optionAlias)}`
        : sql``;

    return sql`(
        EXISTS (
            SELECT 1
            FROM "product_variants" AS ${sql.raw(optionAlias)}
            WHERE ${activePersistedSkuPredicate(optionAlias, productId)}
              AND ${sql.raw(`${optionAlias}.is_default`)} = 0
              AND ${hasCustomerOptionPredicate(optionAlias)}
              ${availability}
        )
        AND (
            SELECT (
                min(CASE
                    WHEN trim(coalesce(${sql.raw(`${shapeAlias}.size`)}, '')) <> '' THEN 1
                    ELSE 0
                END) = max(CASE
                    WHEN trim(coalesce(${sql.raw(`${shapeAlias}.size`)}, '')) <> '' THEN 1
                    ELSE 0
                END)
                AND min(CASE
                    WHEN trim(coalesce(${sql.raw(`${shapeAlias}.color`)}, '')) <> '' THEN 1
                    ELSE 0
                END) = max(CASE
                    WHEN trim(coalesce(${sql.raw(`${shapeAlias}.color`)}, '')) <> '' THEN 1
                    ELSE 0
                END)
            )
            FROM "product_variants" AS ${sql.raw(shapeAlias)}
            WHERE ${activePersistedSkuPredicate(shapeAlias, productId)}
              AND ${sql.raw(`${shapeAlias}.is_default`)} = 0
        ) = 1
    )`;
}

/**
 * Public product visibility is stricter than "active product row".
 *
 * A storefront-visible product must have a buyer-resolvable SKU topology:
 * - active non-default customer-option SKUs all use one option-axis shape, or
 * - exactly one active persisted no-option SKU for a simple product.
 *
 * Stock is intentionally not part of this predicate; sold-out products can stay
 * visible, but SKU-less or ambiguous products cannot enter public catalog cards.
 */
export function publicProductHasBuyerResolvableSku(productId: SQL = sql`${products.id}`): SQL {
    return sql`(
        ${buyerOptionTopologyPredicate(productId, "buyer", false)}
        OR (
            (
                SELECT count(*)
                FROM "product_variants" AS buyer_active_sku
                WHERE ${activePersistedSkuPredicate("buyer_active_sku", productId)}
            ) = 1
            AND EXISTS (
                SELECT 1
                FROM "product_variants" AS buyer_simple_sku
                WHERE ${activePersistedSkuPredicate("buyer_simple_sku", productId)}
                  AND ${sql.raw("buyer_simple_sku.is_default")} = 1
            )
        )
    )`;
}

export function publicProductHasCustomerOptions(productId: SQL = sql`${products.id}`): SQL<boolean> {
    return sql`${buyerOptionTopologyPredicate(productId, "buyer", false)}`;
}

export function publicProductHasAvailableBuyerSku(productId: SQL = sql`${products.id}`): SQL<boolean> {
    return sql`(
        ${buyerOptionTopologyPredicate(productId, "buyer_available", true)}
        OR (
            (
                SELECT count(*)
                FROM "product_variants" AS buyer_available_active_sku
                WHERE ${activePersistedSkuPredicate("buyer_available_active_sku", productId)}
            ) = 1
            AND EXISTS (
                SELECT 1
                FROM "product_variants" AS buyer_available_simple_sku
                WHERE ${activePersistedSkuPredicate("buyer_available_simple_sku", productId)}
                  AND ${sql.raw("buyer_available_simple_sku.is_default")} = 1
                  AND ${availableSkuPredicate("buyer_available_simple_sku")}
            )
        )
    )`;
}

export function publicProductBaseConditions(): SQL[] {
    return [
        eq(products.isActive, true),
        isNull(products.deletedAt),
        publicProductHasBuyerResolvableSku(),
    ];
}

export function publicCollectionProductConditions(...extraConditions: SQL[]): SQL[] {
    return [
        ...extraConditions,
        eq(products.isActive, true),
        isNull(products.deletedAt),
        publicProductHasBuyerResolvableSku(),
    ];
}

export function defaultProductSkuValues(productId: string, price: number) {
    return {
        id: `var_default_${productId}`,
        productId,
        size: null,
        color: null,
        weight: null,
        sku: `SIMPLE-${productId}`,
        price,
        stock: 0,
        reservedStock: 0,
        preorderStock: 0,
        isDefault: true,
        trackInventory: false,
        version: 1,
        stockVersion: 1,
        allowPreorder: false,
        allowBackorder: false,
        backorderLimit: 0,
        discountPercentage: 0,
        discountType: "percentage" as const,
        discountAmount: 0,
        colorSortOrder: 0,
        sizeSortOrder: 0,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
        deletedAt: null,
    };
}

export function normalizeDefaultSkuOptions<T extends { isDefault: boolean; size: string | null; color: string | null }>(
    variant: T,
): T {
    if (!variant.isDefault || (!variant.size?.trim() && !variant.color?.trim())) {
        return variant;
    }

    return {
        ...variant,
        size: null,
        color: null,
    };
}
