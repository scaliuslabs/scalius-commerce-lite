// src/modules/discounts/discounts.eligibility.ts
// Discount validation and calculation logic — pure business rules.

import type { Database } from "@scalius/database/client";
import {
    discounts,
    discountProducts,
    discountCollections,
    discountUsage,
    orders,
    collections,
    products,
    DiscountType,
    DiscountValueType,
} from "@scalius/database/schema";
import { eq, sql, and, isNull, inArray } from "drizzle-orm";
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

    try {
        // Get all collections
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

        // Extract all category IDs and product IDs from configs
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
            } catch (error: unknown) {
                console.error(
                    `Error parsing collection config for ${collection.id}:`,
                    error,
                );
            }
        }

        // Add directly specified product IDs
        allProductIds.forEach((id) => productIds.add(id));

        // Get all products from the specified categories
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
    } catch (error: unknown) {
        console.error("Error expanding collections to product IDs:", error);
    }

    return productIds;
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
) {
    // Normalize code to uppercase — codes are stored uppercase (Shopify convention),
    // but customers may type lowercase on the storefront.
    const normalizedCode = code.toUpperCase();

    // Get current timestamp
    const currentTime = Math.floor(Date.now() / 1000);

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
                sql`(${discounts.endDate} IS NULL OR ${discounts.endDate} > ${currentTime})`,
            ),
        )
        .get();

    if (!discount) {
        return { valid: false, error: "Invalid discount code" };
    }

    // Check if minimum purchase amount is met
    if (
        discount.minPurchaseAmount &&
        total !== undefined &&
        total < discount.minPurchaseAmount
    ) {
        return {
            valid: false,
            error: `Minimum purchase amount of ${currencySymbol}${discount.minPurchaseAmount} not met`,
            minPurchaseAmount: discount.minPurchaseAmount
        };
    }

    // Check minimum quantity
    if (discount.minQuantity) {
        const totalQuantity = cartItems.reduce(
            (sum, item) => sum + item.quantity,
            0,
        );
        if (totalQuantity < discount.minQuantity) {
            return {
                valid: false,
                error: `Minimum quantity of ${discount.minQuantity} items not met`,
                minQuantity: discount.minQuantity
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
        } catch (error: unknown) {
            console.error("Error checking discount usage count:", error);
            return { valid: false, error: "Unable to validate discount at this time" };
        }
    }

    // Check usage limit per customer (requires customerPhone)
    if (discount.limitOnePerCustomer && customerPhone) {
        try {
            const customerUsageResult = await db
                .select({ id: discountUsage.id })
                .from(discountUsage)
                .leftJoin(
                    orders,
                    eq(discountUsage.orderId, orders.id),
                )
                .where(
                    and(
                        eq(discountUsage.discountId, discount.id),
                        eq(orders.customerPhone, customerPhone),
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
        } catch (error: unknown) {
            console.error("Error checking customer discount usage:", error);
            return { valid: false, error: "Unable to validate discount at this time" };
        }
    } else if (discount.limitOnePerCustomer && !customerPhone) {
        console.log(
            "One-use-per-customer discount, but no phone provided - validation will happen at checkout",
        );
    }

    // For product-specific discounts, check if applicable products/collections are in cart.
    // We also capture the expanded product IDs so the caller can pass them to
    // calculateDiscountAmount() without re-querying the same data.
    let applicableProductIds: Set<string> | undefined;

    if (discount.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
        applicableProductIds = new Set<string>();

        // Get directly linked product IDs
        const discountProductsResult = await db
            .select({ productId: discountProducts.productId })
            .from(discountProducts)
            .where(eq(discountProducts.discountId, discount.id))
            .all();
        discountProductsResult.forEach((dp) =>
            applicableProductIds!.add(dp.productId),
        );

        // Get product IDs from linked collections
        const discountCollectionsResult = await db
            .select({ collectionId: discountCollections.collectionId })
            .from(discountCollections)
            .where(eq(discountCollections.discountId, discount.id))
            .all();

        if (discountCollectionsResult.length > 0) {
            const collectionIds = discountCollectionsResult.map(
                (dc) => dc.collectionId,
            );
            const productIdsFromCollections = await expandCollectionsToProductIds(
                db,
                collectionIds,
            );
            productIdsFromCollections.forEach((id) => applicableProductIds!.add(id));
        }

        // If we have specific product/collection restrictions and none of the cart items match
        if (
            applicableProductIds.size > 0 &&
            !cartItems.some((item) => applicableProductIds!.has(item.id))
        ) {
            return {
                valid: false,
                error: "Discount code is not applicable to the items in your cart"
            };
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
            combineWithProductDiscounts: discount.combineWithProductDiscounts,
            combineWithOrderDiscounts: discount.combineWithOrderDiscounts,
            combineWithShippingDiscounts: discount.combineWithShippingDiscounts
        },
        applicableProductIds,
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
): Promise<number> {
    if (discount.type === DiscountType.FREE_SHIPPING) {
        return shippingCost;
    }

    if (discount.type === DiscountType.AMOUNT_OFF_ORDER) {
        if (discount.valueType === DiscountValueType.PERCENTAGE) {
            const subTotal = roundPrice(total - shippingCost);
            const calculatedDiscount = roundPrice((subTotal * discount.discountValue) / 100);
            return Math.min(subTotal, calculatedDiscount);
        } else if (discount.valueType === DiscountValueType.FIXED_AMOUNT) {
            const subTotal = roundPrice(total - shippingCost);
            return Math.min(subTotal, discount.discountValue);
        }
    }

    if (discount.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
        const subTotal = roundPrice(total - shippingCost);

        if (!cartItems || cartItems.length === 0) {
            if (discount.valueType === DiscountValueType.PERCENTAGE) {
                const calculatedDiscount = roundPrice((subTotal * discount.discountValue) / 100);
                return Math.min(subTotal, calculatedDiscount);
            } else if (discount.valueType === DiscountValueType.FIXED_AMOUNT) {
                return Math.min(subTotal, discount.discountValue);
            }
            return 0;
        }

        // Use pre-computed product IDs if available (avoids duplicate DB queries
        // when the caller already expanded them during validation).
        let applicableProductIds: Set<string>;
        if (precomputedProductIds) {
            applicableProductIds = precomputedProductIds;
        } else {
            applicableProductIds = new Set<string>();

            const discountProductsResult = await db
                .select({ productId: discountProducts.productId })
                .from(discountProducts)
                .where(eq(discountProducts.discountId, discount.id))
                .all();
            discountProductsResult.forEach((dp) =>
                applicableProductIds.add(dp.productId),
            );

            const discountCollectionsResult = await db
                .select({ collectionId: discountCollections.collectionId })
                .from(discountCollections)
                .where(eq(discountCollections.discountId, discount.id))
                .all();

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
        applicableProductsTotal = roundPrice(applicableProductsTotal);

        // If products are specified but none match the cart, no discount applies.
        // Only fall back to subtotal when no product/collection restrictions exist.
        if (applicableProductIds.size === 0) {
            applicableProductsTotal = subTotal;
        } else if (applicableProductsTotal === 0) {
            return 0;
        }

        if (discount.valueType === DiscountValueType.PERCENTAGE) {
            const calculatedDiscount =
                roundPrice((applicableProductsTotal * discount.discountValue) / 100);
            return Math.min(applicableProductsTotal, calculatedDiscount);
        } else if (discount.valueType === DiscountValueType.FIXED_AMOUNT) {
            return Math.min(applicableProductsTotal, discount.discountValue);
        }
    }

    return 0;
}
