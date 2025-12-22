import { Hono } from "hono";
import { z } from "zod";

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
} from "@/db/schema";
import { eq, sql, and, isNull, count, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";

const app = new Hono<{ Bindings: Env }>();

// Schema for validating discount code
const validateDiscountSchema = z.object({
  code: z.string().min(1),
  total: z.coerce.number().optional(),
  items: z.string().optional(),
  shippingCost: z.coerce.number().optional().default(0),
  customerPhone: z.string().optional(),
});

// Schema for cart item
const cartItemSchema = z.object({
  id: z.string(),
  price: z.number(),
  quantity: z.number(),
  variantId: z.string().optional(),
});

// Helper function to expand collections to product IDs
async function expandCollectionsToProductIds(
  db: any,
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

        // Add category IDs from new schema (config.categoryIds)
        if (Array.isArray(config.categoryIds)) {
          config.categoryIds.forEach((id: string) => allCategoryIds.add(id));
        }

        // Add product IDs from new schema (config.productIds)
        if (Array.isArray(config.productIds)) {
          config.productIds.forEach((id: string) => allProductIds.add(id));
        }

        // Backward compatibility: old schema support
        // Add old categoryId field (if exists in config or collection)
        if (config.categoryId) {
          allCategoryIds.add(config.categoryId);
        }
        // @ts-ignore - categoryId may still exist during migration
        if (collection.categoryId) {
          // @ts-ignore
          allCategoryIds.add(collection.categoryId);
        }

        // Add old specificProductIds
        if (Array.isArray(config.specificProductIds)) {
          config.specificProductIds.forEach((id: string) =>
            allProductIds.add(id),
          );
        }

        // Add old specificCategoryIds
        if (Array.isArray(config.specificCategoryIds)) {
          config.specificCategoryIds.forEach((id: string) =>
            allCategoryIds.add(id),
          );
        }
      } catch (error) {
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

      productsFromCategories.forEach((p: any) => productIds.add(p.id));
    }
  } catch (error) {
    console.error("Error expanding collections to product IDs:", error);
  }

  return productIds;
}

// Helper function to check if a discount is valid
async function isDiscountValid(
  db: any,
  code: string,
  total?: number,
  cartItems: any[] = [],
  customerPhone?: string,
) {
  // Get current timestamp
  const currentTime = Math.floor(Date.now() / 1000);

  // Query the discount code
  const discount = await db
    .select()
    .from(discounts)
    .where(
      and(
        eq(discounts.code, code),
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

  // For product-specific discounts, pre-populate the cache
  if (discount.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
    await _tryPopulateApplicableProductCache(db, discount.id);
  }

  // Check if minimum purchase amount is met
  if (
    discount.minPurchaseAmount &&
    total !== undefined &&
    total < discount.minPurchaseAmount
  ) {
    return {
      valid: false,
      error: `Minimum purchase amount of ৳${discount.minPurchaseAmount} not met`,
      minPurchaseAmount: discount.minPurchaseAmount,
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
        minQuantity: discount.minQuantity,
      };
    }
  }

  // Check total usage limit
  if (discount.maxUses) {
    try {
      // Convert count to an explicit expression with aliasing to ensure proper typing
      const countExpr = count().as("count");
      const usageCountResult = await db
        .select({ count: countExpr })
        .from(discountUsage)
        .where(eq(discountUsage.discountId, discount.id))
        .get();

      const usageCount = usageCountResult?.count || 0;
      console.log(
        `Discount ${discount.code} usage count: ${usageCount}/${discount.maxUses}`,
      );

      if (usageCount >= discount.maxUses) {
        return {
          valid: false,
          error: "Discount code has reached its usage limit",
        };
      }
    } catch (error) {
      console.error("Error checking discount usage count:", error);
      // Don't fail the validation, just log the error
    }
  }

  // Check usage limit per customer (requires customerPhone)
  if (discount.limitOnePerCustomer && customerPhone) {
    try {
      // or join with discountUsage->orders->customers (might be slow)
      // Let's check discountUsage joined with orders for the phone number
      console.log(`Checking one-use-per-customer for phone: ${customerPhone}`);

      const customerUsageResult = await db
        .select({ id: discountUsage.id })
        .from(discountUsage)
        .leftJoin(
          orders, // Assuming orders table is imported or available
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
        console.log(
          `Found previous usage for ${customerPhone} for discount ${discount.code}`,
        );
        return {
          valid: false,
          error: "This discount code can only be used once per customer",
        };
      } else {
        console.log(`No previous usage found for ${customerPhone}`);
      }
    } catch (error) {
      console.error("Error checking customer discount usage:", error);
      // Don't fail the validation, just log the error
    }
  } else if (discount.limitOnePerCustomer && !customerPhone) {
    console.log(
      "One-use-per-customer discount, but no phone provided - validation will happen at checkout",
    );
  }

  // For product-specific discounts, check if applicable products/collections are in cart
  if (discount.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
    const applicableProductIds = new Set<string>();

    // Get directly linked product IDs
    const discountProductsResult = await db
      .select({ productId: discountProducts.productId })
      .from(discountProducts)
      .where(eq(discountProducts.discountId, discount.id))
      .all();
    discountProductsResult.forEach((dp: any) =>
      applicableProductIds.add(dp.productId),
    );

    // Get product IDs from linked collections (THIS WAS MISSING!)
    const discountCollectionsResult = await db
      .select({ collectionId: discountCollections.collectionId })
      .from(discountCollections)
      .where(eq(discountCollections.discountId, discount.id))
      .all();

    if (discountCollectionsResult.length > 0) {
      const collectionIds = discountCollectionsResult.map(
        (dc: any) => dc.collectionId,
      );
      const productIdsFromCollections = await expandCollectionsToProductIds(
        db,
        collectionIds,
      );
      productIdsFromCollections.forEach((id) => applicableProductIds.add(id));
    }

    // If we have specific product/collection restrictions and none of the cart items match
    if (
      applicableProductIds.size > 0 &&
      !cartItems.some((item) => applicableProductIds.has(item.id))
    ) {
      return {
        valid: false,
        error: "Discount code is not applicable to the items in your cart",
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
      combineWithShippingDiscounts: discount.combineWithShippingDiscounts,
    },
  };
}

// Calculate the discount amount for a validated discount
function calculateDiscountAmount(
  db: any,
  discount: {
    id: string;
    type: string;
    valueType: string;
    discountValue: number;
  },
  total: number,
  cartItems: any[],
  shippingCost: number = 0,
): number {
  if (discount.type === DiscountType.FREE_SHIPPING) {
    // Return the actual shipping cost as the discount amount
    return shippingCost;
  }

  if (discount.type === DiscountType.AMOUNT_OFF_ORDER) {
    if (discount.valueType === DiscountValueType.PERCENTAGE) {
      // Calculate percentage off the subtotal (total before shipping)
      const subTotal = total - shippingCost;
      const calculatedDiscount = (subTotal * discount.discountValue) / 100;
      return Math.min(subTotal, calculatedDiscount); // Discount cannot exceed subtotal
    } else if (discount.valueType === DiscountValueType.FIXED_AMOUNT) {
      const subTotal = total - shippingCost;
      return Math.min(subTotal, discount.discountValue);
    }
  }

  if (discount.type === DiscountType.AMOUNT_OFF_PRODUCTS) {
    const subTotal = total - shippingCost;

    // For simplicity and consistent behavior, if no cart items provided
    // just apply to the full subtotal (this is the fallback behavior)
    if (!cartItems || cartItems.length === 0) {
      if (discount.valueType === DiscountValueType.PERCENTAGE) {
        const calculatedDiscount = (subTotal * discount.discountValue) / 100;
        return Math.min(subTotal, calculatedDiscount);
      } else if (discount.valueType === DiscountValueType.FIXED_AMOUNT) {
        return Math.min(subTotal, discount.discountValue);
      }
      return 0;
    }

    // Get applicable product IDs for this discount
    // This is cached for this request to avoid multiple DB calls
    if (!_applicableProductCache.has(discount.id)) {
      // This should be awaited, but since calculateDiscountAmount is not async,
      // we're using a cache that will be populated if this discount is validated first
      // NOTE: Passing db to populate cache
      _tryPopulateApplicableProductCache(db, discount.id);
    }

    const applicableProductIds =
      _applicableProductCache.get(discount.id) || new Set<string>();

    // Calculate total of applicable products
    let applicableProductsTotal = 0;
    for (const item of cartItems) {
      if (applicableProductIds.has(item.id)) {
        applicableProductsTotal += item.price * item.quantity;
      }
    }

    // If no specific products found in cart or empty applicableProductIds,
    // apply to the entire subtotal
    if (applicableProductsTotal === 0 || applicableProductIds.size === 0) {
      applicableProductsTotal = subTotal;
    }

    if (discount.valueType === DiscountValueType.PERCENTAGE) {
      const calculatedDiscount =
        (applicableProductsTotal * discount.discountValue) / 100;
      return Math.min(applicableProductsTotal, calculatedDiscount);
    } else if (discount.valueType === DiscountValueType.FIXED_AMOUNT) {
      return Math.min(applicableProductsTotal, discount.discountValue);
    }
  }

  return 0;
}

// Cache for applicable product IDs by discount ID
const _applicableProductCache = new Map<string, Set<string>>();

// Populate the cache with applicable product IDs for a discount
async function _tryPopulateApplicableProductCache(
  db: any,
  discountId: string,
): Promise<void> {
  try {
    const applicableProductIds = new Set<string>();

    // Get directly linked product IDs
    const discountProductsResult = await db
      .select({ productId: discountProducts.productId })
      .from(discountProducts)
      .where(eq(discountProducts.discountId, discountId))
      .all();

    discountProductsResult.forEach((dp: any) =>
      applicableProductIds.add(dp.productId),
    );

    // Get product IDs from linked collections
    const discountCollectionsResult = await db
      .select({ collectionId: discountCollections.collectionId })
      .from(discountCollections)
      .where(eq(discountCollections.discountId, discountId))
      .all();

    if (discountCollectionsResult.length > 0) {
      const collectionIds = discountCollectionsResult.map(
        (dc: any) => dc.collectionId,
      );
      const productIdsFromCollections = await expandCollectionsToProductIds(
        db,
        collectionIds,
      );
      productIdsFromCollections.forEach((id) => applicableProductIds.add(id));
    }

    // Store in cache
    _applicableProductCache.set(discountId, applicableProductIds);
  } catch (error) {
    console.error("Error populating applicable product cache:", error);
    // Set empty set as fallback
    _applicableProductCache.set(discountId, new Set<string>());
  }
}

// Validate a discount code
app.get("/validate", async (c) => {
  try {
    const db = c.get("db");
    const params = validateDiscountSchema.parse(c.req.query());
    const { code, total, items, shippingCost, customerPhone } = params;

    // Parse cart items if provided
    let cartItems: any[] = [];
    if (items) {
      try {
        cartItems = JSON.parse(items);
        // Validate each item format
        cartItems.forEach((item) => cartItemSchema.parse(item));
      } catch (error) {
        return c.json(
          { valid: false, error: "Invalid cart items format" },
          400,
        );
      }
    }

    // Validate the discount code
    const validationResult = await isDiscountValid(
      db,
      code,
      total ? Number(total) : undefined,
      cartItems,
      customerPhone,
    );

    // If valid, calculate the discount amount
    if (validationResult.valid && validationResult.discount) {
      const discountAmount = calculateDiscountAmount(
        db,
        validationResult.discount,
        total || 0, // Use cart total (subtotal + shipping potentially)
        cartItems,
        shippingCost || 0,
      );

      // Create enhanced response for client
      const enhancedDiscount = {
        ...validationResult.discount,
        // Make combinability explicit for each case - free shipping can combine with product/order
        combinable: {
          withProductDiscounts:
            validationResult.discount.type === DiscountType.FREE_SHIPPING ||
            !!validationResult.discount.combineWithProductDiscounts,

          withOrderDiscounts:
            validationResult.discount.type ===
              DiscountType.AMOUNT_OFF_PRODUCTS ||
            !!validationResult.discount.combineWithOrderDiscounts,

          withShippingDiscounts:
            validationResult.discount.type === DiscountType.AMOUNT_OFF_ORDER ||
            validationResult.discount.type ===
              DiscountType.AMOUNT_OFF_PRODUCTS ||
            !!validationResult.discount.combineWithShippingDiscounts,
        },
      };

      // Return the enhanced response
      return c.json({
        valid: true,
        discount: enhancedDiscount,
        discountAmount: parseFloat(discountAmount.toFixed(2)),
      });
    }

    return c.json(validationResult);
  } catch (error) {
    console.error("Error validating discount:", error);
    if (error instanceof z.ZodError) {
      return c.json({ valid: false, error: error.errors }, 400);
    }
    return c.json({ valid: false, error: "Failed to validate discount" }, 500);
  }
});

// Add an endpoint to record discount usage
app.post("/usage", async (c) => {
  try {
    const db = c.get("db");
    const body = await c.req.json();
    const { discountId, orderId, customerId, amountDiscounted } = body;

    if (!discountId || !orderId || !amountDiscounted) {
      return c.json({ success: false, error: "Missing required fields" }, 400);
    }

    // Generate a unique ID for the usage record using nanoid
    const usageId = `du_${nanoid()}`;

    // Insert the usage record
    await db.insert(discountUsage).values({
      id: usageId,
      discountId,
      orderId,
      customerId,
      amountDiscounted,
      createdAt: sql`CURRENT_TIMESTAMP`,
    });

    return c.json({ success: true, id: usageId });
  } catch (error) {
    console.error("Error recording discount usage:", error);
    return c.json(
      { success: false, error: "Failed to record discount usage" },
      500,
    );
  }
});

export { app as discountRoutes };
