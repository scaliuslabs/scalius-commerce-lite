import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ValidationError } from "@scalius/core/errors";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { MAX_PRODUCT_PRICE } from "@scalius/core/modules/products/products.types";
import { quoteStorefrontDiscount } from "@scalius/core/modules/promotions";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

// The storefront API client serializes numeric cart facts as JSON numbers.
// Reject null/empty/string coercion so crafted requests cannot turn them into 0.
const cartItemSchema = z.object({
  id: z.string().trim().min(1).max(100).openapi({ description: "Product id" }),
  price: z.number().finite().nonnegative().max(MAX_PRODUCT_PRICE),
  quantity: z.number().int().positive().max(10_000),
  variantId: z.string().trim().min(1).max(100).optional(),
});

const validateDiscountSchema = z.object({
  code: z.string().trim().min(1).max(50).openapi({ description: "Discount code to validate" }),
  items: z.array(cartItemSchema).max(99).optional().openapi({ description: "Cart items" }),
  shippingCost: z.number().finite().nonnegative().max(MAX_PRODUCT_PRICE).optional().default(0).openapi({ description: "Delivery charge" }),
  customerPhone: phoneNumberSchema.optional().openapi({ description: "Customer phone for per-customer limits" }),
});

// POST /discounts/validate — buyer/cart data stays in the body, never the URL.
const validateDiscountRoute = createRoute({
  method: "post",
  path: "/validate",
  tags: ["Discounts"],
  summary: "Validate a discount code against the cart",
  description: "Evaluates the code together with active automatic discounts. `discountAmount` is the cart's total savings when the code applies.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: validateDiscountSchema } },
    },
  },
  responses: {
    200: {
      description: "Discount validation result",
      content: { "application/json": { schema: successEnvelope(z.object({
        valid: z.boolean(),
        discount: z.object({
          id: z.string(),
          code: z.string(),
          type: z.literal("code"),
          discountValue: z.number(),
        }).optional(),
        discountAmount: z.number().optional(),
        error: z.string().optional(),
        requiresCustomerPhone: z.boolean().optional().openapi({ description: "The code has a per-customer limit: ask for the phone number." }),
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(validateDiscountRoute, async (c) => {
  const db = c.get("db");
  const { code, items = [], shippingCost, customerPhone } = c.req.valid("json");
  const lines = items.flatMap((item, index) => item.variantId ? [{ item, index, variantId: item.variantId }] : []);
  if (lines.length === 0 || lines.length !== items.length) {
    return ok(c, { valid: false, error: "Refresh the cart before applying this discount." });
  }
  const currency = await getCurrencyConfig(db);
  try {
    const quote = await quoteStorefrontDiscount(db, {
      code,
      customerPhone,
      cart: {
        currencyCode: currency.code,
        lines: lines.map(({ item, index, variantId }) => ({
          id: `cart:${index}:${variantId}`,
          productId: item.id,
          variantId,
          unitPriceMinor: toMinor(item.price, currency.decimalPlaces),
          quantity: item.quantity,
        })),
        shippingAmountMinor: toMinor(shippingCost, currency.decimalPlaces),
      },
    });
    const codeDiscount = quote.applied?.discounts.find(({ promotionCode }) => promotionCode !== null);
    if (!quote.applied || !codeDiscount) throw new ValidationError("This discount code is not valid.");
    const discountAmount = fromMinor(quote.applied.totalDiscountMinor, currency.decimalPlaces);
    return ok(c, {
      valid: true,
      discount: {
        id: codeDiscount.promotionId,
        code: codeDiscount.promotionCode!,
        type: "code" as const,
        discountValue: discountAmount,
      },
      discountAmount,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      const requiresCustomerPhone = (error.details as { requiresCustomerPhone?: boolean } | undefined)?.requiresCustomerPhone;
      return ok(c, { valid: false, error: error.message, ...(requiresCustomerPhone ? { requiresCustomerPhone } : {}) });
    }
    throw error;
  }
});

export { app as discountRoutes };
