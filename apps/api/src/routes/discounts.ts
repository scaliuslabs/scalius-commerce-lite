import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { isDiscountValid, calculateDiscountAmount } from "@scalius/core/modules/discounts/discounts.eligibility";
import { MAX_PRODUCT_PRICE } from "@scalius/core/modules/products/products.types";

import { ok } from "../utils/api-response";
import { roundPrice } from "@scalius/shared/price-utils";
import { successEnvelope, errorResponses } from "../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

// The storefront API client serializes numeric cart facts as JSON numbers.
// Reject null/empty/string coercion so crafted requests cannot turn them into 0.
const cartItemSchema = z.object({
  id: z.string().trim().min(1).max(100),
  price: z.number().finite().nonnegative().max(MAX_PRODUCT_PRICE),
  quantity: z.number().int().positive().max(10_000),
  variantId: z.string().trim().min(1).max(100).optional()
});

// Schema for validating discount code
const validateDiscountSchema = z.object({
  code: z.string().trim().min(1).max(50).openapi({ description: "Discount code to validate" }),
  total: z.number().finite().nonnegative().max(MAX_PRODUCT_PRICE).optional().openapi({ description: "Merchandise subtotal before delivery" }),
  items: z.array(cartItemSchema).max(250).optional().openapi({ description: "Cart items" }),
  shippingCost: z.number().finite().nonnegative().max(MAX_PRODUCT_PRICE).optional().default(0).openapi({ description: "Shipping cost" }),
  customerPhone: z.string().trim().max(64).optional().openapi({ description: "Customer phone for per-customer limits" })
});

// POST /discounts/validate — validate a discount code without leaking buyer/cart data into URLs.
const validateDiscountRoute = createRoute({
  method: "post",
  path: "/validate",
  tags: ["Discounts"],
  summary: "Validate a discount code",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: validateDiscountSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Discount validation result",
      content: { "application/json": { schema: successEnvelope(z.object({
        valid: z.boolean(),
        discount: z.object({ id: z.string(), code: z.string(), type: z.string(), discountValue: z.number() }).passthrough().optional(),
        discountAmount: z.number().optional(),
        message: z.string().optional(),
      }).passthrough()) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  }
});

app.openapi(validateDiscountRoute, async (c) => {
  const db = c.get("db");
  const params = c.req.valid("json");
  const { code, total, items, shippingCost, customerPhone } = params;
  const cartItems = items ?? [];

  // Fetch currency config for dynamic symbol
  const currencyConfig = await getCurrencyConfig(db);

  // Validate the discount code
  const validationResult = await isDiscountValid(
    db,
    code,
    total !== undefined ? Number(total) : undefined,
    cartItems,
    customerPhone,
    currencyConfig.symbol,
    currencyConfig.code,
  );

  // If valid, calculate the discount amount
  if (validationResult.valid && validationResult.discount) {
    const discountAmount = await calculateDiscountAmount(
      db,
      validationResult.discount,
      (total ?? 0) + shippingCost,
      cartItems,
      shippingCost || 0,
      validationResult.applicableProductIds,
      currencyConfig.code,
      validationResult.hasProductRestrictions,
    );

    return ok(c, {
      valid: true,
      discount: validationResult.discount,
      discountAmount: roundPrice(discountAmount, currencyConfig.code)
    });
  }

  // Strip internal applicableProductIds before sending to client
  const { applicableProductIds: _, ...clientResult } = validationResult;
  return ok(c, clientResult);
});

export { app as discountRoutes };
