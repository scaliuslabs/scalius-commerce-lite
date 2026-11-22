import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MAX_ORDER_LINES } from "@scalius/shared/order-limits";
import { ValidationError } from "@scalius/core/errors";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { isMarketSubfolder } from "@scalius/shared/markets";
import { presentmentPricingCurrency } from "@scalius/shared/presentment";
import { MAX_MAJOR_AMOUNT } from "@scalius/shared/money";
import { getCustomerBySession } from "@scalius/core/modules/customers";
import {
  platformDiscountClasses,
  previewStorefrontAppDiscounts,
  quotePlatformDiscount,
  validateStorefrontCartItems,
} from "@scalius/core/modules/checkout";
import { listActiveFunctionRegistrations } from "@scalius/core/modules/plugins";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

import { ok } from "../utils/api-response";
import { getOptionalExecutionContext } from "../utils/execution-context";
import { createCheckoutAppFunctions, requestBuyerLanguage } from "../plugins/checkout-functions";
import { getCustomerSessionHashKey } from "../utils/encryption-key";
import { getCustomerSessionTokenFromRequest } from "./storefront-orders/shared";
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
  quantity: z.number().int().positive().max(10_000),
  variantId: z.string().trim().min(1).max(100).optional(),
}).openapi({ description: "A cart line. Prices are the catalogue's, as checkout charges them (a kit at its price), never the client's." });

const validateDiscountSchema = z.object({
  codes: discountCodesSchema,
  items: z.array(cartItemSchema).max(MAX_ORDER_LINES).optional().openapi({ description: "Cart items" }),
  shippingCost: z.number().finite().nonnegative().max(MAX_MAJOR_AMOUNT).optional().openapi({
    description: "Delivery charge of the chosen delivery option. Omit it before the buyer has one: delivery discounts then wait (`needs_delivery`) instead of failing.",
  }),
  customerPhone: phoneNumberSchema.optional().openapi({ description: "Customer phone for per-customer limits" }),
  presence: z.string().max(5).optional().openapi({ description: "The page's subfolder presence (`en-gb`): a market in its own currency previews in it, its shop amounts converted at its rate (MARKETS-DESIGN step 6). Omit at the root." }),
});

// POST /discounts/validate: buyer/cart data stays in the body, never the URL.
const validateDiscountRoute = createRoute({
  method: "post",
  path: "/validate",
  tags: ["Discounts"],
  summary: "Preview the cart's discounts before delivery is chosen",
  description: "Evaluates the applied codes together with active automatic discounts, then installed apps' discounts on top (as checkout stacks them). Codes that do not apply are listed with the reason and add nothing.",
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
        lineDiscounts: z.array(z.object({
          index: z.number().int().min(0).openapi({ description: "The line's position in `items`." }),
          discountMinor: z.number().int().min(0),
        })).openapi({
          description: "Each cart line's share of the store's own discounts (promotions or quantity bundles), as checkout allocates it: a line it pays in full (a free gift) reads free. Store apps' discounts are not split by line here.",
        }),
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(validateDiscountRoute, async (c) => {
  const db = c.get("db");
  const { codes, items = [], shippingCost, customerPhone, presence } = c.req.valid("json");
  const lines = items.flatMap((item, index) => item.variantId ? [{ item, index, variantId: item.variantId }] : []);
  if (lines.length !== items.length) {
    throw new ValidationError("Refresh the cart before applying a discount.");
  }
  // One read wave: the apps' checkout functions (none, no app work) and the
  // signed-in buyer, who previews as checkout will price them (their segment
  // discounts and per-customer limits); a missing or stale session is a guest.
  const sessionToken = getCustomerSessionTokenFromRequest(c);
  const [shopCurrency, registrations, sessionCustomer] = await Promise.all([
    readStoreCurrency(db),
    listActiveFunctionRegistrations(db),
    sessionToken
      ? getCustomerBySession(db, sessionToken, getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>))
      : null,
  ]);
  const signedInCustomerId = sessionCustomer?.customerId ?? null;
  // The cart priced as checkout prices it, from the catalogue (never the
  // client's numbers): the page's market, a kit sold as its items at its price.
  const cart = await validateStorefrontCartItems(db, lines.map(({ item, variantId }) => ({
    productId: item.id,
    variantId,
    quantity: item.quantity,
  })), {
    currencyCode: shopCurrency.code,
    priceIncrementMinor: shopCurrency.priceIncrementMinor,
    market: { ...(presence && isMarketSubfolder(presence) ? { presence } : {}), customerId: signedInCustomerId },
  });
  const money = cart.money;
  const currency = { ...presentmentPricingCurrency(money), symbol: shopCurrency.symbol };
  const shippingMinor = toMinor(shippingCost ?? 0, currency.decimalPlaces);
  // The same authority as the tax quote and the order (pricing.ts quotePlatformDiscount).
  const interplay = await quotePlatformDiscount(db, {
    items: cart.items,
    currency: { code: currency.code, priceIncrementMinor: currency.priceIncrementMinor },
    money,
    codes,
    customerId: signedInCustomerId,
    segmentCustomerId: signedInCustomerId,
    customerPhone,
    shippingMinor,
    shippingKnown: shippingCost !== undefined,
  });
  // Apps' discounts stack after the platform's, exactly as at checkout.
  const apps = previewStorefrontAppDiscounts(db, {
    marketContext: cart.marketContext,
    apps: createCheckoutAppFunctions({
      env: c.env,
      // The buyer's language: every app word and function run speaks it.
      language: requestBuyerLanguage(presence),
      ctx: getOptionalExecutionContext(c) as ExecutionContext | undefined,
      db,
      registrations,
      buyerRequest: c.req.raw,
    }),
    currency: { code: currency.code, decimalPlaces: currency.decimalPlaces, priceIncrementMinor: currency.priceIncrementMinor },
    // A market's preview is in its currency; an app's store amounts are in the shop's.
    storeCurrency: { code: shopCurrency.code, decimalPlaces: shopCurrency.decimalPlaces },
    lines: cart.items.map((item, position) => ({
      lineId: interplay.lineIds[position]!,
      productId: item.productId,
      variantId: item.variantId,
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      ...(item.isGiftCard ? { giftCard: true } : {}),
    })),
    platformAllocation: interplay.allocation,
    platformClasses: platformDiscountClasses(interplay),
    shippingMinor,
    discountCodes: codes,
  });
  const appResolution = await apps;
  const claimed = new Set(appResolution?.claimedCodes ?? []);
  const quote = claimed.size > 0
    ? {
      ...interplay.discount,
      rejectedCodes: interplay.discount.rejectedCodes.filter((rejection) =>
        !(rejection.reason === "not_found" && claimed.has(rejection.code.trim().toUpperCase()))),
    }
    : interplay.discount;
  const appDiscountMinor = (appResolution?.merchandiseMinor ?? 0) + (appResolution?.shippingMinor ?? 0);
  // Each buyer line's share: a kit's lines (its items) speak for the kit's line.
  const sourceOf = new Map(cart.items.map((item, position) => [interplay.lineIds[position]!, item.sourceIndex]));
  return ok(c, {
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
    // Each line's share, as the quote and the order keep it (by the same allocation ids).
    lineDiscounts: lines.map(({ index }) => ({
      index,
      discountMinor: (interplay.allocation?.lines ?? [])
        .filter((line) => sourceOf.get(line.lineId) === index)
        .reduce((total, line) => total + line.amountMinor, 0),
    })),
  });
});

export { app as discountRoutes };
