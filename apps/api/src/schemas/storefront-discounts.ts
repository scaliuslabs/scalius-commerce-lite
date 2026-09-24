import { z } from "@hono/zod-openapi";
import {
  MAX_SUBMITTED_DISCOUNT_CODES,
  type OrderDiscountLine,
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
  amount: z.number().openapi({ description: "Off the items: shown as a discount line." }),
  shippingAmount: z.number().openapi({ description: "Off delivery: shown on the delivery line (\"Free\" with the fee struck through), never as a discount line." }),
});

/** A discount an order used, as receipts and order pages show it. */
export const orderDiscountLineSchema = appliedDiscountLineSchema.extend({
  kind: z.enum(["buy_x_get_y", "product", "order", "shipping"]).openapi({
    description: "The discount's main effect. Delivery savings are always in `shippingAmount`, whatever the kind.",
  }),
});

/** An order's discount lines in the decimal HTTP contract (receipt and account order page). */
export function presentOrderDiscountLines(lines: OrderDiscountLine[], decimalPlaces: number) {
  return lines.map((line) => ({
    promotionId: line.promotionId,
    title: line.title,
    code: line.code,
    kind: line.kind,
    amount: fromMinor(line.amountMinor, decimalPlaces),
    shippingAmount: fromMinor(line.shippingAmountMinor, decimalPlaces),
  }));
}

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
    "needs_delivery",
    "delivery_discount_applied",
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
    discounts: quote.discounts.map(({ amountMinor, shippingAmountMinor, ...line }) => ({
      ...line,
      amount: fromMinor(amountMinor, decimalPlaces),
      shippingAmount: fromMinor(shippingAmountMinor, decimalPlaces),
    })),
    offers: quote.offers.map((offer) => presentOffer(offer, decimalPlaces)),
    rejectedCodes: quote.rejectedCodes.map(({ shortfallMinor, offer, ...rejection }) => ({
      ...rejection,
      ...(shortfallMinor === undefined ? {} : { shortfallAmount: fromMinor(shortfallMinor, decimalPlaces) }),
      ...(offer ? { offer: presentOffer(offer, decimalPlaces) } : {}),
    })),
  };
}
