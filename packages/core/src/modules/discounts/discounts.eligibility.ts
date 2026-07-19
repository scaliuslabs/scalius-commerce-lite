// src/modules/discounts/discounts.eligibility.ts
// Discount validation and calculation logic — pure business rules.

import type { Database } from "@scalius/database/client";
import {
    discounts,
    discountProducts,
    discountCollections,
    discountUsage,
    discountCustomerRedemptions,
    collections,
    products,
    DiscountType,
    DiscountValueType,
} from "@scalius/database/schema";
import { eq, sql, and, isNull, inArray } from "drizzle-orm";
import { DEFAULT_CURRENCY, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import { roundPrice } from "@scalius/shared/price-utils";

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

/** Expand collection IDs to the set of product IDs they contain. */
async function expandCollectionsToProductIds(
    db: Database,
    collectionIds: string[],
): Promise<Set<string>> {
    const productIds = new Set<string>();

    if (collectionIds.length === 0) {
        return productIds;
    }

    // Only an active, non-deleted collection can grant eligibility. A stale
    // relation remains a restriction and must never turn into a cart-wide
    // fallback.
    const collectionsData = await db
        .select()
        .from(collections)
        .where(
            and(
                inArray(collections.id, collectionIds),
                eq(collections.isActive, true),
                isNull(collections.deletedAt),
            ),
        )
        .all();

    // Extract all category IDs and product IDs from configs.
    const allCategoryIds = new Set<string>();
    const allProductIds = new Set<string>();

    for (const collection of collectionsData) {
        try {
            const config = JSON.parse(collection.config);

            if (Array.isArray(config.categoryIds)) {
                config.categoryIds.forEach((id: string) => allCategoryIds.add(id));
            }

            if (Array.isArray(config.productIds)) {
                config.productIds.forEach((id: string) => allProductIds.add(id));
            }
        } catch {
            // Invalid persisted collection config grants no eligibility. The
            // caller still knows the discount was restricted and fails closed.
        }
    }

    // Add directly specified product IDs.
    allProductIds.forEach((id) => productIds.add(id));

    // Get all active products from the specified categories.
    if (allCategoryIds.size > 0) {
        const productsFromCategories = await db
            .select({ id: products.id })
            .from(products)
            .where(
                and(
                    inArray(products.categoryId, Array.from(allCategoryIds)),
                    eq(products.isActive, true),
                    isNull(products.deletedAt),
                ),
            )
            .all();

        productsFromCategories.forEach((p) => productIds.add(p.id));
    }

    return productIds;
}

/** Keep only products that can still participate in storefront eligibility. */
async function filterEligibleProductIds(
    db: Database,
    productIds: string[],
): Promise<string[]> {
    if (productIds.length === 0) return [];

    const eligibleProducts = await db
        .select({ id: products.id })
        .from(products)
        .where(
            and(
                inArray(products.id, productIds),
                eq(products.isActive, true),
                isNull(products.deletedAt),
            ),
        )
        .all();

    return eligibleProducts.map((product) => product.id);
}

// ─────────────────────────────────────────
// Validation
// ─────────────────────────────────────────

/** Check if a discount code is valid for the given cart context. */
export async function isDiscountValid(
    db: Database,
    code: string,
    total?: number,
    cartItems: Array<{ id: string; price: number; quantity: number; variantId?: string }> = [],
    customerPhone?: string,
    currencySymbol: string = "",
    currencyCode?: string | null,
) {
    // Normalize code to uppercase — codes are stored uppercase (Shopify convention),
    // but customers may type lowercase on the storefront.
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode) {
        return { valid: false, error: "Invalid discount code" };
    }

    // Get current timestamp
    const currentTime = Math.floor(Date.now() / 1000);
    const effectiveCurrencyCode =
        normalizeSupportedCurrencyCode(currencyCode) ?? DEFAULT_CURRENCY.code;

    // Query the discount code
    const discount = await db
        .select()
        .from(discounts)
        .where(
            and(
                eq(discounts.code, normalizedCode),
                eq(discounts.isActive, true),
                isNull(discounts.deletedAt),
                sql`${discounts.startDate} <= ${currentTime}`,
                // Stored end timestamps are inclusive. Date-based admin rules
                // therefore remain eligible through the final selected second.
                sql`(${discounts.endDate} IS NULL OR ${discounts.endDate} >= ${currentTime})`,
            ),
        )
        .get();

    if (!discount) {
        return { valid: false, error: "Invalid discount code" };
    }

    let applicableProductIds: Set<string> | undefined;
    let hasProductRestrictions = false;

    if (discount.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
        try {
            applicableProductIds = new Set<string>();

            const discountProductsResult = await db
                .select({ productId: discountProducts.productId })
                .from(discountProducts)
                .where(eq(discountProducts.discountId, discount.id))
                .all();
            hasProductRestrictions ||= discountProductsResult.length > 0;
            const eligibleDirectProductIds = await filterEligibleProductIds(
                db,
                discountProductsResult.map((relation) => relation.productId),
            );
            eligibleDirectProductIds.forEach((productId) =>
                applicableProductIds!.add(productId),
            );

            const discountCollectionsResult = await db
                .select({ collectionId: discountCollections.collectionId })
                .from(discountCollections)
                .where(eq(discountCollections.discountId, discount.id))
                .all();
            hasProductRestrictions ||= discountCollectionsResult.length > 0;

            if (discountCollectionsResult.length > 0) {
                const collectionIds = discountCollectionsResult.map(
                    (relation) => relation.collectionId,
                );
                const productIdsFromCollections = await expandCollectionsToProductIds(
                    db,
                    collectionIds,
                );
                productIdsFromCollections.forEach((id) => applicableProductIds!.add(id));
            }
        } catch {
            return { valid: false, error: "Unable to validate discount at this time" };
        }

        if (!hasProductRestrictions) {
            return {
                valid: false,
                error: "This discount has no eligible products",
            };
        }

        if (
            !cartItems.some((item) => applicableProductIds!.has(item.id))
        ) {
            return {
                valid: false,
                error: "Discount code is not applicable to the items in your cart",
            };
        }
    }

    const requirementItems =
        discount.type === DiscountType.AMOUNT_OFF_PRODUCTS && hasProductRestrictions
            ? cartItems.filter((item) => applicableProductIds!.has(item.id))
            : cartItems;
    const requirementSubtotal =
        discount.type === DiscountType.AMOUNT_OFF_PRODUCTS && cartItems.length > 0
            ? roundPrice(
                requirementItems.reduce(
                    (sum, item) => sum + item.price * item.quantity,
                    0,
                ),
                effectiveCurrencyCode,
            )
            : total;

    if (discount.minPurchaseAmount && requirementSubtotal === undefined) {
        return {
            valid: false,
            error: "Cart total is required to validate this discount",
        };
    }

    if (
        discount.minPurchaseAmount &&
        requirementSubtotal !== undefined &&
        requirementSubtotal < discount.minPurchaseAmount
    ) {
        return {
            valid: false,
            error: `Minimum purchase amount of ${currencySymbol}${discount.minPurchaseAmount} not met`,
            minPurchaseAmount: discount.minPurchaseAmount,
        };
    }

    if (discount.minQuantity) {
        const totalQuantity = requirementItems.reduce(
            (sum, item) => sum + item.quantity,
            0,
        );
        if (totalQuantity < discount.minQuantity) {
            return {
                valid: false,
                error: `Minimum quantity of ${discount.minQuantity} items not met`,
                minQuantity: discount.minQuantity,
            };
        }
    }

    // Check total usage limit
    if (discount.maxUses) {
        try {
            const usageCountResult = await db
                .select({ count: sql<number>`COUNT(*)` })
                .from(discountUsage)
                .where(eq(discountUsage.discountId, discount.id))
                .get();

            const usageCount = usageCountResult?.count || 0;

            if (usageCount >= discount.maxUses) {
                return {
                    valid: false,
                    error: "Discount code has reached its usage limit"
                };
            }
        } catch {
            return { valid: false, error: "Unable to validate discount at this time" };
        }
    }

    // One-use rules need a stable buyer identity before the advisory check can
    // truthfully say that the code is available. Unrestricted codes do not.
    if (discount.limitOnePerCustomer && !customerPhone?.trim()) {
        return {
            valid: false,
            error: "Enter your phone number to check this one-use discount",
            requiresCustomerPhone: true,
        };
    }

    if (discount.limitOnePerCustomer && customerPhone) {
        try {
            const customerUsageResult = await db
                .select({ orderId: discountCustomerRedemptions.orderId })
                .from(discountCustomerRedemptions)
                .where(
                    and(
                        eq(discountCustomerRedemptions.discountId, discount.id),
                        eq(
                            discountCustomerRedemptions.customerKey,
                            `phone:${customerPhone.trim()}`,
                        ),
                    ),
                )
                .limit(1)
                .get();

            if (customerUsageResult) {
                return {
                    valid: false,
                    error: "This discount code can only be used once per customer"
                };
            }
        } catch {
            return { valid: false, error: "Unable to validate discount at this time" };
        }
    }

    // All checks passed
    return {
        valid: true,
        discount: {
            id: discount.id,
            code: discount.code,
            type: discount.type,
            valueType: discount.valueType,
            discountValue: discount.discountValue,
            minPurchaseAmount: discount.minPurchaseAmount,
        },
        applicableProductIds,
        hasProductRestrictions,
    };
}

// ─────────────────────────────────────────
// Calculation
// ─────────────────────────────────────────

/** Calculate the discount amount for a validated discount.
 *  If `precomputedProductIds` is provided, skips the DB queries for applicable products. */
export async function calculateDiscountAmount(
    db: Database,
    discount: {
        id: string;
        type: string;
        valueType: string;
        discountValue: number;
    },
    total: number,
    cartItems: Array<{ id: string; price: number; quantity: number; variantId?: string }>,
    shippingCost: number = 0,
    precomputedProductIds?: Set<string>,
    currencyCode?: string | null,
    precomputedHasProductRestrictions?: boolean,
): Promise<number> {
    const effectiveCurrencyCode = normalizeSupportedCurrencyCode(currencyCode) ?? DEFAULT_CURRENCY.code;

    if (discount.type === DiscountType.FREE_SHIPPING) {
        return roundPrice(shippingCost, effectiveCurrencyCode);
    }

    if (discount.type === DiscountType.AMOUNT_OFF_ORDER) {
        if (discount.valueType === DiscountValueType.PERCENTAGE) {
            const subTotal = roundPrice(total - shippingCost, effectiveCurrencyCode);
            const calculatedDiscount = roundPrice(
                (subTotal * discount.discountValue) / 100,
                effectiveCurrencyCode,
            );
            return Math.min(subTotal, calculatedDiscount);
        } else if (discount.valueType === DiscountValueType.FIXED_AMOUNT) {
            const subTotal = roundPrice(total - shippingCost, effectiveCurrencyCode);
            return Math.min(
                subTotal,
                roundPrice(discount.discountValue, effectiveCurrencyCode),
            );
        }
    }

    if (discount.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
        if (!cartItems || cartItems.length === 0) {
            return 0;
        }

        // Use pre-computed product IDs if available (avoids duplicate DB queries
        // when the caller already expanded them during validation).
        let applicableProductIds: Set<string>;
        let hasProductRestrictions =
            precomputedHasProductRestrictions ?? precomputedProductIds !== undefined;
        if (precomputedProductIds) {
            applicableProductIds = precomputedProductIds;
        } else {
            applicableProductIds = new Set<string>();

            const discountProductsResult = await db
                .select({ productId: discountProducts.productId })
                .from(discountProducts)
                .where(eq(discountProducts.discountId, discount.id))
                .all();
            hasProductRestrictions ||= discountProductsResult.length > 0;
            const eligibleDirectProductIds = await filterEligibleProductIds(
                db,
                discountProductsResult.map((relation) => relation.productId),
            );
            eligibleDirectProductIds.forEach((productId) =>
                applicableProductIds.add(productId),
            );

            const discountCollectionsResult = await db
                .select({ collectionId: discountCollections.collectionId })
                .from(discountCollections)
                .where(eq(discountCollections.discountId, discount.id))
                .all();
            hasProductRestrictions ||= discountCollectionsResult.length > 0;

            if (discountCollectionsResult.length > 0) {
                const collectionIds = discountCollectionsResult.map(
                    (dc) => dc.collectionId,
                );
                const productIdsFromCollections = await expandCollectionsToProductIds(
                    db,
                    collectionIds,
                );
                productIdsFromCollections.forEach((id) => applicableProductIds.add(id));
            }
        }

        let applicableProductsTotal = 0;
        for (const item of cartItems) {
            if (applicableProductIds.has(item.id)) {
                applicableProductsTotal += item.price * item.quantity;
            }
        }
        applicableProductsTotal = roundPrice(applicableProductsTotal, effectiveCurrencyCode);

        // Product discounts always require an explicit saved scope. Missing or
        // non-matching scope never degrades to the order subtotal.
        if (!hasProductRestrictions || applicableProductsTotal === 0) {
            return 0;
        }

        if (discount.valueType === DiscountValueType.PERCENTAGE) {
            const calculatedDiscount =
                roundPrice(
                    (applicableProductsTotal * discount.discountValue) / 100,
                    effectiveCurrencyCode,
                );
            return Math.min(applicableProductsTotal, calculatedDiscount);
        } else if (discount.valueType === DiscountValueType.FIXED_AMOUNT) {
            return Math.min(
                applicableProductsTotal,
                roundPrice(discount.discountValue, effectiveCurrencyCode),
            );
        }
    }

    return 0;
}
