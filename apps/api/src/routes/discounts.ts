import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DiscountType } from "@scalius/database/schema";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { isDiscountValid, calculateDiscountAmount } from "@scalius/core/modules/discounts/discounts.eligibility";

import { ok } from "../utils/api-response";
import { roundPrice } from "@scalius/shared/price-utils";
import { successEnvelope, errorResponses } from "../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

// Schema for cart item - coerce numbers to handle string values from localStorage
const cartItemSchema = z.object({
  id: z.string(),
  price: z.coerce.number(),
  quantity: z.coerce.number(),
  variantId: z.string().optional()
});

// Schema for validating discount code
const validateDiscountSchema = z.object({
  code: z.string().min(1).openapi({ description: "Discount code to validate" }),
  total: z.coerce.number().optional().openapi({ description: "Cart total" }),
  items: z.array(cartItemSchema).optional().openapi({ description: "Cart items" }),
  shippingCost: z.coerce.number().optional().default(0).openapi({ description: "Shipping cost" }),
  customerPhone: z.string().optional().openapi({ description: "Customer phone for per-customer limits" })
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
      validationResult.applicableProductIds,
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

  // Strip internal applicableProductIds before sending to client
  const { applicableProductIds: _, ...clientResult } = validationResult;
  return ok(c, clientResult);
});

export { app as discountRoutes };
