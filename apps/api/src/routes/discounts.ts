import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { isDiscountValid, calculateDiscountAmount } from "@scalius/core/modules/discounts/discounts.eligibility";
import { MAX_PRODUCT_PRICE } from "@scalius/core/modules/products/products.types";
import {
  evaluateStorefrontPromotionCode,
  resolvePromotionCustomerIdByPhone,
} from "@scalius/core/modules/promotions";
import { fromMinorUnits, toMinorUnits } from "@scalius/core/modules/tax";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

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
  customerPhone: phoneNumberSchema.optional().openapi({ description: "Customer phone for per-customer limits" })
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
        requiresCustomerPhone: z.boolean().optional(),
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

  const normalizedCode = code.trim().toUpperCase();
  const promotionCustomerId = customerPhone
    ? await resolvePromotionCustomerIdByPhone(db, customerPhone)
    : null;
  const typedItemsReady = cartItems.length > 0
    && cartItems.every((item) => typeof item.variantId === "string" && item.variantId.trim().length > 0);
  const promotionResolution = await evaluateStorefrontPromotionCode(db, {
    code: normalizedCode,
    customerId: promotionCustomerId,
    cart: {
      currencyCode: currencyConfig.code,
      lines: typedItemsReady
        ? cartItems.map((item, index) => ({
          id: `cart:${index}:${item.variantId!}`,
          productId: item.id,
          variantId: item.variantId!,
          unitPriceMinor: toMinorUnits(item.price, currencyConfig.decimalPlaces),
          quantity: item.quantity,
        }))
        : [],
      shippingAmountMinor: toMinorUnits(shippingCost, currencyConfig.decimalPlaces),
      evaluatedAtEpochSeconds: Math.floor(Date.now() / 1_000),
    },
  });
  if (promotionResolution.matched) {
    if (!typedItemsReady) {
      return ok(c, {
        valid: false,
        error: "Refresh the cart before applying this discount.",
      });
    }
    if (!promotionResolution.valid) {
      return ok(c, {
        valid: false,
        error: promotionResolution.message,
      });
    }
    const discountAmount = fromMinorUnits(
      promotionResolution.evaluation.applied.totalDiscountMinor,
      currencyConfig.decimalPlaces,
    );
    return ok(c, {
      valid: true,
      discount: {
        id: promotionResolution.evaluation.applied.promotionId,
        code: normalizedCode,
        type: "promotion",
        discountValue: roundPrice(discountAmount, currencyConfig.code),
      },
      discountAmount: roundPrice(discountAmount, currencyConfig.code),
    });
  }

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
