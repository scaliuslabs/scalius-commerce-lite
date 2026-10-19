import { buyerUiBlockSchema, checkoutAttributesSchema } from "@scalius/shared/plugins";
// Authoritative checkout tax quote.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requestAppProviders } from "../../plugins/providers/app-providers";
import { InventoryPool } from "@scalius/database/schema";
import {
    quotedDiscountLineSchema,
    discountCodesSchema,
    discountOfferSchema,
    presentStorefrontDiscountQuote,
    rejectedDiscountCodeSchema,
} from "../../schemas/storefront-discounts";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { getCustomerBySession } from "@scalius/core/modules/customers";
import { billingTaxLocation } from "@scalius/core/modules/orders";
import { billingAddressBodyShape } from "../../schemas/billing-address";
import { checkoutFxSchema } from "../../schemas/markets";
import { fromMinor } from "@scalius/shared/money";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { buildStorefrontCheckoutQuoteFingerprint } from "@scalius/core/modules/checkout/browser";
import {
    assertNoCheckoutRuleErrors,
    validateCheckoutAttributes,
    createAppLinePricer,
    createCartTransformer,
    presentTransformedCartLines,
    ruleErrorsOnBuyerLines,
    assertStorefrontLineFulfilment,
    presentCheckoutRateOptions,
    priceStorefrontCheckout,
    quoteStorefrontGiftCardTender,
    resolveAppPaymentMethods,
    resolveCartPaymentMethods,
    storefrontLinePropertiesHashes,
    validateStorefrontDeliveryPreflight,
    validateStorefrontCartItems,
    presentQuoteFx,
} from "@scalius/core/modules/checkout";
import { listActiveCheckoutRegistrations } from "@scalius/core/modules/plugins";
import { GIFT_CARD_PAYMENT_METHOD } from "@scalius/core/modules/gift-cards";
import { readMasterSecret } from "@scalius/shared/runtime-secrets";
import { workerCacheHint } from "@scalius/shared/worker-cache-hint";
import { requestCourierProviders } from "../../plugins/providers/courier";
import { getActivePaymentMethods } from "@scalius/core/modules/payments";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
    allowedPaymentMethodsSchema,
    deliveryMethodKindSchema,
    fulfillmentTypeSchema,
    linePropertiesInputSchema,
    orderLinePropertySchema,
} from "../../schemas/order-lines";
import { buildStorefrontTaxAllocationLineId } from "@scalius/core/modules/tax";
import { ValidationError } from "../../utils/api-error";
import { getOptionalExecutionContext } from "../../utils/execution-context";
import { createCheckoutAppFunctions } from "../../plugins/checkout-functions";
import { checkoutPaymentMethods } from "../../plugins/providers/payment";
import { getCustomerSessionHashKey } from "../../utils/encryption-key";
import { ok } from "../../utils/api-response";
import { successEnvelope, errorResponses } from "../../schemas/responses";
import {
    giftCardHandlesSchema,
    giftCardIssueSchema,
    giftCardQuoteTenderSchema,
    persistedStorefrontVariantIdSchema,
    presentGiftCardTenderQuote,
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
  buyerUi: z.array(buyerUiBlockSchema),
  valid: z.literal(true),
  quoteFingerprint: z.string(),
  displayLabel: z.string(),
  pricesIncludeTax: z.boolean(),
  shippingTaxed: z.boolean(),
  currencyCode: z.string(),
  decimalPlaces: z.number().int(),
  fx: checkoutFxSchema,
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
  /** The total less the applied gift cards: what cash on delivery or a gateway collects (the total without cards). */
  amountDueMinor: z.number().int(),
  amountDue: z.number(),
  giftCardTenders: z.array(giftCardQuoteTenderSchema).openapi({
    description: "The gift cards that pay part of this order, in the order they were added. A gift card never pays for gift-card lines; tender never changes taxes or discounts.",
  }),
  giftCardIssues: z.array(giftCardIssueSchema).openapi({
    description: "Gift cards that apply nothing, with the reason. An unusable card always reads \"This gift card can't be used.\"",
  }),
  /** Null when the cart has nothing physical (no delivery method, no fee). */
  shippingMethod: storefrontShippingMethodSnapshotSchema.nullable(),
  shippingRateToken: z.string().max(2048).nullable(),
  deliveryMethodKind: deliveryMethodKindSchema.nullable(),
  /** Some line ships: the order needs the delivery address. */
  requiresShipping: z.boolean(),
  /** Pickup location and hours, for a pickup method. */
  pickup: z.object({ address: z.string().nullable(), hours: z.string().nullable() }).nullable(),
  allowedPaymentMethods: allowedPaymentMethodsSchema.openapi({
    description: "Payment methods for the amount due. Exactly [\"gift_card\"] when gift cards cover the whole order; cash on delivery only when something is shipped, collected or performed, and only for a delivery to a country it serves (Bangladesh).",
  }),
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
    description: "Quantity-bundle savings in `discountMinor`. An order is priced by its promotions or by its bundles, never both: a typed code wins, otherwise whichever saves more (promotions on a tie).",
  }),
  bundleDiscountAmount: z.number().nonnegative(),
  bundles: z.array(z.object({
    productId: z.string(),
    quantity: z.number().int().openapi({ description: "The tier the product's cart quantity reached (\"3 for ...\")." }),
    discountType: z.enum(["percentage", "fixed_price"]),
    label: z.string().nullable(),
  })).openapi({
    description: "The bundle tiers that priced this quote (empty when promotions did).",
  }),
  shippingRates: z.array(z.object({
    id: z.string(),
    name: z.string(),
    kind: deliveryMethodKindSchema,
    amount: z.number(),
    amountMinor: z.number().int().nonnegative(),
  })).nullable().openapi({
    description: "Null when no installed app changed the delivery options (show them as listed). Otherwise exactly the options to show, in this order, with these names and what the buyer pays for each (free-delivery rules applied); options not listed are hidden.",
  }),
  paymentMethods: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })).nullable().openapi({
    description: "Null when no installed app changed the payment methods. Otherwise the methods to show, in this order, with these names; `allowedPaymentMethods` is narrowed the same way. Apps never add or enable a method.",
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
    /** Apps' add-ons to each unit (in `unitPrice`), shown as line components; never buyer inputs. */
    adjustments: z.array(orderLinePropertySchema),
    propertiesHash: z.string(),
  })),
});

const taxQuoteRoute = createRoute({
  method: "post",
  path: "/tax-quote",
  tags: ["Orders"],
  summary: "Calculate an authoritative storefront tax quote",
  request: {
    headers: z.object({ "x-storefront-language": z.string().min(1).max(35).optional(), "x-storefront-locale": z.string().min(1).max(35).optional() }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            attributes: checkoutAttributesSchema.optional(),
            items: z.array(taxQuoteItemSchema).min(1).max(99),
            inventoryPool: z.enum([
              InventoryPool.REGULAR,
              InventoryPool.PREORDER,
              InventoryPool.BACKORDER,
            ]).default(InventoryPool.REGULAR),
            /**
             * The shipping country (absent: Bangladesh). A delivery rate must
             * be one of the destination's shipping zone (MARKETS-DESIGN step 3b).
             */
            shippingCountryCode: z.string().trim().length(2).optional().nullable(),
            /** Bangladesh's City/Thana/Area: required for a delivery method there; omitted for pickup or when nothing is physical. */
            city: z.string().min(1).max(180).optional().nullable(),
            zone: z.string().min(1).max(180).optional().nullable(),
            area: z.string().max(180).optional().nullable(),
            /** Another country's admin area and postal code: its shipping zone matches on them. */
            shippingAdminArea: z.string().trim().max(120).optional().nullable(),
            shippingPostalCode: z.string().trim().max(20).optional().nullable(),
            /** Required when a line is physical; omitted when nothing is. */
            shippingMethodId: z.string().min(1).max(180).optional().nullable(),
            shippingRateToken: z.string().min(1).max(2048).optional().nullable(),
            cod: z.boolean().optional(),
            /**
             * Where a cart with nothing physical is taxed: its billing country,
             * admin area and postal code (a cart that ships is taxed at its
             * shipping address, a pickup cart where it is collected).
             */
            billingCountryCode: billingAddressBodyShape.billingCountryCode,
            billingAdminArea: billingAddressBodyShape.billingAdminArea,
            billingPostalCode: billingAddressBodyShape.billingPostalCode,
            discountCodes: discountCodesSchema,
            customerPhone: phoneNumberSchema.optional().nullable(),
            giftCards: giftCardHandlesSchema,
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

app.openapi(taxQuoteRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  // A signed-in buyer is quoted as the order will be: their per-customer
  // limits and the promotions limited to their customer segments. A missing
  // or stale session quotes as a guest (checkout itself reports it).
  const customerSessionToken = getCustomerSessionTokenFromRequest(c);
  // The apps' checkout functions ride the first read wave (none, no app work),
  // beside the signed-in buyer: their per-customer limits, their segments for
  // segment-limited promotions (automatic ones need no code) and apps' facts.
  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const [currency, builtInPaymentMethods, registrations, sessionCustomer] = await Promise.all([
    readStoreCurrency(db),
    getActivePaymentMethods(db, encryptionKey),
    listActiveCheckoutRegistrations(db),
    customerSessionToken
      ? getCustomerBySession(db, customerSessionToken, getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>))
      : null,
  ]);
  const apps = createCheckoutAppFunctions({
    env: c.env,
    ctx: getOptionalExecutionContext(c) as ExecutionContext | undefined,
    db,
    registrations,
  });
  const attributes = validateCheckoutAttributes(apps, data.attributes);
  // App payment methods join only when an app provides payment (then one more read).
  const { providers: paymentProviders, paymentMethods } = await checkoutPaymentMethods(c, registrations, builtInPaymentMethods, encryptionKey);
  const appContext = {
    attributes,
    channel: "online_store" as const,
    customerId: sessionCustomer?.customerId ?? null,
    destination: data.shippingCountryCode ? { country: data.shippingCountryCode, city: null, zone: null } : null,
    discountCodes: data.discountCodes,
  };
  const cartValidation = await validateStorefrontCartItems(db, data.items, {
    inventoryPool: data.inventoryPool,
    currencyCode: currency.code,
    priceIncrementMinor: currency.priceIncrementMinor,
    // The order's market prices the lines, as the order will (MARKETS-DESIGN D5).
    market: {
      placing: true,
      shippingCountryCode: data.shippingCountryCode,
      billingCountryCode: data.billingCountryCode,
      customerId: sessionCustomer?.customerId ?? null,
    },
    // The apps' lines and line prices (bundles, B2B contracts), as the order sees them.
    linePricer: createAppLinePricer(db, apps, appContext),
    transformer: createCartTransformer(db, apps, appContext),
  });
  // Apps that rewrote the lines (`cart.transform`): issues and the listed
  // lines are the buyer's; tax and discounts are the rewritten lines'.
  const buyerView = cartValidation.transform ? presentTransformedCartLines(cartValidation, cartValidation.transform, data.items) : null;
  if (!cartValidation.valid || (buyerView && !buyerView.cart.valid)) {
    throw new ValidationError("Some items in your cart need attention.", {
      itemIssues: buyerView ? buyerView.cart.issues : cartValidation.issues,
    });
  }
  const delivery = await validateStorefrontDeliveryPreflight(db, {
    shippingCountryCode: data.shippingCountryCode,
    city: data.city,
    zone: data.zone,
    area: data.area,
    shippingAdminArea: data.shippingAdminArea,
    shippingPostalCode: data.shippingPostalCode,
    shippingMethodId: data.shippingMethodId,
    shippingRateToken: data.shippingRateToken,
    cod: data.cod,
  }, cartValidation, {
    couriers: requestCourierProviders(c),
    masterSecret: readMasterSecret(c.env) ?? undefined,
    cache: workerCacheHint(c.env, "courier-rates", 600) ?? undefined,
    credentialEncryptionKey: encryptionKey,
  });
  const lineTypes = assertStorefrontLineFulfilment(cartValidation, delivery);
  const linePropertiesHashes = await storefrontLinePropertiesHashes(cartValidation);
  // Promotions or bundles, then the apps, then tax: the rule the order commits (pricing.ts).
  const pricing = await priceStorefrontCheckout(db, {
    attributes,
    cartValidation,
    delivery,
    discountCodes: data.discountCodes,
    customerId: sessionCustomer?.customerId ?? null,
    segmentCustomerId: sessionCustomer?.customerId ?? null,
    customerPhone: data.customerPhone,
    currency: {
      code: currency.code,
      decimalPlaces: currency.decimalPlaces,
      priceIncrementMinor: currency.priceIncrementMinor,
    },
    apps,
    appProviders: requestAppProviders(c),
    channel: "online_store",
    // A cart with nothing physical is taxed at its billing address, as typed so far.
    billing: billingTaxLocation(data),
    location: {
      countryCode: data.shippingCountryCode,
      city: data.city,
      zone: data.zone,
      area: data.area,
      adminArea: data.shippingAdminArea,
      postalCode: data.shippingPostalCode,
    },
  });
  assertNoCheckoutRuleErrors(ruleErrorsOnBuyerLines(pricing.ruleErrors, cartValidation));
  const quote = pricing.taxQuote;
  const discount = pricing.discount;
  const bundleDiscountMinor = pricing.bundleDiscountMinor;
  // Gift cards pay what is left after discounts and tax, never gift-card lines (§4.3).
  const giftCardTender = await quoteStorefrontGiftCardTender(db, {
    handles: (data.giftCards ?? []).map((card) => card.handle),
    masterSecret: readMasterSecret(c.env),
    taxQuote: quote,
    money: cartValidation.money,
    giftCardLineIds: new Set(cartValidation.items
      .filter((item) => item.isGiftCard)
      .map((item) => buildStorefrontTaxAllocationLineId(item.index, item.variantId))),
  });
  const coveredByGiftCards = giftCardTender.appliedTotalMinor > 0 && giftCardTender.amountDueMinor === 0;
  // Apps narrow and present the methods checkout allows; gift-card cover is tender, not a method.
  const payment = coveredByGiftCards
    ? { methods: [], changed: false }
    : await resolveAppPaymentMethods(apps, pricing.appCart, resolveCartPaymentMethods(
      paymentMethods.enabledMethods,
      delivery.fulfilment,
      // A method that doesn't serve the delivery country is not offered (cash on delivery: Bangladesh).
      delivery.address?.countryCode ?? null,
      paymentProviders,
      // A gateway that can't charge the order's currency is not offered.
      quote.currencyCode,
    ), paymentProviders);
  const toAmount = (minor: number) => fromMinor(minor, quote.decimalPlaces);
  return ok(c, {
    buyerUi: await apps.buyerUi?.({ language: c.req.header("x-storefront-language"), locale: c.req.header("x-storefront-locale"), targets: ["purchase.checkout.contact.render-after", "purchase.checkout.shipping-option-list.render-after", "purchase.checkout.cart-line-list.render-after", "purchase.checkout.payment-method-list.render-after", "purchase.checkout.actions.render-before"], currency: quote.currencyCode, cart: pricing.appCart, attributes, customer: sessionCustomer?.customerId ? { id: sessionCustomer.customerId } : null }) ?? [],
    valid: true as const,
    quoteFingerprint: await buildStorefrontCheckoutQuoteFingerprint(
      quote,
      pricing.shippingMethod,
      linePropertiesHashes,
      attributes,
    ),
    displayLabel: quote.displayLabel,
    pricesIncludeTax: quote.pricesIncludeTax,
    shippingTaxed: quote.shippingTaxed,
    currencyCode: quote.currencyCode,
    decimalPlaces: quote.decimalPlaces,
    // The rate this quote converts shop amounts at, and how long an order keeps it (MARKETS-DESIGN step 6).
    fx: presentQuoteFx(cartValidation.money),
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
    ...presentGiftCardTenderQuote(giftCardTender, quote.decimalPlaces),
    shippingMethod: pricing.shippingMethod,
    shippingRateToken: delivery.rateToken ?? null,
    deliveryMethodKind: delivery.kind,
    requiresShipping: delivery.fulfilment.requiresShipping,
    pickup: delivery.pickup,
    allowedPaymentMethods: coveredByGiftCards
      ? [GIFT_CARD_PAYMENT_METHOD]
      : payment.methods.map((method) => method.methodId),
    paymentMethods: payment.changed
      ? payment.methods.map((method) => ({ id: method.methodId, name: method.name }))
      : null,
    shippingRates: pricing.shippingRates ? presentCheckoutRateOptions(pricing.shippingRates, quote.decimalPlaces) : null,
    ...presentStorefrontDiscountQuote(discount, quote.decimalPlaces, pricing.appDiscounts),
    bundleDiscountMinor,
    bundleDiscountAmount: toAmount(bundleDiscountMinor),
    bundles: (bundleDiscountMinor > 0 ? cartValidation.bundles ?? [] : []).map((bundle) => ({
      productId: bundle.productId,
      quantity: bundle.quantity,
      discountType: bundle.discountType,
      label: bundle.label,
    })),
    items: (buyerView ? buyerView.cart.items : cartValidation.items).map((item, listed) => {
      const position = buyerView ? buyerView.positions[listed]! : listed;
      return {
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
      adjustments: (item.adjustments ?? []).map((adjustment) => ({
        ...adjustment,
        price: toAmount(adjustment.priceMinor),
      })),
      propertiesHash: linePropertiesHashes[position]!,
      };
    }),
  });
});

export { app as taxQuoteRoutes };
