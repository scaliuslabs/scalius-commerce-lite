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
    validateStorefrontDeliveryPreflight,
    validateStorefrontCartItems,
} from "@scalius/core/modules/checkout";
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
  shippingMethod: storefrontShippingMethodSnapshotSchema,
  discounts: z.array(quotedDiscountLineSchema).openapi({
    description: "One line per applied discount (automatic and code), with its own amount.",
  }),
  offers: z.array(discountOfferSchema).max(3).openapi({
    description: "Automatic Buy X get Y discounts the buyer has earned but not claimed: the items to get are not in the cart yet.",
  }),
  rejectedCodes: z.array(rejectedDiscountCodeSchema).openapi({
    description: "Submitted codes that do not apply right now, with the reason. They add nothing to the totals.",
  }),
  items: z.array(z.object({
    cartKey: z.string().nullable().optional(),
    productId: z.string(),
    variantId: z.string(),
    quantity: z.number().int(),
    unitPrice: z.number(),
    productName: z.string(),
    variantLabel: z.string().nullable(),
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
            city: z.string().min(1).max(180),
            zone: z.string().min(1).max(180),
            area: z.string().max(180).optional().nullable(),
            shippingMethodId: z.string().min(1).max(180),
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
  destination: { city: string; zone: string; area?: string | null },
  currencyCode: string,
): Promise<{ quote: TaxQuote; discount: StorefrontDiscountQuote }> {
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

  const quote = await calculateStorefrontTaxQuote(db, {
    destination: {
      city: destination.city,
      zone: destination.zone,
      area: destination.area ?? null,
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
    promotionDiscountAllocation: discount.taxAllocation,
    currency: { code: currencyCode, decimalPlaces },
  });
  return { quote, discount };
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
  const currency = await getCurrencySettings(db);
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
  const { quote, discount } = await resolveAuthoritativeTaxQuote(
    db,
    {
      discountCodes: data.discountCodes,
      customerPhone: data.customerPhone,
      customerId: sessionCustomer?.customerId ?? null,
    },
    cartValidation,
    delivery,
    data,
    currency.currencyCode,
  );
  const toAmount = (minor: number) => fromMinor(minor, quote.decimalPlaces);
  return ok(c, {
    valid: true as const,
    quoteFingerprint: await buildStorefrontCheckoutQuoteFingerprint(
      quote,
      delivery.shippingMethod,
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
    ...presentStorefrontDiscountQuote(discount, quote.decimalPlaces),
    items: cartValidation.items.map((item) => ({
      cartKey: item.cartKey ?? null,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPrice: toAmount(item.unitPriceMinor),
      productName: item.productName,
      variantLabel: item.variantLabel,
    })),
  });
});

export { app as taxQuoteRoutes };
