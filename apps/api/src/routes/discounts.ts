import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ValidationError } from "@scalius/core/errors";
import { getCurrencyConfig } from "@scalius/core/modules/settings";
import { MAX_PRODUCT_PRICE } from "@scalius/core/modules/products";
import { quoteStorefrontDiscount } from "@scalius/core/modules/promotions";
import {
  previewStorefrontBundleSavings,
  resolveBundlePromotionInterplay,
} from "@scalius/core/modules/checkout";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import {
  quotedDiscountLineSchema,
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
  basePrice: z.number().finite().nonnegative().max(MAX_PRODUCT_PRICE).optional().openapi({
    description: "Unit price before buyer-input surcharges, which quantity bundles price from; defaults to `price`.",
  }),
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
        bundleDiscountAmount: z.number().openapi({ description: "Quantity-bundle saving included in totalDiscount (0 when the promotions save more)." }),
        bundles: z.array(z.object({
          productId: z.string(),
          quantity: z.number().int(),
          discountType: z.enum(["percentage", "fixed_price"]),
          label: z.string().nullable(),
        })),
        discounts: z.array(quotedDiscountLineSchema),
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
  const cartLines = lines.map(({ item, index, variantId }) => ({
    id: `cart:${index}:${variantId}`,
    productId: item.id,
    unitPriceMinor: toMinor(item.price, currency.decimalPlaces),
    baseUnitPriceMinor: toMinor(item.basePrice ?? item.price, currency.decimalPlaces),
    quantity: item.quantity,
  }));
  const discount = await quoteStorefrontDiscount(db, {
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
  // The same rule as the tax quote and the order: promotions or bundles,
  // whichever saves more (checkout/bundle-discounts.ts).
  const bundleSavings = await previewStorefrontBundleSavings(db, cartLines, currency.code);
  const interplay = resolveBundlePromotionInterplay(
    cartLines.map((line) => ({
      lineId: line.id,
      unitPriceMinor: line.unitPriceMinor,
      quantity: line.quantity,
      bundleDiscountMinor: bundleSavings.lineSavings.get(line) ?? 0,
    })),
    discount,
  );
  const quote = interplay.discount;
  return ok(c, {
    totalDiscount: fromMinor(
      (quote.applied?.totalDiscountMinor ?? 0) + interplay.bundleDiscountMinor,
      currency.decimalPlaces,
    ),
    bundleDiscountAmount: fromMinor(interplay.bundleDiscountMinor, currency.decimalPlaces),
    bundles: (interplay.bundleDiscountMinor > 0 ? bundleSavings.bundles : []).map((bundle) => ({
      productId: bundle.productId,
      quantity: bundle.quantity,
      discountType: bundle.discountType,
      label: bundle.label,
    })),
    ...presentStorefrontDiscountQuote(quote, currency.decimalPlaces),
  });
});

export { app as discountRoutes };
