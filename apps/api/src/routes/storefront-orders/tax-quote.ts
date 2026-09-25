// Authoritative checkout tax quote.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { InventoryPool } from "@scalius/database/schema";
import { quoteStorefrontDiscount, type StorefrontDiscountQuote } from "@scalius/core/modules/promotions";
import {
    quotedDiscountLineSchema,
    discountCodesSchema,
    discountOfferSchema,
    presentStorefrontDiscountQuote,
    rejectedDiscountCodeSchema,
} from "../../schemas/storefront-discounts";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCustomerBySession } from "@scalius/core/modules/customers";
import { fromMinor } from "@scalius/shared/money";
import { getCurrencySettings } from "@scalius/core/modules/settings";
import { buildStorefrontCheckoutQuoteFingerprint } from "@scalius/core/modules/checkout/browser";
import {
    applyBundleSavingsToDiscountAllocation,
    assertStorefrontLineFulfilment,
    resolveCartPaymentMethods,
    storefrontLinePropertiesHashes,
    validateStorefrontDeliveryPreflight,
    validateStorefrontCartItems,
} from "@scalius/core/modules/checkout";
import { getActivePaymentMethods } from "@scalius/core/modules/payments";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
    allowedPaymentMethodsSchema,
    deliveryMethodKindSchema,
    fulfillmentTypeSchema,
    linePropertiesInputSchema,
    orderLinePropertySchema,
} from "../../schemas/order-lines";
import { buildStorefrontTaxAllocationLineId, calculateStorefrontTaxQuote } from "@scalius/core/modules/tax";
import { type TaxQuote } from "@scalius/core/modules/tax/browser";
import { ValidationError } from "../../utils/api-error";
import { getCustomerSessionHashKey } from "../../utils/encryption-key";
import { ok } from "../../utils/api-response";
import { successEnvelope, errorResponses } from "../../schemas/responses";
import {
    persistedStorefrontVariantIdSchema,
    storefrontShippingMethodSnapshotSchema,
    getCustomerSessionTokenFromRequest,
} from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const taxQuoteItemSchema = z.object({
  cartKey: z.string().min(1).max(256).optional().nullable(),
  productId: z.string().min(1, "Product is required").max(180),
  variantId: persistedStorefrontVariantIdSchema,
  quantity: z.number().int().min(1).max(99),
  productName: z.string().max(200).optional().nullable(),
  variantLabel: z.string().max(200).optional().nullable(),
  properties: linePropertiesInputSchema,
});

const taxQuoteResponseSchema = z.object({
  valid: z.literal(true),
  quoteFingerprint: z.string(),
  displayLabel: z.string(),
  pricesIncludeTax: z.boolean(),
  shippingTaxed: z.boolean(),
  currencyCode: z.string(),
  decimalPlaces: z.number().int(),
  settingsVersion: z.number().int(),
  subtotalMinor: z.number().int(),
  subtotalAmount: z.number(),
  shippingMinor: z.number().int(),
  shippingAmount: z.number(),
  discountMinor: z.number().int(),
  discountAmount: z.number(),
  taxMinor: z.number().int(),
  taxAmount: z.number(),
  totalMinor: z.number().int(),
  totalAmount: z.number(),
  /** Null when the cart has nothing physical (no delivery method, no fee). */
  shippingMethod: storefrontShippingMethodSnapshotSchema.nullable(),
  deliveryMethodKind: deliveryMethodKindSchema.nullable(),
  /** Some line ships: the order needs the delivery address. */
  requiresShipping: z.boolean(),
  /** Pickup location and hours, for a pickup method. */
  pickup: z.object({ address: z.string().nullable(), hours: z.string().nullable() }).nullable(),
  allowedPaymentMethods: allowedPaymentMethodsSchema,
  discounts: z.array(quotedDiscountLineSchema).openapi({
    description: "One line per applied discount (automatic and code), with its own amount.",
  }),
  offers: z.array(discountOfferSchema).max(3).openapi({
    description: "Automatic Buy X get Y discounts the buyer has earned but not claimed: the items to get are not in the cart yet.",
  }),
  rejectedCodes: z.array(rejectedDiscountCodeSchema).openapi({
    description: "Submitted codes that do not apply right now, with the reason. They add nothing to the totals.",
  }),
  bundleDiscountMinor: z.number().int().nonnegative().openapi({
    description: "The quantity-bundle part of `discountMinor`; the rest is the discounts above.",
  }),
  bundleDiscountAmount: z.number().nonnegative(),
  bundles: z.array(z.object({
    productId: z.string(),
    quantity: z.number().int().openapi({ description: "The tier the product's cart quantity reached (\"3 for ...\")." }),
    discountType: z.enum(["percentage", "fixed_price"]),
    label: z.string().nullable(),
  })).openapi({
    description: "Products whose cart quantity reached a bundle tier. Bundles add to promotions, which are evaluated at catalog prices.",
  }),
  items: z.array(z.object({
    cartKey: z.string().nullable().optional(),
    productId: z.string(),
    variantId: z.string(),
    quantity: z.number().int(),
    unitPrice: z.number(),
    productName: z.string(),
    variantLabel: z.string().nullable(),
    fulfillmentType: fulfillmentTypeSchema,
    properties: z.array(orderLinePropertySchema),
    propertiesPriceMinor: z.number().int(),
    propertiesHash: z.string(),
  })),
});

const taxQuoteRoute = createRoute({
  method: "post",
  path: "/tax-quote",
  tags: ["Orders"],
  summary: "Calculate an authoritative storefront tax quote",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(taxQuoteItemSchema).min(1).max(99),
            inventoryPool: z.enum([
              InventoryPool.REGULAR,
              InventoryPool.PREORDER,
              InventoryPool.BACKORDER,
            ]).default(InventoryPool.REGULAR),
            /** Required for a delivery method; omitted for pickup or when nothing is physical. */
            city: z.string().min(1).max(180).optional().nullable(),
            zone: z.string().min(1).max(180).optional().nullable(),
            area: z.string().max(180).optional().nullable(),
            /** Required when a line is physical; omitted when nothing is. */
            shippingMethodId: z.string().min(1).max(180).optional().nullable(),
            discountCodes: discountCodesSchema,
            customerPhone: phoneNumberSchema.optional().nullable(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Authoritative tax quote",
      content: { "application/json": { schema: successEnvelope(taxQuoteResponseSchema) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

type TaxQuoteCartValidationResult = Awaited<ReturnType<typeof validateStorefrontCartItems>>;
type TaxQuoteDeliveryResult = Awaited<ReturnType<typeof validateStorefrontDeliveryPreflight>>;

async function resolveAuthoritativeTaxQuote(
  db: Database,
  input: {
    discountCodes: string[];
    customerPhone?: string | null;
    customerId?: string | null;
  },
  cartValidation: TaxQuoteCartValidationResult,
  delivery: TaxQuoteDeliveryResult,
  currencyCode: string,
): Promise<{ quote: TaxQuote; discount: StorefrontDiscountQuote; bundleDiscountMinor: number }> {
  const decimalPlaces = getDecimalPlaces(currencyCode);
  const discount = await quoteStorefrontDiscount(db, {
    codes: input.discountCodes,
    customerId: input.customerId,
    customerPhone: input.customerPhone,
    cart: {
      currencyCode,
      lines: cartValidation.items.map((item) => ({
        id: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
        productId: item.productId,
        variantId: item.variantId,
        unitPriceMinor: item.unitPriceMinor,
        quantity: item.quantity,
      })),
      shippingAmountMinor: delivery.shippingMinor,
    },
  });

  // Quantity bundles add to the promotion's line discounts (the same rule the order commits).
  const bundleDiscount = applyBundleSavingsToDiscountAllocation(
    cartValidation.items.map((item) => ({
      lineId: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      bundleDiscountMinor: item.bundleDiscountMinor ?? 0,
    })),
    discount.taxAllocation,
  );
  const quote = await calculateStorefrontTaxQuote(db, {
    // No address (pickup, service, digital): only store-wide rates apply.
    destination: {
      city: delivery.fulfilment.requiresShipping ? delivery.address?.city ?? null : null,
      zone: delivery.fulfilment.requiresShipping ? delivery.address?.zone ?? null : null,
      area: delivery.fulfilment.requiresShipping ? delivery.address?.area ?? null : null,
      cityName: delivery.cityName,
      zoneName: delivery.zoneName,
      areaName: delivery.areaName,
    },
    lines: cartValidation.items.map((item) => ({
      lineId: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
      productId: item.productId,
      variantId: item.variantId,
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      taxClassId: item.taxClassId,
    })),
    shippingMinor: delivery.shippingMinor,
    promotionDiscountAllocation: bundleDiscount.allocation,
    currency: { code: currencyCode, decimalPlaces },
  });
  return { quote, discount, bundleDiscountMinor: bundleDiscount.bundleDiscountMinor };
}

app.openapi(taxQuoteRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const customerSessionToken = getCustomerSessionTokenFromRequest(c);
  const sessionCustomer = customerSessionToken && data.discountCodes.length > 0
    ? await getCustomerBySession(
        db,
        customerSessionToken,
        getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
      )
    : null;
  const [currency, paymentMethods] = await Promise.all([
    getCurrencySettings(db),
    getActivePaymentMethods(db, getCredentialEncryptionKey(c.env as Record<string, unknown>)),
  ]);
  const cartValidation = await validateStorefrontCartItems(db, data.items, {
    inventoryPool: data.inventoryPool,
    currencyCode: currency.currencyCode,
  });
  if (!cartValidation.valid) {
    throw new ValidationError("Some items in your cart need attention.", {
      itemIssues: cartValidation.issues,
    });
  }
  const delivery = await validateStorefrontDeliveryPreflight(db, {
    city: data.city,
    zone: data.zone,
    area: data.area,
    shippingMethodId: data.shippingMethodId,
  }, cartValidation);
  const lineTypes = assertStorefrontLineFulfilment(cartValidation, delivery);
  const linePropertiesHashes = await storefrontLinePropertiesHashes(cartValidation);
  const { quote, discount, bundleDiscountMinor } = await resolveAuthoritativeTaxQuote(
    db,
    {
      discountCodes: data.discountCodes,
      customerPhone: data.customerPhone,
      customerId: sessionCustomer?.customerId ?? null,
    },
    cartValidation,
    delivery,
    currency.currencyCode,
  );
  const toAmount = (minor: number) => fromMinor(minor, quote.decimalPlaces);
  return ok(c, {
    valid: true as const,
    quoteFingerprint: await buildStorefrontCheckoutQuoteFingerprint(
      quote,
      delivery.shippingMethod,
      linePropertiesHashes,
    ),
    displayLabel: quote.displayLabel,
    pricesIncludeTax: quote.pricesIncludeTax,
    shippingTaxed: quote.shippingTaxed,
    currencyCode: quote.currencyCode,
    decimalPlaces: quote.decimalPlaces,
    settingsVersion: quote.settingsVersion,
    subtotalMinor: quote.subtotalMinor,
    subtotalAmount: toAmount(quote.subtotalMinor),
    shippingMinor: quote.shippingMinor,
    shippingAmount: toAmount(quote.shippingMinor),
    discountMinor: quote.discountMinor,
    discountAmount: toAmount(quote.discountMinor),
    taxMinor: quote.taxMinor,
    taxAmount: toAmount(quote.taxMinor),
    totalMinor: quote.totalMinor,
    totalAmount: toAmount(quote.totalMinor),
    shippingMethod: delivery.shippingMethod,
    deliveryMethodKind: delivery.kind,
    requiresShipping: delivery.fulfilment.requiresShipping,
    pickup: delivery.pickup,
    allowedPaymentMethods: resolveCartPaymentMethods(paymentMethods.enabledMethods, delivery.fulfilment),
    ...presentStorefrontDiscountQuote(discount, quote.decimalPlaces),
    bundleDiscountMinor,
    bundleDiscountAmount: toAmount(bundleDiscountMinor),
    bundles: (cartValidation.bundles ?? []).map((bundle) => ({
      productId: bundle.productId,
      quantity: bundle.quantity,
      discountType: bundle.discountType,
      label: bundle.label,
    })),
    items: cartValidation.items.map((item, position) => ({
      cartKey: item.cartKey ?? null,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice: toAmount(item.unitPriceMinor),
      productName: item.productName,
      variantLabel: item.variantLabel,
      fulfillmentType: lineTypes[position]!,
      properties: item.properties.map((property) => ({
        ...property,
        price: toAmount(property.priceMinor),
      })),
      propertiesPriceMinor: item.propertiesPriceMinor,
      propertiesHash: linePropertiesHashes[position]!,
    })),
  });
});

export { app as taxQuoteRoutes };
