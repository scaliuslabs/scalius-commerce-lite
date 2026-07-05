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

/**
 * Public product visibility is stricter than "active product row".
 *
 * A storefront-visible product must have a buyer-resolvable SKU topology:
 * - at least one active non-default customer-option SKU, or
 * - exactly one active persisted no-option SKU for a simple product.
 *
 * Stock is intentionally not part of this predicate; sold-out products can stay
 * visible, but SKU-less or ambiguous products cannot enter public catalog cards.
 */
export function publicProductHasBuyerResolvableSku(productId: SQL = sql`${products.id}`): SQL {
    return sql`(
        EXISTS (
            SELECT 1
            FROM "product_variants" AS buyer_option_sku
            WHERE ${activePersistedSkuPredicate("buyer_option_sku", productId)}
              AND ${sql.raw("buyer_option_sku.is_default")} = 0
              AND ${hasCustomerOptionPredicate("buyer_option_sku")}
        )
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
    return sql`EXISTS (
        SELECT 1
        FROM "product_variants" AS buyer_option_sku
        WHERE ${activePersistedSkuPredicate("buyer_option_sku", productId)}
          AND ${sql.raw("buyer_option_sku.is_default")} = 0
          AND ${hasCustomerOptionPredicate("buyer_option_sku")}
    )`;
}

function availableSkuPredicate(alias: string): SQL {
    return sql`(
        ${sql.raw(`${alias}.track_inventory`)} = 0
        OR (${sql.raw(`${alias}.stock`)} - ${sql.raw(`${alias}.reserved_stock`)}) > 0
    )`;
}

export function publicProductHasAvailableBuyerSku(productId: SQL = sql`${products.id}`): SQL<boolean> {
    return sql`(
        EXISTS (
            SELECT 1
            FROM "product_variants" AS buyer_available_option_sku
            WHERE ${activePersistedSkuPredicate("buyer_available_option_sku", productId)}
              AND ${sql.raw("buyer_available_option_sku.is_default")} = 0
              AND ${hasCustomerOptionPredicate("buyer_available_option_sku")}
              AND ${availableSkuPredicate("buyer_available_option_sku")}
        )
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
