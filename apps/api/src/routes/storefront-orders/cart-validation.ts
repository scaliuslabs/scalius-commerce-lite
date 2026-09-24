// Authoritative cart validation preflight.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { InventoryPool } from "@scalius/database/schema";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCurrencySettings } from "@scalius/core/modules/settings";
import {
  presentStorefrontCartValidation,
  presentStorefrontDeliveryPreflight,
  validateStorefrontDeliveryPreflight,
  validateStorefrontCartItems,
} from "@scalius/core/modules/checkout";
import { ok } from "../../utils/api-response";
import { successEnvelope, errorResponses } from "../../schemas/responses";
import { persistedStorefrontVariantIdSchema, storefrontShippingMethodSnapshotSchema } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── POST / ──────────────────────────────────────────────────────────────────

const cartIssueSchema = z.object({
  index: z.number(),
  cartKey: z.string().nullable().optional(),
  productId: z.string(),
  variantId: z.string().nullable(),
  code: z.enum([
    "PRODUCT_UNAVAILABLE",
    "VARIANT_REQUIRED",
    "VARIANT_UNAVAILABLE",
    "VARIANT_MISMATCH",
    "QUANTITY_UNAVAILABLE",
    "PRICE_CHANGED",
  ]),
  action: z.enum(["remove", "select_variant", "reduce_quantity", "refresh_item"]),
  message: z.string(),
  productName: z.string().nullable(),
  variantLabel: z.string().nullable(),
  requestedQuantity: z.number(),
  availableQuantity: z.number().optional(),
  submittedPrice: z.number().optional(),
  currentPrice: z.number().optional(),
});

const cartValidationItemSchema = z.object({
  cartKey: z.string().min(1).max(256).optional().nullable(),
  productId: z.string().min(1, "Product is required"),
  variantId: persistedStorefrontVariantIdSchema,
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(99, "Quantity must be at most 99"),
  price: z.number().min(0, "Price must be greater than or equal to 0"),
  productName: z.string().optional().nullable(),
  variantLabel: z.string().optional().nullable(),
});

const cartValidationRoute = createRoute({
  method: "post",
  path: "/cart-validation",
  tags: ["Orders"],
  summary: "Validate a storefront cart before checkout",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(cartValidationItemSchema).min(1).max(99),
            inventoryPool: z
              .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
              .default(InventoryPool.REGULAR),
            city: z.string().min(1).optional().nullable(),
            zone: z.string().min(1).optional().nullable(),
            area: z.string().optional().nullable(),
            shippingMethodId: z.string().optional().nullable(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Cart validation result",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            valid: z.boolean(),
            issues: z.array(cartIssueSchema),
            items: z.array(z.object({
              index: z.number(),
              cartKey: z.string().nullable().optional(),
              productId: z.string(),
              variantId: persistedStorefrontVariantIdSchema,
              quantity: z.number(),
              unitPrice: z.number(),
              productName: z.string(),
              variantLabel: z.string().nullable(),
              freeDelivery: z.boolean(),
              availableQuantity: z.number().nullable(),
              productImageMediaId: z.string().nullable(),
              productImage: z.string().url().nullable(),
            })),
            subtotal: z.number(),
            hasFreeDeliveryProduct: z.boolean(),
            delivery: z.object({
              shippingCharge: z.number(),
              shippingMethod: storefrontShippingMethodSnapshotSchema,
              cityName: z.string(),
              zoneName: z.string(),
              areaName: z.string().nullable(),
            }).optional(),
          })),
        },
      },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(cartValidationRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const currency = await getCurrencySettings(db);
  const decimalPlaces = getDecimalPlaces(currency.currencyCode);
  const result = await validateStorefrontCartItems(db, data.items, {
    inventoryPool: data.inventoryPool,
    currencyCode: currency.currencyCode,
  });
  if (!result.valid || !data.city || !data.zone) {
    return ok(c, presentStorefrontCartValidation(result, decimalPlaces));
  }

  const delivery = await validateStorefrontDeliveryPreflight(
    db,
    {
      city: data.city,
      zone: data.zone,
      area: data.area,
      shippingMethodId: data.shippingMethodId,
    },
    result,
  );
  return ok(c, {
    ...presentStorefrontCartValidation(result, decimalPlaces),
    delivery: presentStorefrontDeliveryPreflight(delivery, decimalPlaces),
  });
});

export { app as cartValidationRoutes };
