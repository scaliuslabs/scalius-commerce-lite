import { z } from "@hono/zod-openapi";
import {
  MAX_SUBMITTED_DISCOUNT_CODES,
  type StorefrontDiscountOffer,
  type StorefrontDiscountQuote,
} from "@scalius/core/modules/promotions";
import { fromMinor } from "@scalius/shared/money";

/** Codes the buyer applied, in the order they typed them. */
export const discountCodesSchema = z
  .array(z.string().trim().min(1).max(50))
  .max(MAX_SUBMITTED_DISCOUNT_CODES)
  .default([])
  .openapi({ description: "Discount codes the buyer applied. Codes of different discount classes combine when either allows it." });

export const appliedDiscountLineSchema = z.object({
  promotionId: z.string(),
  title: z.string(),
  code: z.string().nullable(),
  amount: z.number(),
});

export const discountOfferSchema = z.object({
  promotionId: z.string(),
  title: z.string(),
  code: z.string().nullable(),
  kind: z.enum(["get", "buy"]),
  percentOff: z.number().openapi({ description: "100 means the items are free." }),
  quantity: z.number().int(),
  shortfallAmount: z.number().nullable(),
  products: z.array(z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    variantId: z.string().nullable().openapi({ description: "Set for simple products, which can be added in one tap." }),
    price: z.number().nullable(),
  })),
});

export const rejectedDiscountCodeSchema = z.object({
  code: z.string(),
  reason: z.enum([
    "not_found",
    "needs_phone",
    "minimum_subtotal",
    "minimum_quantity",
    "get_items",
    "buy_items",
    "not_combinable",
    "lower_savings",
    "unavailable",
  ]),
  message: z.string(),
  shortfallAmount: z.number().optional(),
  shortfallQuantity: z.number().int().optional(),
  conflictsWith: z.string().optional(),
  offer: discountOfferSchema.optional(),
  requiresCustomerPhone: z.boolean().optional(),
});

function presentOffer(offer: StorefrontDiscountOffer, decimalPlaces: number) {
  const { basisPoints, shortfallMinor, ...rest } = offer;
  return {
    ...rest,
    percentOff: basisPoints / 100,
    shortfallAmount: shortfallMinor === null ? null : fromMinor(shortfallMinor, decimalPlaces),
  };
}

/** The buyer-facing discount facts of a quote, in the decimal HTTP contract. */
export function presentStorefrontDiscountQuote(quote: StorefrontDiscountQuote, decimalPlaces: number) {
  return {
    discounts: quote.discounts.map(({ amountMinor, ...line }) => ({
      ...line,
      amount: fromMinor(amountMinor, decimalPlaces),
    })),
    offers: quote.offers.map((offer) => presentOffer(offer, decimalPlaces)),
    rejectedCodes: quote.rejectedCodes.map(({ shortfallMinor, offer, ...rejection }) => ({
      ...rejection,
      ...(shortfallMinor === undefined ? {} : { shortfallAmount: fromMinor(shortfallMinor, decimalPlaces) }),
      ...(offer ? { offer: presentOffer(offer, decimalPlaces) } : {}),
    })),
  };
}
