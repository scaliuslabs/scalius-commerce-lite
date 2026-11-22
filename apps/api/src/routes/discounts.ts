import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MAX_ORDER_LINES } from "@scalius/shared/order-limits";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { isMarketSubfolder } from "@scalius/shared/markets";
import { presentmentPricingCurrency } from "@scalius/shared/presentment";
import { MAX_MAJOR_AMOUNT } from "@scalius/shared/money";
import { getCustomerBySession } from "@scalius/core/modules/customers";
import {
  platformDiscountClasses,
  previewStorefrontAppDiscounts,
  quotePlatformDiscount,
  validateCheckoutAttributes,
} from "@scalius/core/modules/checkout";
import { listActiveCheckoutRegistrations } from "@scalius/core/modules/plugins";
import { checkoutAttributesSchema } from "@scalius/shared/plugins";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";

import { ok } from "../utils/api-response";
import { getOptionalExecutionContext } from "../utils/execution-context";
import { createCheckoutAppFunctions, requestBuyerLanguage } from "../plugins/checkout-functions";
import { getCustomerSessionHashKey } from "../utils/encryption-key";
import { getCustomerSessionTokenFromRequest } from "./storefront-orders/shared";
import { buyerCartLineSchema, validateBuyerCart } from "./storefront-orders/buyer-cart";
import { cartInputBudget } from "../schemas/order-lines";
import { successEnvelope, errorResponses } from "../schemas/responses";
import {
  quotedDiscountLineSchema,
  discountCodesSchema,
  discountOfferSchema,
  presentStorefrontDiscountQuote,
  rejectedDiscountCodeSchema,
} from "../schemas/storefront-discounts";

const app = new OpenAPIHono<{ Bindings: Env }>();

const validateDiscountSchema = z.object({
  codes: discountCodesSchema,
  items: z.array(buyerCartLineSchema).max(MAX_ORDER_LINES).superRefine(cartInputBudget).optional().openapi({
    description: "The cart's lines as the cart check takes them (buyer inputs and purchase options included). Prices are the store's, as checkout charges them, never the client's.",
  }),
  attributes: checkoutAttributesSchema.optional(),
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
  const { codes, items = [], attributes: submittedAttributes, shippingCost, customerPhone, presence } = c.req.valid("json");
  // One read wave: the apps' checkout functions (none, no app work) and the
  // signed-in buyer, who previews as checkout will price them (their segment
  // discounts and per-customer limits); a missing or stale session is a guest.
  const sessionToken = getCustomerSessionTokenFromRequest(c);
  const [shopCurrency, registrations, sessionCustomer] = await Promise.all([
    readStoreCurrency(db),
    listActiveCheckoutRegistrations(db),
    sessionToken
      ? getCustomerBySession(db, sessionToken, getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>))
      : null,
  ]);
  const signedInCustomerId = sessionCustomer?.customerId ?? null;
  const apps = createCheckoutAppFunctions({
    env: c.env,
    // The buyer's language: every app word and function run speaks it.
    language: requestBuyerLanguage(presence),
    ctx: getOptionalExecutionContext(c) as ExecutionContext | undefined,
    db,
    registrations,
    buyerRequest: c.req.raw,
  });
  const attributes = validateCheckoutAttributes(apps, submittedAttributes);
  // The cart priced by the same call as the cart check and the quote: the
  // catalogue, the apps' line prices, add-ons and bundles, the buyer's inputs
  // and purchase options, the page's market, a kit sold as its items.
  const cart = await validateBuyerCart(db, apps, {
    items,
    currency: shopCurrency,
    market: { ...(presence && isMarketSubfolder(presence) ? { presence } : {}), customerId: signedInCustomerId },
    appContext: { attributes, channel: "online_store", customerId: signedInCustomerId, destination: null, discountCodes: codes },
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
  const appDiscounts = previewStorefrontAppDiscounts(db, {
    marketContext: cart.marketContext,
    apps,
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
  const appResolution = await appDiscounts;
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
    lineDiscounts: items.map((_item, index) => ({
      index,
      discountMinor: (interplay.allocation?.lines ?? [])
        .filter((line) => sourceOf.get(line.lineId) === index)
        .reduce((total, line) => total + line.amountMinor, 0),
    })),
  });
});

export { app as discountRoutes };
