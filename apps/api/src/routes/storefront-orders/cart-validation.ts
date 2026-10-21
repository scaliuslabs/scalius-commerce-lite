import { buyerUiBlockSchema, checkoutAttributesSchema, PLUGIN_EXTENSION_RUN, type FunctionCart } from "@scalius/shared/plugins";
import { MAX_LINE_QUANTITY } from "@scalius/shared/order-limits";
// Authoritative cart validation preflight.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { InventoryPool } from "@scalius/database/schema";
import { readStoreCurrency } from "@scalius/core/modules/markets";
import { getActivePaymentMethods } from "@scalius/core/modules/payments";
import {
  checkoutPurchaseOptions,
  checkStorefrontCartRules,
  validateCheckoutAttributes,
  createAppLinePricer,
  createCartTransformer,
  presentTransformedCartLines,
  type StorefrontCartFulfilmentSummary,
  presentStorefrontCartValidation,
  presentStorefrontDeliveryPreflight,
  resolveCartPaymentMethods,
  storefrontLinePropertiesHashes,
  summarizeStorefrontCartFulfilment,
  validateStorefrontDeliveryPreflight,
  validateStorefrontCartItems,
  giftCardTenderRates,
} from "@scalius/core/modules/checkout";
import { listActiveCheckoutRegistrations } from "@scalius/core/modules/plugins";
import { getCustomerBySession } from "@scalius/core/modules/customers";
import { ok } from "../../utils/api-response";
import { getOptionalExecutionContext } from "../../utils/execution-context";
import { getCustomerSessionHashKey } from "../../utils/encryption-key";
import { createCheckoutAppFunctions } from "../../plugins/checkout-functions";
import { checkoutPaymentMethods } from "../../plugins/providers/payment";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope, errorResponses } from "../../schemas/responses";
import {
  allowedPaymentMethodsSchema,
  deliveryMethodKindSchema,
  fulfillmentKindSchema,
  fulfillmentTypeSchema,
  linePropertiesInputSchema,
  linePurchaseOptionInputSchema,
  linePurchaseOptionSchema,
  orderLinePropertySchema,
} from "../../schemas/order-lines";
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
});

/** An app rule the cart breaks (`cart.validate`). Any one blocks checkout. */
export const cartRuleErrorSchema = z.object({
  code: z.string(),
  message: z.string().openapi({ description: "Written by the app for the buyer; show it as text." }),
  index: z.number().int().nullable().openapi({ description: "The cart line it is about (request index); null for the whole cart." }),
  cartKey: z.string().nullable(),
});

const cartValidationItemSchema = z.object({
  cartKey: z.string().min(1).max(256).optional().nullable(),
  productId: z.string().min(1, "Product is required"),
  variantId: persistedStorefrontVariantIdSchema,
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(MAX_LINE_QUANTITY, `Quantity must be at most ${MAX_LINE_QUANTITY}`),
  /** The unit price the buyer saw: base plus the surcharges of its buyer inputs. */
  price: z.number().min(0, "Price must be greater than or equal to 0"),
  productName: z.string().optional().nullable(),
  variantLabel: z.string().optional().nullable(),
  properties: linePropertiesInputSchema,
  purchaseOption: linePurchaseOptionInputSchema,
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
            items: z.array(cartValidationItemSchema).min(1).max(99),
            inventoryPool: z
              .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
              .default(InventoryPool.REGULAR),
            /** The shipping country (absent: Bangladesh); a delivery rate must be one of its shipping zone's. */
            shippingCountryCode: z.string().trim().length(2).optional().nullable(),
            city: z.string().min(1).optional().nullable(),
            zone: z.string().min(1).optional().nullable(),
            area: z.string().optional().nullable(),
            /** Another country's admin area and postal code: its shipping zone matches on them. */
            shippingAdminArea: z.string().trim().max(120).optional().nullable(),
            shippingPostalCode: z.string().trim().max(20).optional().nullable(),
            /** A delivery or pickup rate. A pickup rate needs no city or zone. */
            shippingMethodId: z.string().optional().nullable(),
            shippingRateToken: z.string().min(1).max(2048).optional().nullable(),
            cod: z.boolean().optional(),
            presence: checkoutPresenceSchema,
            giftCards: giftCardHandlesSchema,
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
              purchaseOption: linePurchaseOptionSchema.optional(),
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
    ctx: getOptionalExecutionContext(c) as ExecutionContext | undefined,
    db,
    registrations,
  });
  const attributes = validateCheckoutAttributes(apps, data.attributes);
  let appCart: FunctionCart | null = null;
  const buyerUi = () => apps.buyerUi?.({ language: c.req.header("x-storefront-language"), locale: c.req.header("x-storefront-locale"), targets: ["checkout.contact.after", "checkout.delivery.after", "cart.page.summary", "checkout.payment.after", "checkout.actions.before"], currency: money.currencyCode, cart: appCart, attributes }) ?? [];
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
  };
  const result = await validateStorefrontCartItems(db, data.items, {
    inventoryPool: data.inventoryPool,
    currencyCode: currency.code,
    priceIncrementMinor: currency.priceIncrementMinor,
    // The buyer's country, else the page's presence, prices the cart (MARKETS-DESIGN D5).
    market: {
      presence: data.presence,
      shippingCountryCode: data.shippingCountryCode,
      customerId: sessionCustomerId,
    },
    // The apps' lines and line prices: the cart shows what checkout will charge.
    linePricer: createAppLinePricer(db, apps, appContext),
    transformer: createCartTransformer(db, apps, appContext),
    // A line's purchase option must be one an active app offers.
    purchaseOptions: checkoutPurchaseOptions(apps),
  });
  // Apps that rewrote the lines (`cart.transform`): the buyer sees their own
  // lines (a bundle priced as its components), checkout the rewritten ones.
  const transform = result.transform;
  const buyerView = transform ? presentTransformedCartLines(result, transform, data.items) : null;
  const cartValid = buyerView ? buyerView.cart.valid : result.valid;
  const presentCart = (fulfilment: StorefrontCartFulfilmentSummary, hashes: readonly string[]) => buyerView
    ? presentStorefrontCartValidation(
      buyerView.cart,
      decimalPlaces,
      { ...fulfilment, lineTypes: buyerView.positions.map((position) => fulfilment.lineTypes[position] ?? null) },
      buyerView.positions.map((position) => hashes[position] ?? ""),
    )
    : presentStorefrontCartValidation(result, decimalPlaces, fulfilment, hashes);
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
  const cartOnly = summarizeStorefrontCartFulfilment(result, null);
  const cartOnlyPayment = resolveCartPaymentMethods(paymentMethods.enabledMethods, cartOnly, null, paymentProviders, money.currencyCode);
  // Delivery is priced once a method is chosen: a pickup rate needs no
  // address, a delivery rate needs city and zone.
  const wantsDelivery = Boolean(data.shippingMethodId) || Boolean(data.city && data.zone);
  if (!cartValid || !cartOnly.requiresDeliveryMethod || !wantsDelivery) {
    const ruleErrors = onBuyerLines(await ruleErrorsFor(cartValid, null));
    return ok(c, {
      buyerUi: await buyerUi(),
      ...presentCart(cartOnly, propertiesHashes),
      valid: cartValid && ruleErrors.length === 0,
      ruleErrors,
      allowedPaymentMethods: cartOnlyPayment,
      giftCardIssues,
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
  const ruleErrors = onBuyerLines(await ruleErrorsFor(cartValid, delivery));
  return ok(c, {
    buyerUi: await buyerUi(),
    ...presentCart(delivery.fulfilment, propertiesHashes),
    valid: cartValid && ruleErrors.length === 0,
    ruleErrors,
    allowedPaymentMethods: resolveCartPaymentMethods(
      paymentMethods.enabledMethods,
      delivery.fulfilment,
      delivery.address?.countryCode ?? null,
      paymentProviders,
      money.currencyCode,
    ),
    giftCardIssues,
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
