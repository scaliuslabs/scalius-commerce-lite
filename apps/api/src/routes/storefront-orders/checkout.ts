import { checkoutAttributesSchema, readCheckoutAttributes } from "@scalius/shared/plugins";
// Checkout: the idempotent storefront order commit.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { PaymentMethod, PaymentStatus, InventoryPool } from "@scalius/database/schema";
import { discountCodesSchema } from "../../schemas/storefront-discounts";
import { isOnlinePaymentMethod, isPaymentMethodId, type PaymentProviders } from "@scalius/core/modules/payments";
import { assertPhoneCountryAllowed, validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { BD_MOBILE_REQUIRED_MESSAGE } from "@scalius/shared/phone-input";
import { refineDeliveryLine } from "@scalius/core/modules/orders";
import { readMasterSecret } from "@scalius/shared/runtime-secrets";
import { workerCacheHint } from "@scalius/shared/worker-cache-hint";
import { requestCourierProviders } from "../../plugins/providers/courier";
import { GIFT_CARD_PAYMENT_METHOD } from "@scalius/core/modules/gift-cards";
import { recordCheckoutMarketingConsent } from "@scalius/core/modules/customer-marketing";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getCustomerBySession } from "@scalius/core/modules/customers";
import { fromMinor } from "@scalius/shared/money";
import type { CheckoutPaymentMethodId } from "@scalius/core/modules/checkout";
import {
    assertStorefrontCheckoutQuoteFingerprint,
    buildStorefrontCheckoutQuoteFingerprint,
} from "@scalius/core/modules/checkout/browser";
import {
    assertStorefrontAppPaymentMethod,
    assertStorefrontGiftCardTenderReviewed,
    buildCheckoutAttemptIdentity,
    commitStorefrontOrderPayload,
    createAppLinePricer,
    createAtomicCheckoutAttempt,
    createCartTransformer,
    createStorefrontOrder,
    createTrustedStorefrontCheckoutPolicySnapshot,
    resolveExistingCheckoutAttempt,
    runStorefrontOrderPostCommitSideEffects,
    assertStorefrontCheckoutPolicy,
    loadStorefrontCheckoutReads,
    resolveCartPaymentMethods,
    type StorefrontCheckoutAuthoritySnapshot,
    type StorefrontCheckoutSettingsSnapshot,
} from "@scalius/core/modules/checkout";
import { createCheckoutAppFunctions } from "../../plugins/checkout-functions";
import { paymentProvidersFromRegistrations } from "../../plugins/providers/payment";
import { requestProviderRuntime } from "../../plugins/providers/runtime";
import { requestAppProviders } from "../../plugins/providers/app-providers";
import { commitTaxDocument } from "@scalius/core/modules/tax";
import { getOptionalExecutionContext } from "../../utils/execution-context";
import { autoFulfilAfterResponse } from "../../background/auto-fulfil";
import { AppError, ValidationError, RateLimitError } from "../../utils/api-error";
import {
  CUSTOMER_SESSION_ENDED_HEADER,
  CUSTOMER_SIGN_IN_REQUIRED_MESSAGE,
} from "@scalius/shared/customer-auth-policy";
import { getCredentialEncryptionKey, getCustomerSessionHashKey } from "../../utils/encryption-key";
import { getClientIp } from "@scalius/shared/rate-limit";
import { isWithinRateLimit } from "../../utils/rate-limit";
import { created } from "../../utils/api-response";
import { errorResponses, serviceUnavailableResponse, conflictResponse } from "../../schemas/responses";
import { linePropertiesInputSchema } from "../../schemas/order-lines";
import { billingAddressBodyShape } from "../../schemas/billing-address";
import {
    getCustomerSessionTokenFromRequest,
    giftCardHandlesSchema,
    lazySessionCustomerId,
    persistedStorefrontVariantIdSchema,
} from "./shared";
import { notificationSender } from "../../background/notification-sender";

const app = new OpenAPIHono<{ Bindings: Env }>();

type CheckoutCustomerIdentity = {
  customerId: string;
  source: "authenticated";
} | null;
type CheckoutSettingsSnapshot = StorefrontCheckoutSettingsSnapshot;
type CheckoutOrderPolicyResult = {
  customerIdentity: CheckoutCustomerIdentity;
  checkoutSettings: CheckoutSettingsSnapshot;
  /** The request carried a session that no longer signs anyone in (the storefront clears its cookies). */
  sessionEnded: boolean;
};

type CheckoutDiagnosticPhase =
  | "attempt"
  | "authority"
  | "policy"
  | "prepare"
  | "rate_limit"
  | "commit"
  | "post_commit";

function createCheckoutDiagnostics(env: Env): {
  mark: (phase: CheckoutDiagnosticPhase) => void;
  apply: (context: { header: (name: string, value: string) => void }) => void;
} | null {
  if (
    (env as unknown as Record<string, unknown>).CHECKOUT_LOADTEST_DIAGNOSTICS
      !== "1"
  ) {
    return null;
  }
  let last = performance.now();
  const durations: Array<{ phase: CheckoutDiagnosticPhase; durationMs: number }> = [];
  return {
    mark(phase) {
      const now = performance.now();
      durations.push({ phase, durationMs: Math.max(0, now - last) });
      last = now;
    },
    apply(context) {
      context.header(
        "Server-Timing",
        durations.map(({ phase, durationMs }) =>
          `${phase};dur=${durationMs.toFixed(1)}`
        ).join(", "),
      );
    },
  };
}

async function enforceCheckoutRateLimits(
  env: Env,
  request: Request,
  contact: { customerPhone: string | null; customerEmail: string | null },
): Promise<void> {
  // The buyer's phone, or their email for an order placed without one.
  const [ipAllowed, phoneAllowed] = await Promise.all([
    isWithinRateLimit(env, "RL_STANDARD", "checkout-ip", getClientIp(request)),
    contact.customerPhone
      ? isWithinRateLimit(env, "RL_STRICT", "checkout-phone", contact.customerPhone)
      : isWithinRateLimit(env, "RL_STRICT", "checkout-email", contact.customerEmail?.trim().toLowerCase() ?? ""),
  ]);
  if (!ipAllowed || !phoneAllowed) {
    throw new RateLimitError("Too many order requests. Please try again later.");
  }
}

async function assertCheckoutOrderPolicy(
  c: {
    env: Env;
    get: (key: "db") => Database;
    req: { header: (name: string) => string | undefined };
  },
  customerPhone: string | null,
  paymentMethod: CheckoutPaymentMethodId,
  authority: Pick<
    StorefrontCheckoutAuthoritySnapshot,
    "checkoutSettings" | "allowedCountries" | "activePaymentMethods"
  >,
  providers: PaymentProviders,
): Promise<CheckoutOrderPolicyResult> {
  const db = c.get("db");
  const checkoutSettings = authority.checkoutSettings;
  const checkoutSettingsSnapshot = paymentMethod === GIFT_CARD_PAYMENT_METHOD
    ? assertGiftCardCheckoutPolicy(customerPhone, authority)
    : assertStorefrontCheckoutPolicy(
      customerPhone,
      paymentMethod,
      authority,
      providers,
    );

  const sessionToken = getCustomerSessionTokenFromRequest(c);
  const session = sessionToken
    ? await getCustomerBySession(
      db,
      sessionToken,
      getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>),
    )
    : null;
  if (session?.customerId) {
    return {
      customerIdentity: { customerId: session.customerId, source: "authenticated" },
      checkoutSettings: checkoutSettingsSnapshot,
      sessionEnded: false,
    };
  }
  // A store that sells to guests takes the order as a guest's, also when the
  // browser still holds a session that ended (Shopify): an old cookie is no
  // reason to stop a buyer who never asked to sign in.
  if (checkoutSettings?.guestCheckoutEnabled ?? true) {
    return { customerIdentity: null, checkoutSettings: checkoutSettingsSnapshot, sessionEnded: Boolean(sessionToken) };
  }
  throw new AppError(401, "CUSTOMER_SIGN_IN_REQUIRED", CUSTOMER_SIGN_IN_REQUIRED_MESSAGE);
}

/**
 * An order the buyer's gift cards cover needs no enabled payment method (the
 * gift card is the tender, not a checkout setting); the contact rules still
 * hold. Prepare refuses `gift_card` unless the cards cover the whole order.
 */
function assertGiftCardCheckoutPolicy(
  customerPhone: string | null,
  authority: Pick<StorefrontCheckoutAuthoritySnapshot, "checkoutSettings" | "allowedCountries">,
): CheckoutSettingsSnapshot {
  try {
    if (customerPhone) {
      assertPhoneCountryAllowed(customerPhone, {
        countries: authority.allowedCountries.allowedCountries,
        mode: authority.allowedCountries.allowedCountriesMode,
      });
    }
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : "Phone number is not accepted for checkout.",
    );
  }
  return {
    checkoutMode: authority.checkoutSettings.checkoutMode,
    partialPaymentEnabled: authority.checkoutSettings.partialPaymentEnabled,
    partialPaymentAmount: authority.checkoutSettings.partialPaymentAmount,
  };
}

const createOrderSchema = z.object({
  checkoutRequestId: z
    .string()
    .trim()
    .min(16, "Checkout request id is required")
    .max(128, "Checkout request id is too long")
    .regex(/^[A-Za-z0-9:_-]+$/, "Checkout request id contains unsupported characters"),
  expectedQuoteFingerprint: z
    .string()
    .regex(/^taxq_[A-Za-z0-9_-]{22}$/, "A current reviewed checkout quote is required")
    .openapi({
      description: "Exact authoritative quote fingerprint reviewed by the buyer before submitting the order.",
    }),
  customerName: z
    .string()
    .min(3, "Customer name must be at least 3 characters")
    .max(100, "Customer name must be less than 100 characters"),
  /**
   * Read in the shipping country (`shippingCountryCode`): a national number
   * there becomes E.164. Null or empty only when the shared contact rule
   * lets the order go without one (Customer accounts opt-in, only digital or
   * service lines, paid in full online, outside Bangladesh); email is then
   * required. Otherwise the order is refused (`details.reason: phone_required`).
   */
  customerPhone: z.string().trim().max(32, "Phone number too long").nullable().optional(),
  customerEmail: z.email().nullable(),
  /** Kept only when Customer accounts asks for a separate WhatsApp number. */
  customerWhatsapp: z.string().trim().max(32).nullable().optional(),
  /**
   * The shipping country (MARKETS-DESIGN D7): one an active market sells to.
   * Absent means Bangladesh, whose City/Thana/Area form sends `city`, `zone`
   * and `area` instead of a locality. Another country sends what its rules
   * require (GET /api/v1/address-rules/{countryCode}). An order with nothing
   * to ship sends none: its country is its billing country.
   */
  shippingCountryCode: z.string().trim().length(2).nullable().optional(),
  /**
   * The first street line, required only when something ships: a physical
   * line with a delivery rate. Pickup, service-only and digital orders omit
   * the address (and it is ignored if sent).
   */
  shippingAddress: z
    .string()
    .max(500, "Address must be less than 500 characters")
    .nullable()
    .optional(),
  shippingAddressLine2: z.string().trim().max(200).nullable().optional(),
  shippingDependentLocality: z.string().trim().max(120).nullable().optional(),
  shippingLocality: z.string().trim().max(120).nullable().optional(),
  shippingAdminArea: z.string().trim().max(120).nullable().optional(),
  shippingPostalCode: z.string().trim().max(20).nullable().optional(),
  city: z.string().min(1, "City is required").nullable().optional(),
  zone: z.string().min(1, "Zone is required").nullable().optional(),
  area: z.string().nullable().optional(),
  ...billingAddressBodyShape,
  attributes: checkoutAttributesSchema.optional(),
  notes: z
    .string()
    .max(500, "Notes must be less than 500 characters")
    .nullable(),
  items: z.array(
    z.object({
      cartKey: z.string().min(1).max(256).optional().nullable(),
      productId: z.string().min(1, "Product is required"),
      variantId: persistedStorefrontVariantIdSchema,
      quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(99, "Quantity must be at most 99"),
      /** The unit price the buyer saw: base plus the surcharges of its buyer inputs. */
      price: z.number().min(0, "Price must be greater than or equal to 0"),
      productName: z.string().optional().nullable(),
      variantLabel: z.string().optional().nullable(),
      properties: linePropertiesInputSchema,
    }),
  ).min(1, "At least one item is required"),
  discountCodes: discountCodesSchema,
  shippingCharge: z
    .number()
    .min(0, "Shipping charge must be greater than or equal to 0"),
  /** A delivery or pickup rate; required when a line is physical. */
  shippingMethodId: z.string().optional().nullable(),
  shippingRateToken: z.string().min(1).max(2048).optional().nullable(),
  /**
   * `cod`, a gateway id (`stripe`, or an app provider's
   * `<plugin id>:<provider id>`), or `gift_card` only when the applied gift
   * cards cover the whole order. Checkout accepts only methods enabled now.
   */
  paymentMethod: z
    .string()
    .max(160)
    .refine((method) => isPaymentMethodId(method) || method === GIFT_CARD_PAYMENT_METHOD, "Unsupported payment method")
    .default(PaymentMethod.COD),
  inventoryPool: z
    .enum([InventoryPool.REGULAR, InventoryPool.PREORDER, InventoryPool.BACKORDER])
    .default(InventoryPool.REGULAR),
  giftCards: giftCardHandlesSchema,
  /**
   * The buyer ticked the marketing consent checkbox (Customers & marketing),
   * shown in this storefront language. Absent or null: no consent recorded.
   * Never required; recorded after the order commits.
   */
  marketingConsent: z.object({ language: z.string().trim().max(16).nullable(), channels: z.array(z.enum(["email", "sms", "whatsapp"])).min(1).max(3) }).strict().nullable().optional(),
  expectedAmountDueMinor: z.number().int().nonnegative().optional().openapi({
    description: "The amount due the buyer reviewed in the tax quote (`amountDueMinor`). Required with gift cards: a card that changed since then is a 409 GIFT_CARD_CHANGED.",
  }),
}).superRefine((order, context) => {
  if ((order.giftCards?.length ?? 0) > 0 && order.expectedAmountDueMinor === undefined) {
    context.addIssue({
      code: "custom",
      path: ["expectedAmountDueMinor"],
      message: "The reviewed amount due is required with gift cards.",
    });
  }
  refineDeliveryLine(order, context);
}).transform((order, context) => {
  // The phone is customer identity and the code-sign-in channel, read as
  // E.164 in the address country (MARKETS-DESIGN D7). Whether this order may
  // go without one is the shared contact rule, applied once its lines and
  // payment are known (core checkout `assertOrderContact`).
  const rawPhone = order.customerPhone?.trim() || null;
  if (!rawPhone) return { ...order, customerPhone: null };
  if (rawPhone.length < 7) {
    context.addIssue({ code: "custom", path: ["customerPhone"], message: "Phone number too short" });
    return z.NEVER;
  }
  try {
    // An order that ships nothing reads it in its billing country.
    return { ...order, customerPhone: validateAndFormatPhone(rawPhone, undefined, { defaultCountry: order.shippingCountryCode ?? order.billingCountryCode }) };
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      path: ["customerPhone"],
      message: error instanceof Error && error.message === BD_MOBILE_REQUIRED_MESSAGE ? error.message : "Enter a valid phone number",
    });
    return z.NEVER;
  }
});

type CreateOrderInput = z.infer<typeof createOrderSchema>;

function assertGatewayCurrencyReadiness(data: CreateOrderInput, currencyCode: string, providers: PaymentProviders): void {
  if (!isOnlinePaymentMethod(data.paymentMethod)) return;
  const issue = providers.currencyIssue(data.paymentMethod, currencyCode);
  if (issue) throw new ValidationError(issue);
}

/**
 * The gateway's first charge must be within its limits. With gift cards the
 * gateway charges the whole amount due (no deposit plan is made): the plan
 * is refused while cards are applied (Wave B §4.3).
 */
function assertGatewayPrecommitReadiness(
  providers: PaymentProviders,
  paymentMethod: string,
  checkoutSettings: CheckoutSettingsSnapshot,
  amountDueMinor: number,
  currencyCode: string,
  giftCardsApplied: boolean,
  /** The order is in a market's own currency (MARKETS-DESIGN step 6). */
  foreignCurrency = false,
): void {
  const issue = providers.precommitIssue({
    paymentMethod,
    currencyCode,
    totalAmountMinor: amountDueMinor,
    // A deposit is a shop-currency amount: an order in another currency pays in full.
    partialPaymentEnabled: checkoutSettings.partialPaymentEnabled && !giftCardsApplied && !foreignCurrency,
    partialPaymentAmount: checkoutSettings.partialPaymentAmount,
  });
  if (issue) throw new ValidationError(issue);
}

const checkoutCreatedPayloadSchema = z.object({
  checkoutToken: z.string(),
  receiptToken: z.string(),
  statusToken: z.string(),
  orderId: z.string(),
  paymentMethod: z.string(),
  totalAmount: z.number(),
  totalAmountMinor: z.number().int(),
  taxAmount: z.number(),
  taxAmountMinor: z.number().int(),
  taxLabel: z.string(),
  pricesIncludeTax: z.boolean(),
  currencyCode: z.string(),
  decimalPlaces: z.number().int(),
  /** Some line ships to the buyer's address (false for pickup, service-only and digital orders). */
  requiresShipping: z.boolean().optional(),
  /** What is left to pay after gift cards (the total without them). */
  amountDue: z.number().optional(),
  amountDueMinor: z.number().int().optional(),
  /** Paid at commit: the gift cards applied. */
  paidAmountMinor: z.number().int().optional(),
  giftCardTenders: z.array(z.object({
    last4: z.string(),
    applied: z.number(),
    appliedMinor: z.number().int(),
  })).optional(),
  message: z.string(),
});

type CheckoutCreatedPayload = z.infer<typeof checkoutCreatedPayloadSchema>;

const createOrderRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Orders"],
  summary: "Create a new storefront order",
  request: {
    body: {
      content: {
        "application/json": {
          schema: createOrderSchema
        }
      }
    }
  },
  responses: {
    201: {
      description: "Order created",
      content: { "application/json": { schema: z.object({
        success: z.literal(true),
        data: checkoutCreatedPayloadSchema,
      }) } },
    },
    202: {
      description: "Order submit is already processing",
      content: { "application/json": { schema: z.object({
        success: z.literal(true),
        data: z.object({
          statusToken: z.string(),
          orderId: z.string(),
          status: z.literal("processing"),
          message: z.string(),
        }),
      }) } },
    },
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    409: conflictResponse,
    429: errorResponses[429],
    500: errorResponses[500],
    503: serviceUnavailableResponse,
  }
});

app.openapi(createOrderRoute, async (c) => {
  const db = c.get("db");
  const data = c.req.valid("json");
  const requestUrl = c.req.url;
  const diagnostics = createCheckoutDiagnostics(c.env);

  try {
    const attemptIdentity = await buildCheckoutAttemptIdentity(data);
    const sessionCustomerId = lazySessionCustomerId(c, (token) =>
      getCustomerBySession(db, token, getCustomerSessionHashKey(c.env as unknown as Record<string, unknown>)));
    // What the apps' line prices and cart transforms see besides the cart.
    const appContext = {
      attributes: data.attributes,
      channel: "online_store" as const,
      customerId: sessionCustomerId,
      destination: data.shippingCountryCode ? { country: data.shippingCountryCode, city: null, zone: null } : null,
      discountCodes: data.discountCodes,
    };
    // One read round trip: idempotency row, checkout authority, and the rows
    // the commit needs. A committed request replays before any policy check.
    const checkoutReads = await loadStorefrontCheckoutReads<CheckoutCreatedPayload>(
      db,
      attemptIdentity,
      {
        items: data.items.map((item) => ({
          cartKey: item.cartKey,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          price: item.price,
          productName: item.productName,
          variantLabel: item.variantLabel,
          properties: item.properties,
        })),
        inventoryPool: data.inventoryPool,
        shippingCountryCode: data.shippingCountryCode,
        city: data.city,
        zone: data.zone,
        area: data.area,
        shippingAdminArea: data.shippingAdminArea,
        shippingPostalCode: data.shippingPostalCode,
        shippingMethodId: data.shippingMethodId,
        shippingRateToken: data.shippingRateToken,
        cod: data.paymentMethod === "cod",
        calculatedRates: {
          couriers: requestCourierProviders(c),
          masterSecret: readMasterSecret(c.env) ?? undefined,
          cache: workerCacheHint(c.env, "courier-rates", 600) ?? undefined,
          credentialEncryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
        },
        customerEmail: data.customerEmail,
        customerPhone: data.customerPhone,
        // The order's market prices the lines (MARKETS-DESIGN D5); the
        // session is read only when a segment price list applies.
        billingCountryCode: data.billingCountryCode,
        customerId: sessionCustomerId,
      },
      getCredentialEncryptionKey(c.env as Record<string, unknown>),
      {
        // App payment providers join from the registrations the read batch carries.
        paymentProviders: (registrations) => paymentProvidersFromRegistrations(requestProviderRuntime(c), registrations),
        // The apps' checkout functions, from the registrations the read batch
        // carried: none means no app work. Placement runs them again (it never
        // trusts the quote's app outcome; the fingerprint compares the totals).
        apps: (registrations) => createCheckoutAppFunctions({
          env: c.env,
          ctx: getOptionalExecutionContext(c) as ExecutionContext | undefined,
          db,
          registrations,
        }),
        linePricer: (apps) => createAppLinePricer(db, apps, appContext),
        transformer: (apps) => createCartTransformer(db, apps, appContext),
      },
    );
    const existingAttempt = checkoutReads.existingAttempt;
    const paymentProviders = checkoutReads.paymentProviders;
    diagnostics?.mark("attempt");

    if (existingAttempt?.status === "replay") {
      return created(c, existingAttempt.response);
    }

    if (existingAttempt?.status === "processing") {
      return c.json({
        success: true,
        data: {
          statusToken: existingAttempt.statusToken,
          orderId: existingAttempt.orderId,
          status: "processing" as const,
          message: "Order creation is already processing.",
        },
      }, 202);
    }
    const retryAttempt = existingAttempt?.status === "retry"
      ? existingAttempt.attempt
      : null;

    const checkoutAuthority = checkoutReads.authority();
    const { currency, cartValidation, deliveryPreflight } = checkoutAuthority;
    const apps = checkoutReads.apps;
    diagnostics?.mark("authority");

    const {
      customerIdentity: checkoutCustomerIdentity,
      checkoutSettings,
      sessionEnded,
    } = await assertCheckoutOrderPolicy(
      c,
      data.customerPhone,
      data.paymentMethod as CheckoutPaymentMethodId,
      checkoutAuthority,
      paymentProviders,
    );
    // A gateway must charge the order's currency: its market's (MARKETS-DESIGN step 6).
    // (A cart validated before step 6 carries no money: the authority's shop currency.)
    const orderCurrencyCode = cartValidation.money?.currencyCode ?? currency.currencyCode;
    assertGatewayCurrencyReadiness(data, orderCurrencyCode, paymentProviders);
    diagnostics?.mark("policy");

    // This remains memory-only until the authoritative order batch. The
    // idempotency row, order, inventory mutation, and receipt either all commit
    // or all roll back together.
    const checkoutAttempt = retryAttempt ?? createAtomicCheckoutAttempt(attemptIdentity);

    const result = await createStorefrontOrder(
      db,
      // Apps that rewrote the lines (`cart.transform`): the order holds the rewritten lines.
      checkoutReads.transform
        ? {
          ...data,
          items: checkoutReads.transform.items.map((item) => ({
            cartKey: item.cartKey ?? undefined,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            ...(typeof item.price === "number" ? { price: item.price } : {}),
            ...(item.productName ? { productName: item.productName } : {}),
            ...(item.variantLabel ? { variantLabel: item.variantLabel } : {}),
            ...(item.properties !== undefined ? { properties: item.properties as typeof data.items[number]["properties"] } : {}),
          })),
        }
        : data,
      requestUrl,
      {
        orderId: checkoutAttempt.orderId,
        checkoutToken: checkoutAttempt.checkoutToken,
      },
      cartValidation,
      deliveryPreflight,
      checkoutCustomerIdentity ?? undefined,
      {
        code: currency.currencyCode,
        decimalPlaces: getDecimalPlaces(currency.currencyCode),
        priceIncrementMinor: currency.priceIncrementMinor,
      },
      createTrustedStorefrontCheckoutPolicySnapshot({
        partialPaymentEnabled: checkoutSettings.partialPaymentEnabled,
        partialPaymentAmount: checkoutSettings.partialPaymentAmount,
        authorityRevision: checkoutAuthority.authorityRevision,
        orderCreatedNotificationEnabled:
          checkoutAuthority.sideEffects.orderCreatedNotification,
        metaPurchaseEnabled: checkoutAuthority.sideEffects.metaPurchase,
        contactFields: checkoutAuthority.contactFields,
        shippingCountries: checkoutAuthority.shippingCountries,
        requireFullBillingAddress: checkoutAuthority.checkoutSettings.requireFullBillingAddress,
      }),
      checkoutAuthority.taxAuthority,
      { masterSecret: readMasterSecret(c.env) },
      { apps, channel: "online_store", paymentProviders, appProviders: requestAppProviders(c) },
    );

    assertStorefrontCheckoutQuoteFingerprint(
      data.expectedQuoteFingerprint,
      await buildStorefrontCheckoutQuoteFingerprint(
        result.taxQuote,
        result.shippingMethod,
        result.linePropertiesHashes,
        readCheckoutAttributes(result.commitPayload.orderData.attributes),
      ),
    );
    // An app may have hidden the chosen method for this cart; readiness and
    // the merchant's payment policy were already checked above.
    if (apps.points.has("checkout.payment_methods")) {
      await assertStorefrontAppPaymentMethod(apps, result.appCart, result.paymentMethod, resolveCartPaymentMethods(
        checkoutAuthority.activePaymentMethods.enabledMethods,
        deliveryPreflight.fulfilment,
        deliveryPreflight.address?.countryCode ?? null,
        paymentProviders,
      ), paymentProviders);
    }
    // Then the gift cards: still usable, and the amount due the buyer reviewed.
    assertStorefrontGiftCardTenderReviewed(result.giftCardTender, data.expectedAmountDueMinor);

    assertGatewayPrecommitReadiness(
      paymentProviders,
      result.paymentMethod,
      checkoutSettings,
      result.giftCardTender.amountDueMinor,
      result.taxQuote.currencyCode,
      result.giftCardTender.appliedTotalMinor > 0,
      orderCurrencyCode !== currency.currencyCode,
    );
    diagnostics?.mark("prepare");

    // Only authoritative, policy-valid checkouts consume buyer rate-limit
    // budget. All database writes still remain in the single commit below.
    await enforceCheckoutRateLimits(c.env, c.req.raw, data);
    diagnostics?.mark("rate_limit");

    const executionCtx = getOptionalExecutionContext(c);

    const responsePayload: CheckoutCreatedPayload = {
      checkoutToken: result.checkoutToken,
      receiptToken: result.checkoutToken,
      statusToken: checkoutAttempt.statusToken,
      orderId: result.orderId,
      paymentMethod: result.paymentMethod,
      totalAmount: fromMinor(result.taxQuote.totalMinor, result.taxQuote.decimalPlaces),
      totalAmountMinor: result.taxQuote.totalMinor,
      taxAmount: fromMinor(result.taxQuote.taxMinor, result.taxQuote.decimalPlaces),
      taxAmountMinor: result.taxQuote.taxMinor,
      taxLabel: result.taxQuote.displayLabel,
      pricesIncludeTax: result.taxQuote.pricesIncludeTax,
      currencyCode: result.taxQuote.currencyCode,
      decimalPlaces: result.taxQuote.decimalPlaces,
      requiresShipping: result.requiresShipping,
      amountDue: fromMinor(result.giftCardTender.amountDueMinor, result.taxQuote.decimalPlaces),
      amountDueMinor: result.giftCardTender.amountDueMinor,
      paidAmountMinor: result.giftCardTender.appliedTotalMinor,
      // last4 and amounts only: never a code or a handle.
      giftCardTenders: result.giftCardTender.applied.map((card) => ({
        last4: card.last4,
        applied: fromMinor(card.appliedMinor, result.taxQuote.decimalPlaces),
        appliedMinor: card.appliedMinor,
      })),
      message: "Order created",
    };

    let committed: Awaited<ReturnType<typeof commitStorefrontOrderPayload>>;
    try {
      committed = await commitStorefrontOrderPayload(
        db,
        result.commitPayload,
        { attempt: checkoutAttempt, response: responsePayload },
        checkoutReads.commitReads,
      );
    } catch (commitError) {
      const recoveredAttempt = await resolveExistingCheckoutAttempt<typeof responsePayload>(
        db,
        attemptIdentity,
        undefined,
        sessionCustomerId,
      ).catch((recoveryError: unknown) => {
        console.warn("[Orders] Failed to resolve checkout after an uncertain commit:", recoveryError);
        return null;
      });
      if (recoveredAttempt?.status === "replay") {
        return created(c, recoveredAttempt.response);
      }
      if (recoveredAttempt?.status === "processing") {
        return c.json({
          success: true,
          data: {
            statusToken: recoveredAttempt.statusToken,
            orderId: recoveredAttempt.orderId,
            status: "processing" as const,
            message: "Order creation is already processing.",
          },
        }, 202);
      }
      throw commitError;
    }
    diagnostics?.mark("commit");

    const postCommit = Promise.all([
      runStorefrontOrderPostCommitSideEffects(db, { ...c.env, sendNotifications: notificationSender(c) }, result.commitPayload),
      // An app tax provider's calculation becomes its committed document.
      committed.alreadyCommitted ? null : commitTaxDocument(result.taxQuote, result.orderId, requestAppProviders(c)),
      // An order fully paid at commit (e.g. covered by gift cards) is settled now.
      result.commitPayload.orderData.paymentStatus === PaymentStatus.PAID
        ? autoFulfilAfterResponse(c, db, result.orderId, "checkout-commit")
        : null,
      // The buyer's marketing consent: recorded after the commit, never able to fail the order.
      data.marketingConsent && committed.customerId && !committed.alreadyCommitted
        ? recordCheckoutMarketingConsent(db, {
          customerId: committed.customerId,
          signedInCustomerId: result.commitPayload.existingCustomer?.id ?? null,
          order: {
            phone: result.commitPayload.orderData.customerPhone,
            email: result.commitPayload.orderData.customerEmail,
            whatsapp: result.commitPayload.orderData.customerWhatsapp ?? null,
          },
          language: data.marketingConsent.language,
          channels: data.marketingConsent.channels,
        }, { env: c.env as never, send: notificationSender(c) })
        : null,
    ]);
    if (executionCtx && typeof executionCtx.waitUntil === "function") {
      executionCtx.waitUntil(postCommit);
    } else {
      await postCommit;
    }

    diagnostics?.mark("post_commit");
    diagnostics?.apply(c);
    if (sessionEnded) c.header(CUSTOMER_SESSION_ENDED_HEADER, "1");

    return created(c, responsePayload);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new ValidationError("Invalid input data", error.issues);
    }

    throw error;
  }
});

export { app as checkoutRoutes };
