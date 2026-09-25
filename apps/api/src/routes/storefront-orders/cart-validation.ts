// Authoritative cart validation preflight.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { InventoryPool } from "@scalius/database/schema";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCurrencySettings } from "@scalius/core/modules/settings";
import { getActivePaymentMethods } from "@scalius/core/modules/payments";
import {
  presentStorefrontCartValidation,
  presentStorefrontDeliveryPreflight,
  resolveCartPaymentMethods,
  storefrontLinePropertiesHashes,
  summarizeStorefrontCartFulfilment,
  validateStorefrontDeliveryPreflight,
  validateStorefrontCartItems,
} from "@scalius/core/modules/checkout";
import { ok } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope, errorResponses } from "../../schemas/responses";
import {
  allowedPaymentMethodsSchema,
  deliveryMethodKindSchema,
  fulfillmentKindSchema,
  fulfillmentTypeSchema,
  linePropertiesInputSchema,
  orderLinePropertySchema,
} from "../../schemas/order-lines";
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
    "PROPERTIES_REQUIRED",
    "PROPERTIES_INVALID",
    "FULFILMENT_UNAVAILABLE",
  ]),
  action: z.enum(["remove", "select_variant", "reduce_quantity", "refresh_item", "edit_properties"]),
  message: z.string(),
  productName: z.string().nullable(),
  variantLabel: z.string().nullable(),
  requestedQuantity: z.number(),
  availableQuantity: z.number().optional(),
  submittedPrice: z.number().optional(),
  currentPrice: z.number().optional(),
  /** The buyer input a PROPERTIES_* issue is about, when it is one field. */
  propertyKey: z.string().nullable().optional(),
});

const cartValidationItemSchema = z.object({
  cartKey: z.string().min(1).max(256).optional().nullable(),
  productId: z.string().min(1, "Product is required"),
  variantId: persistedStorefrontVariantIdSchema,
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(99, "Quantity must be at most 99"),
  /** The unit price the buyer saw: base plus the surcharges of its buyer inputs. */
  price: z.number().min(0, "Price must be greater than or equal to 0"),
  productName: z.string().optional().nullable(),
  variantLabel: z.string().optional().nullable(),
  properties: linePropertiesInputSchema,
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
            /** A delivery or pickup rate. A pickup rate needs no city or zone. */
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
              /** One unit: base plus surcharges. */
              unitPrice: z.number(),
              /** One unit before the surcharges of its buyer inputs. */
              baseUnitPrice: z.number(),
              propertiesPrice: z.number(),
              propertiesPriceMinor: z.number().int(),
              /** The buyer inputs as the order will keep them (labels frozen). */
              properties: z.array(orderLinePropertySchema),
              /** Canonical inputs hash for the cart line key (`line:v3:…:p:<hash>`); "none" without inputs. */
              propertiesHash: z.string(),
              fulfillmentKind: fulfillmentKindSchema,
              /** Null for a physical line until a delivery or pickup method is chosen. */
              fulfillmentType: fulfillmentTypeSchema.nullable(),
              productName: z.string(),
              variantLabel: z.string().nullable(),
              freeDelivery: z.boolean(),
              availableQuantity: z.number().nullable(),
              productImageMediaId: z.string().nullable(),
              productImage: z.string().url().nullable(),
            })),
            subtotal: z.number(),
            hasFreeDeliveryProduct: z.boolean(),
            /** Some line is physical: the buyer must choose delivery or pickup. */
            requiresDeliveryMethod: z.boolean(),
            /** The chosen method's kind; null until one is chosen or when nothing is physical. */
            deliveryMethodKind: deliveryMethodKindSchema.nullable(),
            /** Some line ships to an address (a delivery method was chosen for physical lines). */
            requiresShipping: z.boolean(),
            allowedPaymentMethods: allowedPaymentMethodsSchema,
            delivery: z.object({
              kind: deliveryMethodKindSchema,
              shippingCharge: z.number(),
              shippingMethod: storefrontShippingMethodSnapshotSchema,
              /** Null for pickup. */
              cityName: z.string().nullable(),
              zoneName: z.string().nullable(),
              areaName: z.string().nullable(),
              /** Where and when to collect, for a pickup method. */
              pickup: z.object({ address: z.string().nullable(), hours: z.string().nullable() }).nullable(),
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
  const [currency, paymentMethods] = await Promise.all([
    getCurrencySettings(db),
    getActivePaymentMethods(db, getCredentialEncryptionKey(c.env as Record<string, unknown>)),
  ]);
  const decimalPlaces = getDecimalPlaces(currency.currencyCode);
  const result = await validateStorefrontCartItems(db, data.items, {
    inventoryPool: data.inventoryPool,
    currencyCode: currency.currencyCode,
  });
  const propertiesHashes = await storefrontLinePropertiesHashes(result);
  const cartOnly = summarizeStorefrontCartFulfilment(result, null);
  const cartOnlyPayment = resolveCartPaymentMethods(paymentMethods.enabledMethods, cartOnly);
  // Delivery is priced once a method is chosen: a pickup rate needs no
  // address, a delivery rate needs city and zone.
  const wantsDelivery = Boolean(data.shippingMethodId) || Boolean(data.city && data.zone);
  if (!result.valid || !cartOnly.requiresDeliveryMethod || !wantsDelivery) {
    return ok(c, {
      ...presentStorefrontCartValidation(result, decimalPlaces, cartOnly, propertiesHashes),
      allowedPaymentMethods: cartOnlyPayment,
    });
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
  const presented = presentStorefrontDeliveryPreflight(delivery, decimalPlaces);
  return ok(c, {
    ...presentStorefrontCartValidation(result, decimalPlaces, delivery.fulfilment, propertiesHashes),
    allowedPaymentMethods: resolveCartPaymentMethods(paymentMethods.enabledMethods, delivery.fulfilment),
    ...(delivery.kind && delivery.shippingMethod
      ? {
        delivery: {
          kind: delivery.kind,
          shippingCharge: presented.shippingCharge,
          shippingMethod: delivery.shippingMethod,
          cityName: delivery.cityName,
          zoneName: delivery.zoneName,
          areaName: delivery.areaName,
          pickup: delivery.pickup,
        },
      }
      : {}),
  });
});

export { app as cartValidationRoutes };
