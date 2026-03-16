import type { Database } from "@scalius/database/client";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import {
  discounts,
  discountProducts,
  discountCollections,
  discountUsage,
  orders,
  collections,
  products,
  DiscountType,
  DiscountValueType
} from "@scalius/database/schema";
import { eq, sql, and, isNull, count, inArray } from "drizzle-orm";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";

import { ok } from "../utils/api-response";
import { ValidationError } from "../utils/api-error";
import { roundPrice } from "@scalius/shared/price-utils";
const app = new OpenAPIHono<{ Bindings: Env }>();

// Schema for validating discount code
const validateDiscountSchema = z.object({
  code: z.string().min(1).openapi({ description: "Discount code to validate" }),
  total: z.coerce.number().optional().openapi({ description: "Cart total" }),
  items: z.string().optional().openapi({ description: "JSON-encoded cart items" }),
  shippingCost: z.coerce.number().optional().default(0).openapi({ description: "Shipping cost" }),
  customerPhone: z.string().optional().openapi({ description: "Customer phone for per-customer limits" })
});

// Schema for cart item - coerce numbers to handle string values from localStorage
const cartItemSchema = z.object({
  id: z.string(),
  price: z.coerce.number(),
  quantity: z.coerce.number(),
  variantId: z.string().optional()
});

// Helper function to expand collections to product IDs
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

      productsFromCategories.forEach((p) => productIds.add(p.id));
    }
  } catch (error) {
    console.error("Error expanding collections to product IDs:", error);
  }

  return productIds;
}

// Helper function to check if a discount is valid
export async function isDiscountValid(
  db: Database,
  code: string,
  total?: number,
  cartItems: Array<{ id: string; price: number; quantity: number; variantId?: string }> = [],
  customerPhone?: string,
  currencySymbol: string = "\u09F3",
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
          error: "Discount code has reached its usage limit"
        };
      }
    } catch (error) {
      console.error("Error checking discount usage count:", error);
    }
  }

  // Check usage limit per customer (requires customerPhone)
  if (discount.limitOnePerCustomer && customerPhone) {
    try {
      console.log(`Checking one-use-per-customer for phone: ${customerPhone}`);

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
        console.log(
          `Found previous usage for ${customerPhone} for discount ${discount.code}`,
        );
        return {
          valid: false,
          error: "This discount code can only be used once per customer"
        };
      } else {
        console.log(`No previous usage found for ${customerPhone}`);
      }
    } catch (error) {
      console.error("Error checking customer discount usage:", error);
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
    discountProductsResult.forEach((dp) =>
      applicableProductIds.add(dp.productId),
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
      productIdsFromCollections.forEach((id) => applicableProductIds.add(id));
    }

    // If we have specific product/collection restrictions and none of the cart items match
    if (
      applicableProductIds.size > 0 &&
      !cartItems.some((item) => applicableProductIds.has(item.id))
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
    }
  };
}

// Calculate the discount amount for a validated discount
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

    // Query applicable product IDs directly from DB (no cache)
    const applicableProductIds = new Set<string>();

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

    let applicableProductsTotal = 0;
    for (const item of cartItems) {
      if (applicableProductIds.has(item.id)) {
        applicableProductsTotal += item.price * item.quantity;
      }
    }
    applicableProductsTotal = roundPrice(applicableProductsTotal);

    if (applicableProductsTotal === 0 || applicableProductIds.size === 0) {
      applicableProductsTotal = subTotal;
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

// GET /discounts/validate — validate a discount code
const validateDiscountRoute = createRoute({
  method: "get",
  path: "/validate",
  tags: ["Discounts"],
  summary: "Validate a discount code",
  request: {
    query: validateDiscountSchema
  },
  responses: {
    200: {
      description: "Discount validation result"
      
    },
    400: {
      description: "Bad request"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(validateDiscountRoute, async (c) => {
  const db = c.get("db");
  const params = c.req.valid("query");
  const { code, total, items, shippingCost, customerPhone } = params;

  // Parse cart items if provided
  let cartItems: Array<{ id: string; price: number; quantity: number; variantId?: string }> = [];
  if (items) {
    try {
      const parsed = JSON.parse(items);
      const itemsArray = Array.isArray(parsed) ? parsed : Object.values(parsed);
      cartItems = itemsArray.map((item: unknown) => {
        return cartItemSchema.parse(item);
      });
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? `Invalid cart items: ${error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`
          : "Invalid cart items format";
      throw new ValidationError(message);
    }
  }

  // Fetch currency config for dynamic symbol
  const currencyConfig = await getCurrencyConfig(db);

  // Validate the discount code
  const validationResult = await isDiscountValid(
    db,
    code,
    total ? Number(total) : undefined,
    cartItems,
    customerPhone,
    currencyConfig.symbol,
  );

  // If valid, calculate the discount amount
  if (validationResult.valid && validationResult.discount) {
    const discountAmount = await calculateDiscountAmount(
      db,
      validationResult.discount,
      total || 0,
      cartItems,
      shippingCost || 0,
    );

    const enhancedDiscount = {
      ...validationResult.discount,
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
          !!validationResult.discount.combineWithShippingDiscounts
      }
    };

    return ok(c, {
      valid: true,
      discount: enhancedDiscount,
      discountAmount: roundPrice(discountAmount)
    });
  }

  return ok(c, validationResult);
});

export { app as discountRoutes };
