import { products } from "@scalius/database/schema";
import { eq, isNull, sql, type SQL } from "drizzle-orm";
import { generateInternalCode128Barcode } from "@scalius/shared/barcode-identity";

function hasCustomerOptionPredicate(alias: string): SQL {
    return sql`trim(coalesce(${sql.raw(`${alias}.option_combination_key`)}, '')) <> ''`;
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

/**
 * Selects the SKU identity that is operational for a product's current
 * topology. A protected default SKU is operational only while no active
 * customer-option SKU exists; once options exist it remains an audit/revert
 * record and must not appear in inventory, scanner, or alert projections.
 */
export function operationalSkuRowPredicate(alias = "product_variants"): SQL {
    return sql`(
        ${sql.raw(`${alias}.is_default`)} = 0
        OR NOT EXISTS (
            SELECT 1
            FROM "product_variants" AS operational_option_sku
            WHERE operational_option_sku.product_id = ${sql.raw(`${alias}.product_id`)}
              AND operational_option_sku.is_default = 0
              AND operational_option_sku.deleted_at IS NULL
              AND trim(coalesce(operational_option_sku.option_combination_key, '')) <> ''
        )
    )`;
}

function buyerOptionTopologyPredicate(
    productId: SQL,
    aliasPrefix: "buyer" | "buyer_available",
    requireAvailable: boolean,
): SQL {
    const optionAlias = `${aliasPrefix}_option_sku`;
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
        AND (SELECT count(*) FROM "product_option_definitions" AS buyer_axis
             WHERE buyer_axis.product_id = ${productId} AND buyer_axis.deleted_at IS NULL) > 0
        AND NOT EXISTS (
            SELECT 1
            FROM "product_variants" AS buyer_shape_sku
            WHERE ${activePersistedSkuPredicate("buyer_shape_sku", productId)}
              AND buyer_shape_sku.is_default = 0
              AND (
                SELECT count(*)
                FROM "product_variant_option_values" AS buyer_assignment
                JOIN "product_option_definitions" AS buyer_definition
                  ON buyer_definition.id = buyer_assignment.option_definition_id
                 AND buyer_definition.deleted_at IS NULL
                JOIN "product_option_values" AS buyer_value
                  ON buyer_value.id = buyer_assignment.option_value_id
                 AND buyer_value.deleted_at IS NULL
                WHERE buyer_assignment.variant_id = buyer_shape_sku.id
              ) <> (
                SELECT count(*) FROM "product_option_definitions" AS buyer_required_axis
                WHERE buyer_required_axis.product_id = ${productId}
                  AND buyer_required_axis.deleted_at IS NULL
              )
        )
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

/** Feed/UCP pagination counts only products with usable primary media. */
export function publicProductHasPrimaryDiscoveryImage(
    productId: SQL = sql`${products.id}`,
): SQL<boolean> {
    return sql`EXISTS (
        SELECT 1
        FROM "product_images" AS discovery_primary_image
        WHERE discovery_primary_image.product_id = ${productId}
          AND discovery_primary_image.is_primary = 1
          AND trim(discovery_primary_image.url) <> ''
          AND discovery_primary_image.url NOT LIKE '//%'
          AND (
            instr(discovery_primary_image.url, ':') = 0
            OR lower(discovery_primary_image.url) LIKE 'http://%'
            OR lower(discovery_primary_image.url) LIKE 'https://%'
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
    const variantId = `var_default_${productId}`;
    return {
        id: variantId,
        productId,
        optionCombinationKey: null,
        imageId: null,
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
        barcode: generateInternalCode128Barcode(variantId),
        barcodeType: "code128" as const,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
        deletedAt: null,
    };
}

export function normalizeDefaultSkuOptions<T extends { isDefault: boolean; optionCombinationKey: string | null }>(
    variant: T,
): T {
    if (!variant.isDefault || variant.optionCombinationKey === null) {
        return variant;
    }

    return {
        ...variant,
        optionCombinationKey: null,
    };
}
