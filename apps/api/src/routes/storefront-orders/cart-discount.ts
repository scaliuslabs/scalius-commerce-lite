// The cart's discounts on the cart check (`POST /orders/cart-validation` with
// `discountCodes`): the cart page and the drawer read the applied codes'
// effect from the check they already make, priced by the check's own
// validated cart, delivery, destination, attributes and buyer, through the
// same authorities the quote calls (the store's discounts, then the apps').
import { z } from "@hono/zod-openapi";
import {
  platformDiscountClasses,
  previewStorefrontAppDiscounts,
  quotePlatformDiscount,
  type StorefrontCartValidationResult,
  type StorefrontDeliveryPreflightResult,
} from "@scalius/core/modules/checkout";
import type { Database } from "@scalius/database/client";
import { fromMinor } from "@scalius/shared/money";
import { presentmentPricingCurrency, type PresentmentMoney } from "@scalius/shared/presentment";
import {
  discountOfferSchema,
  presentStorefrontDiscountQuote,
  quotedDiscountLineSchema,
  rejectedDiscountCodeSchema,
} from "../../schemas/storefront-discounts";

type CheckoutApps = Parameters<typeof previewStorefrontAppDiscounts>[1]["apps"];
type AppDestination = Parameters<typeof previewStorefrontAppDiscounts>[1]["destination"];

export const cartDiscountSchema = z.object({
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
  lineDiscounts: z.array(z.object({
    index: z.number().int().min(0).openapi({ description: "The line's position in the request's `items`." }),
    discountMinor: z.number().int().min(0),
  })).openapi({
    description: "Each buyer line's share of the store's own discounts (promotions or quantity bundles), as checkout allocates it: a line it pays in full (a free gift) reads free. Store apps' discounts are not split by line here.",
  }),
}).openapi({
  description: "The applied codes with the store's automatic discounts, then the installed apps' (as checkout stacks them), on the lines this check can sell. Codes that do not apply are listed with the reason and add nothing. The checkout quote stays authoritative.",
});

export type CartDiscount = z.infer<typeof cartDiscountSchema>;

/** The cart's discounts as checkout will price them, for the lines the check validated. */
export async function priceCartDiscount(
  db: Database,
  input: {
    cart: Pick<StorefrontCartValidationResult, "items" | "bundles" | "marketContext" | "pricingSegmentIds">;
    money: PresentmentMoney;
    /** The store's own currency: an app's "store" amounts are in it. */
    shopCurrency: { code: string; decimalPlaces: number };
    apps: CheckoutApps;
    codes: readonly string[];
    customerId: string | null;
    customerPhone?: string | null;
    /** The delivery the check priced; null before one is chosen. */
    delivery: Pick<StorefrontDeliveryPreflightResult, "shippingMinor" | "shippingShares" | "fulfilment" | "address" | "cityName" | "zoneName"> | null;
    /** Nothing in the cart ships: delivery is known to cost nothing. */
    shipsNothing: boolean;
    /** Where the cart ships before a delivery is priced (its country), as the check's line prices read it. */
    destination: AppDestination;
    attributes: Record<string, string> | undefined;
    /** The buyer's lines (the request's `items`): each one's share is answered by its position. */
    buyerLineCount: number;
  },
): Promise<CartDiscount> {
  const { cart, money, delivery } = input;
  const currency = presentmentPricingCurrency(money);
  const shippingMinor = delivery?.shippingMinor ?? 0;
  // The same authority as the tax quote and the order (pricing.ts quotePlatformDiscount).
  const interplay = await quotePlatformDiscount(db, {
    items: cart.items,
    currency: { code: currency.code, priceIncrementMinor: currency.priceIncrementMinor },
    money,
    codes: input.codes,
    customerId: input.customerId,
    segmentCustomerId: input.customerId,
    customerPhone: input.customerPhone,
    shippingMinor,
    ...(delivery?.shippingShares ? { shippingShares: delivery.shippingShares } : {}),
    // Before a delivery option, delivery discounts wait (`needs_delivery`) instead of failing.
    shippingKnown: delivery !== null || input.shipsNothing,
  });
  // Apps' discounts stack after the platform's, on the cart the quote shows them.
  const appResolution = await previewStorefrontAppDiscounts(db, {
    marketContext: cart.marketContext,
    apps: input.apps,
    currency,
    storeCurrency: input.shopCurrency,
    lines: cart.items.map((item, position) => ({
      lineId: interplay.lineIds[position]!,
      productId: item.productId,
      variantId: item.variantId,
      title: item.variantLabel ? `${item.productName} (${item.variantLabel})` : item.productName,
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      properties: item.properties,
      purchaseOptions: (item.purchaseOptions ?? []).map((option) => option.id),
      bundle: item.bundle,
      ...(item.adjustments ? { adjustments: item.adjustments } : {}),
      ...(item.isGiftCard ? { giftCard: true } : {}),
    })),
    destination: delivery
      ? delivery.fulfilment.requiresShipping
        ? { country: delivery.address?.countryCode ?? null, city: delivery.cityName, zone: delivery.zoneName }
        : null
      : input.destination,
    attributes: input.attributes,
    customerId: input.customerId,
    ...(cart.pricingSegmentIds ? { segmentIds: cart.pricingSegmentIds } : {}),
    platformAllocation: interplay.allocation,
    platformClasses: platformDiscountClasses(interplay),
    shippingMinor,
    discountCodes: input.codes,
  });
  // A code an app claimed is the app's, not an unknown code.
  const claimed = new Set(appResolution?.claimedCodes ?? []);
  const quote = claimed.size > 0
    ? {
      ...interplay.discount,
      rejectedCodes: interplay.discount.rejectedCodes.filter((rejection) =>
        !(rejection.reason === "not_found" && claimed.has(rejection.code.trim().toUpperCase()))),
    }
    : interplay.discount;
  const appDiscountMinor = (appResolution?.merchandiseMinor ?? 0) + (appResolution?.shippingMinor ?? 0);
  // Each buyer line's share: a kit's lines (its items) and an app's rewritten lines speak for the buyer's line.
  const sourceOf = new Map(cart.items.map((item, position) => [interplay.lineIds[position]!, item.sourceIndex]));
  const shares = new Array<number>(input.buyerLineCount).fill(0);
  for (const line of interplay.allocation?.lines ?? []) {
    const index = sourceOf.get(line.lineId);
    if (index !== undefined && index >= 0 && index < shares.length) shares[index] = shares[index]! + line.amountMinor;
  }
  return {
    totalDiscount: fromMinor(
      (quote.applied?.totalDiscountMinor ?? 0) + interplay.bundleDiscountMinor + appDiscountMinor,
      currency.decimalPlaces,
    ),
    bundleDiscountAmount: fromMinor(interplay.bundleDiscountMinor, currency.decimalPlaces),
    bundles: (interplay.bundleDiscountMinor > 0 ? cart.bundles ?? [] : []).map((bundle) => ({
      productId: bundle.productId,
      quantity: bundle.quantity,
      discountType: bundle.discountType,
      label: bundle.label,
    })),
    ...presentStorefrontDiscountQuote(quote, currency.decimalPlaces, appResolution?.applied ?? []),
    lineDiscounts: shares.map((discountMinor, index) => ({ index, discountMinor })),
  };
}
