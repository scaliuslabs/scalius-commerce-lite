import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DiscountType } from "@scalius/database/schema";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { isDiscountValid, calculateDiscountAmount } from "@scalius/core/modules/discounts/discounts.eligibility";

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
    } catch (error: unknown) {
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
