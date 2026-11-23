import { buyerUiBlockSchema, checkoutAttributesSchema, PLUGIN_EXTENSION_RUN, type FunctionCart } from "@scalius/shared/plugins";
import { MAX_ORDER_LINES } from "@scalius/shared/order-limits";
import { storefrontUiSlotsOn } from "@scalius/shared/plugins/storefront-protocol";
import { addOnFoldLabel } from "@scalius/shared/add-on-folding";
// Authoritative cart validation preflight.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { InventoryPool } from "@scalius/database/schema";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { readStoreOriginCountry } from "@scalius/core/modules/tax";
import { getActivePaymentMethods } from "@scalius/core/modules/payments";
import {
  buyerUiCartLines,
  checkoutLineInputs,
  checkStorefrontCartRules,
  validateCheckoutAttributes,
  presentTransformedCartLines,
  type StorefrontCartFulfilmentSummary,
  presentStorefrontCartValidation,
  presentStorefrontDeliveryPreflight,
  paymentCountryIsStore,
  paymentCountryOf,
  resolveCartPaymentMethods,
  storefrontLinePropertiesHashes,
  summarizeStorefrontCartFulfilment,
  validateStorefrontDeliveryPreflight,
  giftCardTenderRates,
} from "@scalius/core/modules/checkout";
import { listActiveCheckoutRegistrations } from "@scalius/core/modules/plugins";
import { getCustomerBySession } from "@scalius/core/modules/customers";
import { ok } from "../../utils/api-response";
import { getOptionalExecutionContext } from "../../utils/execution-context";
import { enforceCheckoutPreparationLimit } from "../../utils/checkout-rate-limit";
import { getCustomerSessionHashKey } from "../../utils/encryption-key";
import { createCheckoutAppFunctions, requestBuyerLanguage } from "../../plugins/checkout-functions";
import { checkoutPaymentMethods } from "../../plugins/providers/payment";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope, errorResponses, serviceUnavailableResponse } from "../../schemas/responses";
import {
  addOnTotalsSchema,
  allowedPaymentMethodsSchema,
  appLineInputViewSchema,
  deliveryMethodKindSchema,
  fulfillmentKindSchema,
  fulfillmentTypeSchema,
  cartInputBudget,
  linePurchaseOptionsSchema,
  orderLinePropertySchema,
} from "../../schemas/order-lines";
import { buyerCartLineSchema, validateBuyerCart } from "./buyer-cart";
import { cartDiscountSchema, priceCartDiscount } from "./cart-discount";
import { discountCodeListSchema } from "../../schemas/storefront-discounts";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import {
  checkoutPresenceSchema,
  getCustomerSessionTokenFromRequest,
  giftCardHandlesSchema,
  giftCardIssueSchema,
  lazySessionCustomerId,
  persistedStorefrontVariantIdSchema,
  storefrontShippingMethodSnapshotSchema,
} from "./shared";
import {
  GIFT_CARD_UNUSABLE_CODE,
  GIFT_CARD_UNUSABLE_MESSAGE,
  resolveGiftCardTenderCards,
} from "@scalius/core/modules/gift-cards";
import { readMasterSecret } from "@scalius/shared/runtime-secrets";
import { workerCacheHint } from "@scalius/shared/worker-cache-hint";
import { requestCourierProviders } from "../../plugins/providers/courier";
import type { Database } from "@scalius/database/client";
import type { StorefrontGiftCardIssue } from "@scalius/core/modules/orders";
import { shopPresentment, type StoreCurrencyRate } from "@scalius/shared/presentment";

const app = new OpenAPIHono<{ Bindings: Env }>();

/**
 * The UI slots this check answers: the cart page's (checkout's first step)
 * and the cart drawer's, which both read their cart from it, and the slot
 * under each of their lines (`cart.line.after`, one run for the whole cart). An app runs only
 * for a slot it declares, so a slot no app fills costs nothing.
 */
const CART_VALIDATION_UI_SLOTS = [...storefrontUiSlotsOn("checkout"), ...storefrontUiSlotsOn("cart_drawer"), ...storefrontUiSlotsOn("cart")];

// ─── POST / ──────────────────────────────────────────────────────────────────

const cartIssueSchema = z.object({
  index: z.number(),
  cartKey: z.string().nullable().optional(),
  productId: z.string(),
  variantId: z.string().nullable(),
  code: z.enum([
    "product_unavailable",
    "variant_required",
    "variant_unavailable",
    "variant_mismatch",
    "quantity_unavailable",
    "price_changed",
    "properties_required",
    "properties_invalid",
    "confirmation_required",
    "decision_required",
    "fulfilment_unavailable",
    "purchase_option_unavailable",
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
  /** On a bundle line (a kit, an app's bundle): the item SKU the issue is about. */
  componentVariantId: z.string().nullable().optional(),
});

/** An app rule the cart breaks (`cart.validate`). Any one blocks checkout. */
export const cartRuleErrorSchema = z.object({
  code: z.string(),
  message: z.string().openapi({ description: "Written by the app for the buyer; show it as text." }),
  index: z.number().int().nullable().openapi({ description: "The cart line it is about (request index); null for the whole cart." }),
  cartKey: z.string().nullable(),
});

const cartValidationItemSchema = buyerCartLineSchema.extend({
  /**
   * The unit price the buyer saw: base plus the surcharges of its buyer inputs.
   * Absent, the check answers today's price and never says it changed: a line
   * put back from a stored source (an order, a recovery link) has no price the
   * buyer is looking at.
   */
  price: z.number().min(0, "Price must be greater than or equal to 0").optional().openapi({
    description: "The unit price the buyer saw. Absent: the line is quoted at today's price and never answers price_changed.",
  }),
});

const cartValidationRoute = createRoute({
  method: "post",
  path: "/cart-validation",
  tags: ["Orders"],
  summary: "Validate a storefront cart before checkout",
  request: {
    headers: z.object({ "x-storefront-language": z.string().min(1).max(35).optional(), "x-storefront-locale": z.string().min(1).max(35).optional() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            attributes: checkoutAttributesSchema.optional(),
            items: z.array(cartValidationItemSchema).min(1).max(MAX_ORDER_LINES).superRefine(cartInputBudget),
            inventoryPool: z
              .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
              .default(InventoryPool.REGULAR),
            /** The shipping country (absent: Bangladesh); a delivery rate must be one of its shipping zone's. */
            shippingCountryCode: z.string().trim().length(2).optional().nullable(),
            city: z.string().min(1).max(180).optional().nullable(),
            zone: z.string().min(1).max(180).optional().nullable(),
            area: z.string().max(180).optional().nullable(),
            /** Another country's admin area and postal code: its shipping zone matches on them. */
            shippingAdminArea: z.string().trim().max(120).optional().nullable(),
            shippingPostalCode: z.string().trim().max(20).optional().nullable(),
            /** A delivery or pickup rate. A pickup rate needs no city or zone. */
            shippingMethodId: z.string().min(1).max(180).optional().nullable(),
            shippingRateToken: z.string().min(1).max(2048).optional().nullable(),
            cod: z.boolean().optional(),
            presence: checkoutPresenceSchema,
            giftCards: giftCardHandlesSchema,
            discountCodes: discountCodeListSchema.optional().openapi({
              description: "The codes the buyer applied. Sent (even empty), the answer carries `discount`: the cart's discounts as checkout prices them. Each new code is a guess against the client's code budget.",
            }),
            customerPhone: phoneNumberSchema.optional().nullable().openapi({ description: "The buyer's phone, for codes limited per customer." }),
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
            buyerUi: z.array(buyerUiBlockSchema),
            lineInputs: z.array(z.object({ appId: z.string(), inputs: z.array(appLineInputViewSchema) })).openapi({
              description: "The active apps' line inputs, in the buyer's language: what each line's `lineInputs` names, for the cart to draw and edit on the line (answered or not), with each input's confirmation and bulk actions.",
            }),
            /** False with any issue or any app rule error. */
            valid: z.boolean(),
            issues: z.array(cartIssueSchema),
            ruleErrors: z.array(cartRuleErrorSchema).openapi({
              description: "Rules installed apps set for this cart (\"at most 10 per order\"), checked only when `issues` is empty. Checkout is blocked while any remain; the checkout quote and the order check them again.",
            }),
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
              /**
               * Apps' add-ons to each unit (`cart.line_prices` adjustments, in
               * `unitPrice`), shown as line components ("Add-on: …"). Never
               * buyer inputs: the cart does not send them back.
               */
              adjustments: z.array(orderLinePropertySchema),
              purchaseOptions: linePurchaseOptionsSchema.optional(),
              lineInputs: z.array(z.string()).openapi({
                description: "The app line inputs (`<app id>.<key>`) that apply to this line, answered or not, by the same rule the buy form and checkout use (the product's and SKU's app flags); an expanded bundle's are its bundle SKU's.",
              }),
              /** Canonical inputs hash for the cart line key (`line:v3:…:p:<hash>`), the purchase option included; "none" without either. */
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
            addOns: addOnTotalsSchema,
            /** The cart's currency: its market's (MARKETS-DESIGN step 6). Every amount here is in it. */
            currencyCode: z.string().optional(),
            decimalPlaces: z.number().int().optional(),
            hasFreeDeliveryProduct: z.boolean(),
            /** Some line is physical: the buyer must choose delivery or pickup. */
            requiresDeliveryMethod: z.boolean(),
            /** The chosen method's kind; null until one is chosen or when nothing is physical. */
            deliveryMethodKind: deliveryMethodKindSchema.nullable(),
            /** Some line ships to an address (a delivery method was chosen for physical lines). */
            requiresShipping: z.boolean(),
            allowedPaymentMethods: allowedPaymentMethodsSchema,
            /** Applied gift cards that can no longer pay (the tax quote prices the ones that can). */
            giftCardIssues: z.array(giftCardIssueSchema),
            /** Answered when the request sent `discountCodes`. */
            discount: cartDiscountSchema.optional(),
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
    429: errorResponses[429],
    503: serviceUnavailableResponse,
    500: errorResponses[500],
  },
});

/**
 * The buyer's applied gift cards that no longer name a usable card (spent,
 * disabled, expired, expired handle) or repeat one: the uniform message, no
 * detail. No handles, no read.
 */
async function giftCardHandleIssues(
  db: Database,
  handles: readonly string[],
  masterSecret: string | null,
  currencyCode: string,
  rates: StoreCurrencyRate[] | null,
): Promise<StorefrontGiftCardIssue[]> {
  if (handles.length === 0) return [];
  const resolution = await resolveGiftCardTenderCards(db, { handles, masterSecret, currencyCode, ...(rates ? { rates } : {}) });
  const usable = new Set(resolution.cards.map((card) => card.handle));
  const unusable = new Set(resolution.unusableHandles);
  return handles.flatMap((handle): StorefrontGiftCardIssue[] => {
    if (unusable.has(handle)) {
      return [{ handle, code: GIFT_CARD_UNUSABLE_CODE, message: GIFT_CARD_UNUSABLE_MESSAGE }];
    }
    return usable.has(handle)
      ? []
      : [{ handle, code: "gift_card_duplicate", message: "This gift card is already applied." }];
  });
}

app.openapi(cartValidationRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  await enforceCheckoutPreparationLimit(c.env, c.req.raw);
  // The apps' checkout functions ride the first read wave: none, no app work.
  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const [currency, builtInPaymentMethods, registrations] = await Promise.all([
    readStoreCurrency(db),
    getActivePaymentMethods(db, encryptionKey),
    listActiveCheckoutRegistrations(db),
  ]);
  // App payment methods join only when an app provides payment (then one more read).
  const { providers: paymentProviders, paymentMethods } = await checkoutPaymentMethods(c, registrations, builtInPaymentMethods, encryptionKey);
  const apps = createCheckoutAppFunctions({
    env: c.env,
    // The buyer's language: every app word and function run speaks it.
    language: requestBuyerLanguage(data.presence, c.req.header("x-storefront-language")),
    ctx: getOptionalExecutionContext(c) as ExecutionContext | undefined,
    db,
    registrations,
    buyerRequest: c.req.raw,
  });
  const attributes = validateCheckoutAttributes(apps, data.attributes);
  // Only inputs some line can take: a cart of lines no app input applies to answers none. A line
  // refused for one of its app answers (an agreement that changed) still takes that input.
  const cartLineInputs = () => {
    const cart = buyerView?.cart ?? result;
    const shown = new Set([...cart.items.flatMap((item) => item.lineInputs ?? []), ...cart.issues.flatMap((issue) => (issue.propertyKey ? [issue.propertyKey] : []))]);
    return checkoutLineInputs(apps)
      .map((app) => ({
        appId: app.appId,
        inputs: app.inputs.filter((input) => shown.has(`${app.appId}.${input.key}`))
          .map(({ options, accept, surfaces, ...input }) => ({ ...input, ...(options ? { options: [...options] } : {}), ...(accept ? { accept: [...accept] } : {}), ...(surfaces ? { surfaces: [...surfaces] } : {}) })),
      }))
      .filter((app) => app.inputs.length > 0);
  };
  let appCart: FunctionCart | null = null;
  // Each line's facts for the apps' blocks; offers are priced only for the apps that draw under the lines.
  const cartLines = async () => {
    if (!apps.points.has(PLUGIN_EXTENSION_RUN)) return [];
    const lineApps = new Set(storefrontUiSlotsOn("cart").flatMap((slot) => apps.buyerUiApps?.(slot) ?? []));
    return buyerUiCartLines({ apps, result, buyer: buyerView?.cart ?? result, appCart, lineInputs: checkoutLineInputs(apps), offerApps: lineApps });
  };
  const buyerUi = async () => apps.buyerUi?.({ language: c.req.header("x-storefront-language"), locale: c.req.header("x-storefront-locale"), targets: CART_VALIDATION_UI_SLOTS, currency: money.currencyCode, cart: appCart, attributes, lines: await cartLines() }) ?? [];
  /** App rules, once the platform finds nothing to repair (the signed-in buyer's segments included). */
  const ruleErrorsFor = async (
    valid: boolean,
    delivery: Parameters<typeof checkStorefrontCartRules>[1]["delivery"],
  ) => {
    if (!valid || (!apps.points.has("cart.validate") && !apps.points.has(PLUGIN_EXTENSION_RUN))) return [];
    const token = getCustomerSessionTokenFromRequest(c);
    const session = token
      ? await getCustomerBySession(db, token, getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>)).catch(() => null)
      : null;
    return checkStorefrontCartRules(db, {
      cartValidation: result,
      attributes,
      onCart: (cart) => { appCart = cart; },
      delivery,
      apps,
      // Apps see the cart in its currency (its market's).
      currency: { code: money.currencyCode, decimalPlaces: money.decimalPlaces },
      customerId: session?.customerId ?? null,
      channel: "online_store",
    });
  };
  const sessionCustomerId = lazySessionCustomerId(c, (token) =>
    getCustomerBySession(db, token, getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>)));
  const appContext = {
    attributes,
    channel: "online_store" as const,
    customerId: sessionCustomerId,
    destination: data.shippingCountryCode ? { country: data.shippingCountryCode, city: null, zone: null } : null,
    // Apps price the lines knowing the applied codes, as the quote's do.
    ...(data.discountCodes ? { discountCodes: data.discountCodes } : {}),
  };
  // The apps' lines and line prices: the cart shows what checkout will charge.
  const result = await validateBuyerCart(db, apps, {
    items: data.items,
    inventoryPool: data.inventoryPool,
    currency,
    // The buyer's country, else the page's presence, prices the cart (MARKETS-DESIGN D5).
    market: {
      shippingMethodId: data.shippingMethodId,
      presence: data.presence,
      shippingCountryCode: data.shippingCountryCode,
      customerId: sessionCustomerId,
    },
    appContext,
  });
  // Apps that rewrote the lines (`cart.transform`): the buyer sees their own
  // lines (a bundle priced as its components), checkout the rewritten ones.
  const transform = result.transform;
  const buyerView = transform ? presentTransformedCartLines(result, transform, data.items) : null;
  const cartValid = buyerView ? buyerView.cart.valid : result.valid;
  // An app's add-on rows fold into one under its name past the rows a summary shows (the neutral label in the buyer's language else).
  const folding = {
    appName: (appId: string | null) => registrations.find((entry) => entry.installation.pluginId === appId)?.installation.manifest.name,
    foldLabel: addOnFoldLabel(apps.language),
  };
  const presentCart = (fulfilment: StorefrontCartFulfilmentSummary, hashes: readonly string[]) => buyerView
    ? presentStorefrontCartValidation(
      buyerView.cart,
      decimalPlaces,
      { ...fulfilment, lineTypes: buyerView.positions.map((position) => fulfilment.lineTypes[position] ?? null) },
      buyerView.positions.map((position) => hashes[position] ?? ""),
      folding,
    )
    : presentStorefrontCartValidation(result, decimalPlaces, fulfilment, hashes, folding);
  const onBuyerLines = <T extends { index: number | null }>(errors: T[]): T[] => transform
    ? errors.map((error) => ({ ...error, index: error.index === null ? null : transform.items[error.index]?.sourceIndex ?? error.index }))
    : errors;
  // The cart's currency: its market's (MARKETS-DESIGN step 6).
  const money = result.money ?? shopPresentment({ code: currency.code, decimalPlaces: currency.decimalPlaces, priceIncrementMinor: currency.priceIncrementMinor });
  const decimalPlaces = money.decimalPlaces;
  const giftCardIssues = await giftCardHandleIssues(
    db,
    (data.giftCards ?? []).map((card) => card.handle),
    readMasterSecret(c.env),
    money.currencyCode,
    giftCardTenderRates(money),
  );
  const propertiesHashes = await storefrontLinePropertiesHashes(result);
  // The methods the cart may use where it is handed over (paymentCountryOf):
  // a pickup or a cart that ships nothing is handed over in the store's own
  // country, read only then and only when an enabled method serves some
  // countries alone (cash on delivery: Bangladesh).
  const allowedPaymentMethods = async (
    fulfilment: StorefrontCartFulfilmentSummary,
    deliveryCountryCode: string | null,
  ) => {
    const storeCountry = paymentCountryIsStore(fulfilment)
      && paymentMethods.enabledMethods.some((method) => paymentProviders.countries(method) !== "any")
      ? await readStoreOriginCountry(db)
      : null;
    return resolveCartPaymentMethods(
      paymentMethods.enabledMethods,
      fulfilment,
      paymentCountryOf(fulfilment, deliveryCountryCode, storeCountry),
      paymentProviders,
      money.currencyCode,
    );
  };
  const cartOnly = summarizeStorefrontCartFulfilment(result, null);
  // The applied codes' effect, when asked: this check's own cart, delivery and buyer price it.
  const discountFor = async (delivery: Parameters<typeof priceCartDiscount>[1]["delivery"]) => data.discountCodes
    ? priceCartDiscount(db, {
      cart: result,
      money,
      shopCurrency: { code: currency.code, decimalPlaces: currency.decimalPlaces },
      apps,
      codes: data.discountCodes,
      customerId: await sessionCustomerId,
      customerPhone: data.customerPhone,
      delivery,
      shipsNothing: !cartOnly.requiresDeliveryMethod,
      destination: appContext.destination,
      attributes,
      buyerLineCount: data.items.length,
    })
    : undefined;
  // Delivery is priced once a method is chosen: a pickup rate needs no
  // address, a delivery rate needs city and zone.
  const wantsDelivery = Boolean(data.shippingMethodId) || Boolean(data.city && data.zone);
  if (!cartValid || !cartOnly.requiresDeliveryMethod || !wantsDelivery) {
    const [ruleErrors, discount] = await Promise.all([ruleErrorsFor(cartValid, null).then(onBuyerLines), discountFor(null)]);
    return ok(c, {
      buyerUi: await buyerUi(),
      lineInputs: cartLineInputs(),
      ...presentCart(cartOnly, propertiesHashes),
      valid: cartValid && ruleErrors.length === 0,
      ruleErrors,
      allowedPaymentMethods: await allowedPaymentMethods(cartOnly, null),
      giftCardIssues,
      ...(discount ? { discount } : {}),
    });
  }

  const delivery = await validateStorefrontDeliveryPreflight(
    db,
    {
      shippingCountryCode: data.shippingCountryCode,
      city: data.city,
      zone: data.zone,
      area: data.area,
      shippingAdminArea: data.shippingAdminArea,
      shippingPostalCode: data.shippingPostalCode,
      shippingMethodId: data.shippingMethodId,
      shippingRateToken: data.shippingRateToken,
      cod: data.cod,
    },
    result,
    {
      couriers: requestCourierProviders(c),
      masterSecret: readMasterSecret(c.env) ?? undefined,
      cache: workerCacheHint(c.env, "courier-rates", 600) ?? undefined,
      credentialEncryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
    },
  );
  const presented = presentStorefrontDeliveryPreflight(delivery, decimalPlaces);
  const [ruleErrors, discount] = await Promise.all([ruleErrorsFor(cartValid, delivery).then(onBuyerLines), discountFor(delivery)]);
  return ok(c, {
    buyerUi: await buyerUi(),
    lineInputs: cartLineInputs(),
    ...presentCart(delivery.fulfilment, propertiesHashes),
    valid: cartValid && ruleErrors.length === 0,
    ruleErrors,
    allowedPaymentMethods: await allowedPaymentMethods(delivery.fulfilment, delivery.address?.countryCode ?? null),
    giftCardIssues,
    ...(discount ? { discount } : {}),
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
