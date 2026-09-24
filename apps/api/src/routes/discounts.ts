import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ValidationError } from "@scalius/core/errors";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { MAX_PRODUCT_PRICE } from "@scalius/core/modules/products/products.types";
import { quoteStorefrontDiscount } from "@scalius/core/modules/promotions";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import {
  appliedDiscountLineSchema,
  discountCodesSchema,
  discountOfferSchema,
  presentStorefrontDiscountQuote,
  rejectedDiscountCodeSchema,
} from "../schemas/storefront-discounts";

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
  codes: discountCodesSchema,
  items: z.array(cartItemSchema).max(99).optional().openapi({ description: "Cart items" }),
  shippingCost: z.number().finite().nonnegative().max(MAX_PRODUCT_PRICE).optional().openapi({
    description: "Delivery charge of the chosen delivery option. Omit it before the buyer has one: delivery discounts then wait (`needs_delivery`) instead of failing.",
  }),
  customerPhone: phoneNumberSchema.optional().openapi({ description: "Customer phone for per-customer limits" }),
});

// POST /discounts/validate: buyer/cart data stays in the body, never the URL.
const validateDiscountRoute = createRoute({
  method: "post",
  path: "/validate",
  tags: ["Discounts"],
  summary: "Preview the cart's discounts before delivery is chosen",
  description: "Evaluates the applied codes together with active automatic discounts. Codes that do not apply are listed with the reason and add nothing.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: validateDiscountSchema } },
    },
  },
  responses: {
    200: {
      description: "Cart discount preview",
      content: { "application/json": { schema: successEnvelope(z.object({
        totalDiscount: z.number(),
        discounts: z.array(appliedDiscountLineSchema),
        offers: z.array(discountOfferSchema),
        rejectedCodes: z.array(rejectedDiscountCodeSchema),
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(validateDiscountRoute, async (c) => {
  const db = c.get("db");
  const { codes, items = [], shippingCost, customerPhone } = c.req.valid("json");
  const lines = items.flatMap((item, index) => item.variantId ? [{ item, index, variantId: item.variantId }] : []);
  if (lines.length !== items.length) {
    throw new ValidationError("Refresh the cart before applying a discount.");
  }
  const currency = await getCurrencyConfig(db);
  const quote = await quoteStorefrontDiscount(db, {
    codes,
    customerPhone,
    shippingKnown: shippingCost !== undefined,
    cart: {
      currencyCode: currency.code,
      lines: lines.map(({ item, index, variantId }) => ({
        id: `cart:${index}:${variantId}`,
        productId: item.id,
        variantId,
        unitPriceMinor: toMinor(item.price, currency.decimalPlaces),
        quantity: item.quantity,
      })),
      shippingAmountMinor: toMinor(shippingCost ?? 0, currency.decimalPlaces),
    },
  });
  return ok(c, {
    totalDiscount: fromMinor(quote.applied?.totalDiscountMinor ?? 0, currency.decimalPlaces),
    ...presentStorefrontDiscountQuote(quote, currency.decimalPlaces),
  });
});

export { app as discountRoutes };
