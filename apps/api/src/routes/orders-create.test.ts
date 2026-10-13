import { resolvePriceIncrementMinor } from "@scalius/shared/currency-policy";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutAttempts, orders } from "@scalius/database/schema";

import { ConflictError, NotFoundError } from "@scalius/core/errors";
import { buildCheckoutStatusTokenFromRequestKey } from "@scalius/core/modules/checkout";
import { ValidationError } from "../utils/api-error";
import { errorResponseFromError } from "../utils/api-response";
import {
} from "../utils/order-receipt-token";

const DEFAULT_STATUS_REQUEST_KEY = `checkout_submit:v1:${"a".repeat(64)}`;
const DEFAULT_STATUS_TOKEN = buildCheckoutStatusTokenFromRequestKey(DEFAULT_STATUS_REQUEST_KEY);
const DEFAULT_QUOTE_FINGERPRINT = "taxq_abcdefghijklmnopqrstuv";
const PREFETCHED_COMMIT_READS = { prefetched: true };

const mocks = vi.hoisted(() => ({
  createStorefrontOrder: vi.fn(),
  buildStorefrontCheckoutQuoteFingerprint: vi.fn(),
  loadStorefrontCheckoutAuthority: vi.fn(),
  buildCheckoutAttemptIdentity: vi.fn(),
  resolveExistingCheckoutAttempt: vi.fn(),
  createAtomicCheckoutAttempt: vi.fn(),
  commitStorefrontOrderPayload: vi.fn(),
  runStorefrontOrderPostCommitSideEffects: vi.fn(),
  validateStorefrontCartItems: vi.fn(),
  validateStorefrontDeliveryPreflight: vi.fn(),
  createReceiptOrderSupportRequest: vi.fn(),
  getOrderSupportRequestStatusLabel: vi.fn((status: string) => status),
  getReceiptOrderSupportRequestState: vi.fn(),
  limiter: { limit: vi.fn(async (_input: { key: string }) => ({ success: true })) },
  getClientIp: vi.fn(() => "127.0.0.1"),
  getCustomerBySession: vi.fn(),
  getActivePaymentMethods: vi.fn(),
  getCurrencySettings: vi.fn(),
  calculateStorefrontTaxQuote: vi.fn(),
  quoteStorefrontDiscount: vi.fn(),
  // No app implements a checkout function unless a test says so.
  listActiveCheckoutRegistrations: vi.fn(async () => [] as unknown[]),

}));

vi.mock("@scalius/core/modules/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/plugins")>()),
  listActiveCheckoutRegistrations: mocks.listActiveCheckoutRegistrations,
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/orders")>();
  return {
    ...actual,
    CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES: ["cancel_pre_shipment", "return", "refund"],
    createReceiptOrderSupportRequest: mocks.createReceiptOrderSupportRequest,
    getOrderSupportRequestStatusLabel: mocks.getOrderSupportRequestStatusLabel,
    getReceiptOrderSupportRequestState: mocks.getReceiptOrderSupportRequestState,
  };
});

vi.mock("@scalius/core/modules/checkout/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/checkout/browser")>()),
  buildStorefrontCheckoutQuoteFingerprint: mocks.buildStorefrontCheckoutQuoteFingerprint,
}));

vi.mock("@scalius/core/modules/checkout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/checkout")>();
  return {
    ...actual,
    buildCheckoutAttemptIdentity: mocks.buildCheckoutAttemptIdentity,
    resolveExistingCheckoutAttempt: mocks.resolveExistingCheckoutAttempt,
    createAtomicCheckoutAttempt: mocks.createAtomicCheckoutAttempt,
    // Prepared orders without gift cards: the whole total is due (Wave B §4.3).
    createStorefrontOrder: async (...args: unknown[]) => {
      const result = await mocks.createStorefrontOrder(...args);
      if (!result || typeof result !== "object") return result;
      // No app adjusted anything: the reviewed rate is the preflight's.
      const withApps = {
        shippingMethod: (args[5] as { shippingMethod?: unknown } | undefined)?.shippingMethod ?? null,
        appDiscounts: [],
        shippingRates: null,
        appCart: null,
        ...result,
      };
      if ("giftCardTender" in result) return withApps;
      const totalMinor = (result as { taxQuote?: { totalMinor?: number } }).taxQuote?.totalMinor ?? 0;
      return {
        ...withApps,
        giftCardTender: {
          handles: [], giftCardLineTotalMinor: 0, applied: [], appliedTotalMinor: 0,
          amountDueMinor: totalMinor, unusableHandles: [], issues: [],
        },
      };
    },
    loadStorefrontCheckoutAuthority: mocks.loadStorefrontCheckoutAuthority,
    // The route reads attempt + authority in one batch; the mocks keep their
    // separate seams so each decision is still observable.
    loadStorefrontCheckoutReads: async (
      db: unknown,
      identity: unknown,
      input: unknown,
      key: unknown,
      options?: { apps?: (registrations: never[]) => unknown },
    ) => {
      const existingAttempt = await mocks.resolveExistingCheckoutAttempt(db, identity);
      let authority: Promise<unknown> | null = null;
      if (existingAttempt?.status !== "replay" && existingAttempt?.status !== "processing") {
        const pending: Promise<unknown> = mocks.loadStorefrontCheckoutAuthority(db, input, key);
        pending.catch(() => undefined);
        authority = pending;
      }
      const snapshot = authority ? await authority.then((value) => ({ value }), (error) => ({ error })) : null;
      return {
        existingAttempt,
        commitReads: PREFETCHED_COMMIT_READS,
        functionRegistrations: [],
        apps: options?.apps?.([]) ?? actual.NO_CHECKOUT_APP_FUNCTIONS,
        // SSLCommerz is the Bangladesh pack's: these stores have it active (orders name it by its old id too).
        paymentProviders: await sslcommerzPackProviders(),
        authority: () => {
          if (!snapshot) throw new Error("replay");
          if ("error" in snapshot) throw snapshot.error;
          return snapshot.value;
        },
      };
    },
    commitStorefrontOrderPayload: mocks.commitStorefrontOrderPayload,
    runStorefrontOrderPostCommitSideEffects: mocks.runStorefrontOrderPostCommitSideEffects,
    // Fixtures describe pre-Wave A physical lines; the wrappers add the line
    // kinds and the delivery plan the real services always return.
    validateStorefrontCartItems: async (...args: unknown[]) =>
      withWaveALineDefaults(await mocks.validateStorefrontCartItems(...args)),
    validateStorefrontDeliveryPreflight: async (db: unknown, input: Record<string, unknown>, cart: { items?: unknown[] }) =>
      withWaveAPreflightDefaults(await mocks.validateStorefrontDeliveryPreflight(db, input, cart), input, cart),
  };
});

/** The request's gateways with the Bangladesh pack's SSLCommerz (its declared name and BDT limits). */
async function sslcommerzPackProviders() {
  return (await import("@scalius/core/testing")).createSslcommerzPackProviders().providers;
}

function withWaveALineDefaults<T>(result: T): T {
  if (!result || typeof result !== "object" || !Array.isArray((result as { items?: unknown }).items)) return result;
  const cart = result as unknown as { items: Array<Record<string, unknown>> };
  return {
    ...result,
    items: cart.items.map((item) => ({
      fulfillmentKind: "physical",
      isGiftCard: false,
      properties: [],
      canonicalProperties: [],
      propertiesPriceMinor: 0,
      baseUnitPriceMinor: item.unitPriceMinor,
      ...item,
    })),
  };
}

function withWaveAPreflightDefaults<T>(
  result: T,
  input: Record<string, unknown>,
  cart: { items?: unknown[] },
): T {
  if (!result || typeof result !== "object") return result;
  return {
    kind: "delivery",
    address: { city: input.city, zone: input.zone, area: input.area ?? null },
    pickup: null,
    fulfilment: {
      lineTypes: (cart.items ?? []).map(() => "ship"),
      requiresDeliveryMethod: true,
      deliveryMethodKind: "delivery",
      requiresShipping: true,
      allowsCashOnDelivery: true,
    },
    ...result,
  };
}

vi.mock("../utils/execution-context", () => ({
  getOptionalExecutionContext: (c: { executionCtx?: unknown }) => {
    try {
      return c.executionCtx;
    } catch {
      return undefined;
    }
  },
}));

vi.mock("@scalius/shared/rate-limit", () => ({
  getClientIp: mocks.getClientIp,
}));

vi.mock("@scalius/core/modules/customers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/customers")>()),
  getCustomerBySession: mocks.getCustomerBySession,
  getSessionCookie: (cookieHeader: string | null) => {
    const match = cookieHeader?.match(/(?:^|;\s*)cs_tok=([^;]+)/);
    return match?.[1] ?? null;
  },
}));

vi.mock("@scalius/core/modules/payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments")>()),
  getActivePaymentMethods: mocks.getActivePaymentMethods,
}));

// The store's pricing currency: the shop currency at the backup market's increment.
vi.mock("@scalius/core/modules/markets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/markets")>();
  return {
    ...actual,
    readStoreCurrency: async (db: unknown) => {
      const currency = await mocks.getCurrencySettings(db);
      return { ...actual.storeCurrencyOf(currency, currency.priceIncrementMinor), symbol: currency.currencySymbol };
    },
  };
});

vi.mock("@scalius/core/modules/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/settings")>()),
  getCurrencySettings: mocks.getCurrencySettings,
}));

vi.mock("@scalius/core/modules/tax", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/tax")>();
  return {
    ...actual,
    calculateStorefrontTaxQuote: mocks.calculateStorefrontTaxQuote,
  };
});

vi.mock("@scalius/core/modules/promotions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/promotions")>()),
  quoteStorefrontDiscount: mocks.quoteStorefrontDiscount,
}));

import { orderRoutes } from "./storefront-orders";

const DEFAULT_TAX_QUOTE = {
  schemaVersion: 1 as const,
  calculationVersion: "tax-v1" as const,
  enabled: false,
  currencyCode: "BDT",
  decimalPlaces: 2,
  displayLabel: "Tax",
  pricesIncludeTax: false,
  shippingTaxed: false,
  settingsVersion: 0,
  subtotalMinor: 10_000,
  shippingMinor: 0,
  discountMinor: 0,
  taxableMinor: 0,
  taxMinor: 0,
  totalMinor: 10_000,
  destination: { city: "city_1", zone: "zone_1", area: null },
  lines: [],
  shipping: {
    taxClassId: null,
    taxClassName: null,
    grossAmountMinor: 0,
    discountMinor: 0,
    taxableAmountMinor: 0,
    taxMinor: 0,
    totalMinor: 0,
    components: [],
  },
};

const DEFAULT_SHIPPING_METHOD_SNAPSHOT = {
  id: "shipping_1",
  name: "Standard delivery",
  description: "Delivered within 2–3 business days",
  baseAmountMinor: 6_000,
  feeWaived: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limiter.limit.mockResolvedValue({ success: true });
  mocks.getClientIp.mockReturnValue("127.0.0.1");
  mocks.getCustomerBySession.mockResolvedValue(null);
  mocks.getActivePaymentMethods.mockResolvedValue({
    enabledMethods: ["cod"],
    defaultMethod: "cod",
  });
  mocks.getCurrencySettings.mockResolvedValue({
    currencyCode: "BDT",
    currencySymbol: "৳",
  });
  mocks.calculateStorefrontTaxQuote.mockResolvedValue(DEFAULT_TAX_QUOTE);
  mocks.quoteStorefrontDiscount.mockResolvedValue({
    applied: null, snapshot: null, taxAllocation: undefined, discounts: [], offers: [], rejectedCodes: [],
  });

  mocks.createStorefrontOrder.mockResolvedValue({
    checkoutToken: "chk_order_1",
    orderId: "order_1",
    paymentMethod: "cod",
    totalAmount: 100,
    taxQuote: DEFAULT_TAX_QUOTE,
    commitPayload: { orderData: { id: "order_1" } },
  });
  mocks.buildStorefrontCheckoutQuoteFingerprint.mockResolvedValue(DEFAULT_QUOTE_FINGERPRINT);
  mocks.buildCheckoutAttemptIdentity.mockResolvedValue({
    requestKey: "checkout_submit:v1:test",
    requestHash: "request_hash_1",
    checkoutRequestId: "checkout_req_123456",
  });
  mocks.resolveExistingCheckoutAttempt.mockResolvedValue(null);
  mocks.createAtomicCheckoutAttempt.mockReturnValue({
    commitMode: "atomic",
    origin: "new",
    id: "coa_1",
    requestKey: "checkout_submit:v1:test",
    requestHash: "request_hash_1",
    orderId: "order_1",
    checkoutToken: "chk_order_1",
    statusToken: DEFAULT_STATUS_TOKEN,
  });
  mocks.commitStorefrontOrderPayload.mockResolvedValue({ availabilityTransitionVariantIds: [] });
  mocks.runStorefrontOrderPostCommitSideEffects.mockResolvedValue(undefined);
  mocks.validateStorefrontCartItems.mockResolvedValue({
    valid: true,
    issues: [],
    items: [],
    subtotalMinor: 0,
    hasFreeDeliveryProduct: false,
  });
  mocks.validateStorefrontDeliveryPreflight.mockResolvedValue({
    shippingMinor: 6_000,
    shippingMethod: DEFAULT_SHIPPING_METHOD_SNAPSHOT,
    cityName: "Dhaka",
    zoneName: "Mirpur",
    areaName: null,
  });
});

const validOrderBody = {
  checkoutRequestId: "checkout_req_123456",
  expectedQuoteFingerprint: DEFAULT_QUOTE_FINGERPRINT,
  customerName: "Queue Customer",
  customerPhone: "+8801712345678",
  customerEmail: null,
  shippingAddress: "123 Queue Street",
  city: "city_1",
  zone: "zone_1",
  area: null,
  notes: null,
  items: [
    {
      productId: "product_1",
      variantId: "variant_1",
      quantity: 1,
      price: 100,
      productName: "Queue Product",
      variantLabel: null,
    },
  ],
  shippingCharge: 0,
  paymentMethod: "cod",
  inventoryPool: "regular",
};

function createTestApp(options: {
  guestCheckoutEnabled?: boolean;
  checkoutMode?: "guest_cod_only" | "gateways_only" | "all";
  partialPaymentEnabled?: boolean;
  partialPaymentAmount?: number;
  allowedCountries?: string[];
  allowedCountriesMode?: "include" | "exclude";
} = {}) {
  const calls: string[] = [];
  const kv = {
    get: vi.fn(async () => null),
    put: vi.fn(async (key: string) => {
      calls.push(`kv:${key}`);
    }),
  };
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => [{
          guestCheckoutEnabled: options.guestCheckoutEnabled ?? true,
          checkoutMode: options.checkoutMode ?? "all",
          partialPaymentEnabled: options.partialPaymentEnabled ?? false,
          partialPaymentAmount: options.partialPaymentAmount ?? 0,
        }]),
        where: vi.fn(() => ({
          get: vi.fn(async () => {
            if (!options.allowedCountries?.length) return null;
            return {
              value: JSON.stringify({
                countries: options.allowedCountries,
                mode: options.allowedCountriesMode ?? "include",
              }),
            };
          }),
        })),
      })),
    })),
  };
  mocks.loadStorefrontCheckoutAuthority.mockImplementation(async (database, input, encryptionKey) => {
    const currency = await mocks.getCurrencySettings(database);
    const cartValidation = await mocks.validateStorefrontCartItems(database, input.items, {
      inventoryPool: input.inventoryPool,
      currencyCode: currency.currencyCode,
    });
    if (!cartValidation.valid) {
      throw new ValidationError("Some items in your cart need attention.", {
        itemIssues: cartValidation.issues,
      });
    }
    const deliveryPreflight = await mocks.validateStorefrontDeliveryPreflight(database, {
      city: input.city,
      zone: input.zone,
      area: input.area,
      shippingMethodId: input.shippingMethodId,
      currencyCode: currency.currencyCode,
    }, cartValidation);
    const activePaymentMethods = await mocks.getActivePaymentMethods(
      database,
      encryptionKey,
    );
    return {
      authorityRevision: 1,
      currency: { ...currency, priceIncrementMinor: resolvePriceIncrementMinor(currency.currencyCode, currency.priceIncrementMinor) },
      marketId: "mkt_backup",
      cartValidation,
      deliveryPreflight,
      checkoutSettings: {
        guestCheckoutEnabled: options.guestCheckoutEnabled ?? true,
        checkoutMode: options.checkoutMode ?? "all",
        partialPaymentEnabled: options.partialPaymentEnabled ?? false,
        partialPaymentAmount: options.partialPaymentAmount ?? 0,
      },
      allowedCountries: {
        allowedCountries: options.allowedCountries ?? [],
        allowedCountriesMode: options.allowedCountriesMode ?? "include",
      },
      activePaymentMethods,
      taxAuthority: { settings: {}, classes: [], rates: [] },
      sideEffects: {
        orderCreatedNotification: true,
        metaPurchase: true,
      },
    };
  });
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.env.RL_STANDARD ??= mocks.limiter;
    c.env.RL_STRICT ??= mocks.limiter;
    await next();
  });
  app.route("/orders", orderRoutes);

  return { app, db, kv, calls };
}

function createStatusTestApp(options: {
  attempt?: {
    status: "committed" | "failed" | "processing";
    orderId: string;
    checkoutToken: string;
    requestKey?: string;
    lastError?: string | null;
  } | null;
  orderExists?: boolean;
}) {
  const statusToken = options.attempt?.requestKey
    ? buildCheckoutStatusTokenFromRequestKey(options.attempt.requestKey)
    : DEFAULT_STATUS_TOKEN;
  const db = {
    select: vi.fn(() => {
      let selectedTable: unknown;
      const query = {
        from: vi.fn((table: unknown) => {
          selectedTable = table;
          return query;
        }),
        leftJoin: vi.fn(() => query),
        where: vi.fn(() => query),
        get: vi.fn(async () => {
          if (selectedTable === checkoutAttempts) {
            return options.attempt
              ? {
                  requestKey: DEFAULT_STATUS_REQUEST_KEY, ...options.attempt,
                  persistedOrderId: options.orderExists ? options.attempt.orderId : null,
                  orderStatus: options.orderExists ? "pending" : null,
                  deletedAt: null,
                  paymentStatus: options.orderExists ? "unpaid" : null,
                  paidAmountMinor: options.orderExists ? 0 : null,
                }
              : null;
          }
          if (selectedTable === orders) {
            return options.orderExists ? { id: options.attempt?.orderId ?? "order_1" } : null;
          }
          return null;
        }),
        limit: vi.fn(async () => options.orderExists ? [{ id: options.attempt?.orderId ?? "order_1" }] : []),
      };
      return query;
    }),
  };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/orders", orderRoutes);

  return { app, db, statusToken };
}

function createWaitUntilContext() {
  return {
    waitUntil: vi.fn((_promise: Promise<unknown>) => undefined),
    passThroughOnException: vi.fn(),
  };
}

describe("cart validation preflight", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["synthetic default", "default"],
  ])("rejects a %s variant at the cart-validation schema boundary", async (_label, variantId) => {
    const { app, kv } = createTestApp();
    const item: Record<string, unknown> = {
      productId: "product_1",
      quantity: 1,
      price: 100,
    };
    if (variantId !== undefined) item.variantId = variantId;

    const response = await app.request(
      "/api/v1/orders/cart-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [item] }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.validateStorefrontCartItems).not.toHaveBeenCalled();
    expect(mocks.validateStorefrontDeliveryPreflight).not.toHaveBeenCalled();
  });

  it.each(["JPY", "KWD"])(
    "loads %s once and passes it to the authoritative cart validator",
    async (currencyCode) => {
      mocks.getCurrencySettings.mockResolvedValue({
        currencyCode,
        currencySymbol: currencyCode === "JPY" ? "¥" : "د.ك",
      });
      const { app, kv } = createTestApp();

      const response = await app.request(
        "/api/v1/orders/cart-validation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{
              productId: "product_1",
              variantId: "variant_1",
              quantity: 1,
              price: currencyCode === "JPY" ? 100 : 1.235,
            }],
          }),
        },
        { CACHE: kv } as never,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(mocks.getCurrencySettings).toHaveBeenCalledOnce();
      expect(mocks.validateStorefrontCartItems).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Array),
        expect.objectContaining({
          inventoryPool: "regular",
          currencyCode,
          // JPY and KWD price in their minor unit by default.
          priceIncrementMinor: 1,
          // Lines are priced in the order's market (MARKETS-DESIGN D5).
          market: expect.any(Object),
        }),
      );
    },
  );

  it("returns every cart item issue without creating checkout side effects", async () => {
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: false,
      issues: [
        {
          index: 0,
          cartKey: "line_1",
          productId: "product_1",
          variantId: "variant_1",
          code: "QUANTITY_UNAVAILABLE",
          action: "reduce_quantity",
          message: "Only 2 left for Queue Product.",
          productName: "Queue Product",
          variantLabel: null,
          requestedQuantity: 5,
          availableQuantity: 2,
        },
      ],
      items: [],
      subtotalMinor: 0,
      hasFreeDeliveryProduct: false,
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/cart-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              cartKey: "line_1",
              productId: "product_1",
              variantId: "variant_1",
              quantity: 5,
              price: 100,
              productName: "Queue Product",
            },
          ],
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        valid: false,
        issues: [
          {
            cartKey: "line_1",
            code: "QUANTITY_UNAVAILABLE",
            message: "Only 2 left for Queue Product.",
            availableQuantity: 2,
          },
        ],
      },
    });
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.validateStorefrontDeliveryPreflight).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("preflights selected delivery data when cart validation receives city and zone", async () => {
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: true,
      issues: [],
      items: [{
        index: 0,
        cartKey: "line_1",
        productId: "product_1",
        variantId: "variant_1",
        quantity: 1,
        unitPriceMinor: 10_000,
        productName: "Queue Product",
        variantLabel: null,
        freeDelivery: false,
        inventoryTracked: true,
        availableQuantity: null,
        taxClassId: null,
        productImageMediaId: null,
        productImage: null,
      }],
      subtotalMinor: 10_000,
      hasFreeDeliveryProduct: false,
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/cart-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              cartKey: "line_1",
              productId: "product_1",
              variantId: "variant_1",
              quantity: 1,
              price: 100,
              productName: "Queue Product",
            },
          ],
          city: "city_1",
          zone: "zone_1",
          area: null,
          shippingMethodId: "ship_1",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        valid: true,
        delivery: {
          shippingCharge: 60,
          cityName: "Dhaka",
          zoneName: "Mirpur",
        },
      },
    });
    expect(mocks.validateStorefrontDeliveryPreflight).toHaveBeenCalledWith(
      expect.anything(),
      {
        city: "city_1",
        zone: "zone_1",
        area: null,
        shippingMethodId: "ship_1",
      },
      expect.objectContaining({ valid: true }),
    );
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("surfaces stale delivery choices from cart validation without creating checkout side effects", async () => {
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: true,
      issues: [],
      items: [{
        index: 0,
        cartKey: "line_1",
        productId: "product_1",
        variantId: "variant_1",
        quantity: 1,
        unitPriceMinor: 10_000,
        productName: "Queue Product",
        variantLabel: null,
        freeDelivery: false,
        inventoryTracked: true,
        availableQuantity: null,
        taxClassId: null,
        productImageMediaId: null,
        productImage: null,
      }],
      subtotalMinor: 10_000,
      hasFreeDeliveryProduct: false,
    });
    mocks.validateStorefrontDeliveryPreflight.mockRejectedValue(
      new ValidationError("A valid active shipping method is required for this order."),
    );
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/cart-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              cartKey: "line_1",
              productId: "product_1",
              variantId: "variant_1",
              quantity: 1,
              price: 100,
              productName: "Queue Product",
            },
          ],
          city: "city_1",
          zone: "zone_1",
          shippingMethodId: "ship_stale",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "A valid active shipping method is required for this order.",
      },
    });
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("authoritative tax quote", () => {
  it("ignores submitted price data and quotes the validated SKU in minor units", async () => {
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: true,
      issues: [],
      items: [{
        index: 0,
        cartKey: "line_1",
        productId: "product_1",
        variantId: "variant_1",
        quantity: 1,
        unitPriceMinor: 10_000,
        productName: "Authoritative product",
        variantLabel: "Large",
        freeDelivery: false,
        availableQuantity: 4,
        taxClassId: "taxc_standard",
      }],
      subtotalMinor: 10_000,
      hasFreeDeliveryProduct: false,
    });
    mocks.calculateStorefrontTaxQuote.mockResolvedValue({
      ...DEFAULT_TAX_QUOTE,
      enabled: true,
      settingsVersion: 2,
      subtotalMinor: 10_000,
      shippingMinor: 6_000,
      taxableMinor: 16_000,
      taxMinor: 800,
      totalMinor: 16_800,
      lines: [{
        lineId: "line_1",
        productId: "product_1",
        variantId: "variant_1",
        taxClassId: "taxc_standard",
        taxClassName: "Standard",
        unitPriceMinor: 10_000,
        quantity: 1,
        grossAmountMinor: 10_000,
        discountMinor: 0,
        taxableAmountMinor: 10_000,
        taxMinor: 500,
        totalMinor: 10_500,
        components: [],
      }],
      shipping: {
        ...DEFAULT_TAX_QUOTE.shipping,
        taxClassId: "taxc_standard",
        taxClassName: "Standard",
        grossAmountMinor: 6_000,
        taxableAmountMinor: 6_000,
        taxMinor: 300,
        totalMinor: 6_300,
      },
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/tax-quote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{
            cartKey: "line_1",
            productId: "product_1",
            variantId: "variant_1",
            quantity: 1,
            price: 1,
          }],
          city: "city_1",
          zone: "zone_1",
          shippingMethodId: "shipping_1",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      data: Record<string, unknown> & { quoteFingerprint: string; items: Array<Record<string, unknown>> };
    };
    expect(payload.data).toMatchObject({
      valid: true,
      displayLabel: "Tax",
      settingsVersion: 2,
      subtotalMinor: 10_000,
      subtotalAmount: 100,
      shippingMinor: 6_000,
      shippingAmount: 60,
      taxMinor: 800,
      taxAmount: 8,
      totalMinor: 16_800,
      totalAmount: 168,
      shippingMethod: DEFAULT_SHIPPING_METHOD_SNAPSHOT,
      items: [{
        unitPrice: 100,
        productName: "Authoritative product",
        variantLabel: "Large",
      }],
    });
    expect(payload.data.quoteFingerprint).toMatch(/^taxq_[A-Za-z0-9_-]{22}$/);
    expect(mocks.buildStorefrontCheckoutQuoteFingerprint).toHaveBeenCalledWith(
      expect.objectContaining({ totalMinor: 16_800 }),
      DEFAULT_SHIPPING_METHOD_SNAPSHOT,
      ["none"],
    );
    const validatedRequestItem = mocks.validateStorefrontCartItems.mock.calls[0]?.[1]?.[0];
    expect(validatedRequestItem).not.toHaveProperty("price");
    expect(mocks.calculateStorefrontTaxQuote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lines: [expect.objectContaining({
          unitPriceMinor: 10_000,
          taxClassId: "taxc_standard",
        })],
        shippingMinor: 6_000,
      }),
      undefined,
      { apps: expect.anything() },
    );
  });

  it.each([
    {
      currencyCode: "JPY",
      decimalPlaces: 0,
      unitPrice: 100,
      unitPriceMinor: 100,
      subtotal: 200,
      subtotalMinor: 200,
      shippingMinor: 60,
      totalMinor: 260,
    },
    {
      currencyCode: "KWD",
      decimalPlaces: 3,
      unitPrice: 1.235,
      unitPriceMinor: 1_235,
      subtotal: 2.47,
      subtotalMinor: 2_470,
      shippingMinor: 60_000,
      totalMinor: 62_470,
    },
  ])(
    "keeps $currencyCode cart validation and tax-quote precision in parity",
    async ({
      currencyCode,
      decimalPlaces,
      unitPrice,
      unitPriceMinor,
      subtotal,
      subtotalMinor,
      shippingMinor,
      totalMinor,
    }) => {
      mocks.getCurrencySettings.mockResolvedValue({
        currencyCode,
        currencySymbol: currencyCode === "JPY" ? "¥" : "د.ك",
      });
      mocks.validateStorefrontCartItems.mockResolvedValue({
        valid: true,
        issues: [],
        items: [{
          index: 0,
          cartKey: "line_currency",
          productId: "product_1",
          variantId: "variant_1",
          quantity: 2,
          unitPriceMinor,
          productName: "Currency product",
          variantLabel: null,
          freeDelivery: false,
          inventoryTracked: true,
          availableQuantity: 4,
          taxClassId: null,
        }],
        subtotalMinor: currencyCode === "JPY" ? 200 : 2_470,
        hasFreeDeliveryProduct: false,
      });
      mocks.calculateStorefrontTaxQuote.mockResolvedValue({
        ...DEFAULT_TAX_QUOTE,
        currencyCode,
        decimalPlaces,
        subtotalMinor,
        shippingMinor,
        totalMinor,
      });
      const { app, kv } = createTestApp();

      const response = await app.request(
        "/api/v1/orders/tax-quote",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{
              productId: "product_1",
              variantId: "variant_1",
              quantity: 2,
            }],
            city: "city_1",
            zone: "zone_1",
            shippingMethodId: "shipping_1",
          }),
        },
        { CACHE: kv } as never,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        data: {
          currencyCode,
          decimalPlaces,
          subtotalMinor,
          subtotalAmount: subtotal,
          shippingMinor,
          shippingAmount: 60,
          totalMinor,
          totalAmount: subtotal + 60,
          items: [{ unitPrice, quantity: 2 }],
        },
      });
      expect(mocks.getCurrencySettings).toHaveBeenCalledOnce();
      expect(mocks.validateStorefrontCartItems).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Array),
        expect.objectContaining({ inventoryPool: "regular", currencyCode, priceIncrementMinor: 1, market: expect.any(Object) }),
      );
      expect(mocks.calculateStorefrontTaxQuote).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          lines: [expect.objectContaining({ unitPriceMinor, quantity: 2 })],
          currency: { code: currencyCode, decimalPlaces, priceIncrementMinor: 1 },
        }),
        undefined,
        { apps: expect.anything() },
      );
    },
  );

  it("passes the applied discount allocation to the shared tax quote service", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_quote_owner",
      email: "buyer@example.com",
      name: "Signed In Buyer",
      phone: "+8801812345678",
      customerId: "customer_quote_owner",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: true,
      issues: [],
      items: [{
        index: 0,
        cartKey: "line_1",
        productId: "product_1",
        variantId: "variant_1",
        quantity: 1,
        unitPriceMinor: 10_000,
        productName: "Product",
        variantLabel: null,
        freeDelivery: false,
        inventoryTracked: true,
        availableQuantity: 2,
        taxClassId: "taxc_1",
      }],
      subtotalMinor: 10_000,
      hasFreeDeliveryProduct: false,
    });
    const taxAllocation = { lines: [{ lineId: "cart:0:variant_1", amountMinor: 5_000 }], shippingMinor: 0 };
    const offer = {
      promotionId: "promo_gift", title: "Buy a tee, get a cap free", code: null, kind: "get",
      basisPoints: 10_000, quantity: 1, shortfallMinor: null,
      products: [{ id: "prod_cap", slug: "cap", name: "Cap", variantId: "var_cap", price: 200 }],
    };
    mocks.quoteStorefrontDiscount.mockResolvedValue({
      applied: {},
      snapshot: {},
      taxAllocation,
      discounts: [{ promotionId: "promo_50", title: "Half off", code: "PRODUCT50", amountMinor: 5_000, shippingAmountMinor: 0 }],
      offers: [offer],
      rejectedCodes: [{ code: "EXTRA", reason: "minimum_quantity", message: "Add 1 more item to use EXTRA.", shortfallQuantity: 1 }],
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/tax-quote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_quote_owner",
        },
        body: JSON.stringify({
          items: [{ productId: "product_1", variantId: "variant_1", quantity: 1 }],
          city: "city_1",
          zone: "zone_1",
          shippingMethodId: "shipping_1",
          discountCodes: ["PRODUCT50", "EXTRA"],
          customerPhone: "+8801712345678",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: {
      discounts: [{ promotionId: "promo_50", title: "Half off", code: "PRODUCT50", amount: 50 }],
      offers: [{
        title: "Buy a tee, get a cap free", kind: "get", percentOff: 100, quantity: 1, shortfallAmount: null,
        products: [{ id: "prod_cap", slug: "cap", name: "Cap", variantId: "var_cap", price: 200 }],
      }],
      rejectedCodes: [{ code: "EXTRA", reason: "minimum_quantity", message: "Add 1 more item to use EXTRA.", shortfallQuantity: 1 }],
    } });
    expect(mocks.calculateStorefrontTaxQuote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ promotionDiscountAllocation: taxAllocation }),
      undefined,
      { apps: expect.anything() },
    );
    expect(mocks.quoteStorefrontDiscount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      codes: ["PRODUCT50", "EXTRA"],
      customerId: "customer_quote_owner",
      customerPhone: "+8801712345678",
      cart: expect.objectContaining({
        lines: [expect.objectContaining({ id: "cart:0:variant_1", productId: "product_1", quantity: 1 })],
        shippingAmountMinor: 6_000,
      }),
    }));
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(
      expect.anything(),
      "session_quote_owner",
      undefined,
    );
  });
});

describe("checkout status", () => {
  it("rejects receipt proof in the status URL before any D1 read", async () => {
    const { app, db } = createStatusTestApp({
      attempt: {
        status: "committed",
        orderId: "order_1",
        checkoutToken: "chk_status",
      },
    });

    const response = await app.request("/api/v1/orders/status/chk_status", {}, {} as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Invalid checkout status token",
      },
    });
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe("create order currency parity", () => {
  it.each([
    { currencyCode: "JPY", decimalPlaces: 0, unitPrice: 100, unitPriceMinor: 100, subtotal: 200, totalMinor: 260 },
    { currencyCode: "KWD", decimalPlaces: 3, unitPrice: 1.235, unitPriceMinor: 1_235, subtotal: 2.47, totalMinor: 62_470 },
  ])(
    "keeps $currencyCode cart authority through order creation",
    async ({ currencyCode, decimalPlaces, unitPrice, unitPriceMinor, subtotal, totalMinor }) => {
      const cartValidation = {
        valid: true,
        issues: [],
        items: [{
          index: 0,
          cartKey: null,
          productId: "product_1",
          variantId: "variant_1",
          quantity: 2,
          unitPriceMinor,
          productName: "Currency product",
          variantLabel: null,
          freeDelivery: false,
          inventoryTracked: true,
          availableQuantity: 4,
          taxClassId: null,
        }],
        subtotalMinor: currencyCode === "JPY" ? 200 : 2_470,
        hasFreeDeliveryProduct: false,
      };
      const quote = {
        ...DEFAULT_TAX_QUOTE,
        currencyCode,
        decimalPlaces,
        subtotalMinor: currencyCode === "JPY" ? 200 : 2_470,
        shippingMinor: currencyCode === "JPY" ? 60 : 60_000,
        totalMinor,
      };
      mocks.getCurrencySettings.mockResolvedValue({
        currencyCode,
        currencySymbol: currencyCode === "JPY" ? "¥" : "د.ك",
      });
      mocks.validateStorefrontCartItems.mockResolvedValue(cartValidation);
      mocks.createStorefrontOrder.mockResolvedValue({
        checkoutToken: `chk_${currencyCode.toLowerCase()}`,
        orderId: `order_${currencyCode.toLowerCase()}`,
        paymentMethod: "cod",
        taxQuote: quote,
        commitPayload: { orderData: { id: `order_${currencyCode.toLowerCase()}` } },
      });
      const { app, kv } = createTestApp();

      const response = await app.request(
        "/api/v1/orders",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...validOrderBody,
            items: [{
              ...validOrderBody.items[0],
              quantity: 2,
              price: unitPrice,
            }],
          }),
        },
        { CACHE: kv } as never,
      );

      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({
        success: true,
        data: {
          currencyCode,
          decimalPlaces,
          totalAmount: subtotal + 60,
          totalAmountMinor: totalMinor,
        },
      });
      expect(mocks.getCurrencySettings).toHaveBeenCalledOnce();
      expect(mocks.validateStorefrontCartItems).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Array),
        { inventoryPool: "regular", currencyCode },
      );
      expect(mocks.validateStorefrontDeliveryPreflight).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ city: "city_1" }),
        cartValidation,
      );
      expect(mocks.createStorefrontOrder.mock.calls[0]?.[4]).toBe(cartValidation);
    },
  );
});

describe("checkout status and commit without KV hints", () => {
  it("answers a poll from D1 alone and never leaks receipt proof", async () => {
    const { app, statusToken } = createStatusTestApp({
      attempt: { status: "committed", orderId: "order_1", checkoutToken: "chk_status" },
      orderExists: true,
    });
    const executionCtx = createWaitUntilContext();

    const response = await app.request(`/api/v1/orders/status/${statusToken}`, {}, {} as never, executionCtx as never);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ success: true, data: { status: "completed", orderId: "order_1" } });
    expect(JSON.stringify(json)).not.toContain("chk_");
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });

  it("answers failed and processing attempts from D1 too, ", async () => {
    const failed = createStatusTestApp({ attempt: { status: "failed", orderId: "order_1", checkoutToken: "chk_status", lastError: "Out of stock" } });
    const failedResponse = await failed.app.request(`/api/v1/orders/status/${failed.statusToken}`, {}, {} as never);
    expect(await failedResponse.json()).toMatchObject({ data: { status: "failed", error: "Order creation failed. Please review your checkout and try again." } });

    const processing = createStatusTestApp({ attempt: { status: "processing", orderId: "order_1", checkoutToken: "chk_status" }, orderExists: false });
    const processingResponse = await processing.app.request(`/api/v1/orders/status/${processing.statusToken}`, {}, {} as never);
    expect(processingResponse.status).toBe(202);
    expect(await processingResponse.json()).toMatchObject({ data: { status: "processing" } });

    const committed = createStatusTestApp({ attempt: { status: "processing", orderId: "order_1", checkoutToken: "chk_status" }, orderExists: true });
    const committedResponse = await committed.app.request(`/api/v1/orders/status/${committed.statusToken}`, {}, {} as never);
    expect(await committedResponse.json()).toMatchObject({ data: { status: "completed", orderId: "order_1" } });
  });

  it("writes no KV hint after an order commits", async () => {
    const { app, kv } = createTestApp();
    const executionCtx = createWaitUntilContext();
    const response = await app.request(
      "/api/v1/orders",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validOrderBody) },
      { CACHE: kv } as never,
      executionCtx as never,
    );
    expect(response.status).toBe(201);
    await Promise.all(executionCtx.waitUntil.mock.calls.map(([task]) => task));
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
  });
});

describe("create order commit ordering", () => {

  it("rejects a changed authoritative quote before rate limiting or durable checkout writes", async () => {
    const { app, kv } = createTestApp();
    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validOrderBody,
          expectedQuoteFingerprint: "taxq_vutsrqponmlkjihgfedcba",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: "STOREFRONT_CHECKOUT_QUOTE_CONFLICT",
        message: expect.stringContaining("Review the refreshed total"),
      },
    });
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
  });

  it("requires the quote fingerprint that the buyer reviewed", async () => {
    const { expectedQuoteFingerprint: _omitted, ...body } = validOrderBody;
    const { app, kv } = createTestApp();
    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.buildCheckoutAttemptIdentity).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
  });

  it("commits the order before side effects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waitUntilPromises: Promise<unknown>[] = [];
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_1",
      orderId: "order_1",
      paymentMethod: "cod",
      totalAmount: 100,
      taxQuote: DEFAULT_TAX_QUOTE,
      commitPayload: { orderData: { id: "order_1" } },
    });
    const { app, kv, calls } = createTestApp();
    const executionCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      }),
      passThroughOnException: vi.fn(),
    };
    mocks.commitStorefrontOrderPayload.mockImplementation(async () => {
      calls.push("commit");
      return { availabilityTransitionVariantIds: [] };
    });
    mocks.runStorefrontOrderPostCommitSideEffects.mockImplementation(async () => {
      calls.push("side-effects");
    });
    try {
      const response = await app.request(
        "/api/v1/orders",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validOrderBody),
        },
        { CACHE: kv } as never,
        executionCtx as never,
      );

      const responseText = await response.clone().text();
      expect(response.status, responseText).toBe(201);
      expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
      await Promise.all(waitUntilPromises);

      expect(calls[0]).toBe("commit");
      expect(calls).toContain("side-effects");
      expect(kv.put).not.toHaveBeenCalled();
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("chk_order_1");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("chk_");
      expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderData: { id: "order_1" } }),
        expect.objectContaining({
          attempt: expect.objectContaining({
            id: "coa_1",
            commitMode: "atomic",
            origin: "new",
            orderId: "order_1",
            checkoutToken: "chk_order_1",
          }),
          response: expect.objectContaining({
            orderId: "order_1",
            receiptToken: "chk_order_1",
            statusToken: DEFAULT_STATUS_TOKEN,
          }),
        }),
        PREFETCHED_COMMIT_READS,
      );
      expect(mocks.createStorefrontOrder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ checkoutRequestId: "checkout_req_123456" }),
        expect.any(String),
        {
          orderId: "order_1",
          checkoutToken: "chk_order_1",
        },
        expect.objectContaining({ valid: true }),
        expect.objectContaining({
          shippingMinor: 6_000,
          cityName: "Dhaka",
          zoneName: "Mirpur",
        }),
        undefined,
        { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
        expect.objectContaining({ partialPaymentEnabled: false }),
        expect.objectContaining({ classes: [], rates: [] }),
        { masterSecret: expect.toBeOneOf([null, expect.any(String)]) },
        { apps: expect.objectContaining({ points: new Set() }), channel: "online_store", paymentProviders: expect.anything(), appProviders: expect.anything() },
    );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not log raw checkout proof after the atomic commit", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { app, kv } = createTestApp();

      const response = await app.request(
        "/api/v1/orders",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validOrderBody),
        },
        { CACHE: kv } as never,
      );

      const responseText = await response.clone().text();
      expect(response.status, responseText).toBe(201);
      const serializedLogs = JSON.stringify(consoleError.mock.calls);
      expect(serializedLogs).not.toContain("chk_order_1");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("replays a committed checkout attempt despite later policy and rate-limit changes", async () => {
    mocks.resolveExistingCheckoutAttempt.mockResolvedValue({
      status: "replay",
      response: {
        checkoutToken: "chk_replay",
        receiptToken: "chk_replay",
        statusToken: DEFAULT_STATUS_TOKEN,
        orderId: "order_replay",
        paymentMethod: "cod",
        totalAmount: 100,
        message: "Order created",
      },
    });
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["stripe"],
      defaultMethod: "stripe",
    });
    mocks.limiter.limit.mockResolvedValue({ success: false });
    const { app, kv } = createTestApp({
      guestCheckoutEnabled: false,
      checkoutMode: "gateways_only",
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const json = await response.json() as { data: { orderId: string; receiptToken: string } };
    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      orderId: "order_replay",
      receiptToken: "chk_replay",
    });
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns a pollable processing response for an active duplicate despite later policy changes", async () => {
    mocks.resolveExistingCheckoutAttempt.mockResolvedValue({
      status: "processing",
      orderId: "order_processing",
      statusToken: DEFAULT_STATUS_TOKEN,
    });
    mocks.limiter.limit.mockResolvedValue({ success: false });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const json = await response.json() as { data: { checkoutToken?: string; statusToken: string; orderId: string; status: string } };
    expect(response.status).toBe(202);
    expect(json.data).toEqual({
      statusToken: DEFAULT_STATUS_TOKEN,
      orderId: "order_processing",
      status: "processing",
      message: "Order creation is already processing.",
    });
    expect(json.data.statusToken).not.toMatch(/^chk_/);
    expect(json.data).not.toHaveProperty("checkoutToken");
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("replays the winner when atomic commit arbitration loses a race", async () => {
    mocks.resolveExistingCheckoutAttempt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
      status: "replay",
      response: {
        checkoutToken: "chk_race_replay",
        receiptToken: "chk_race_replay",
        statusToken: DEFAULT_STATUS_TOKEN,
        orderId: "order_race_replay",
        paymentMethod: "cod",
        totalAmount: 100,
        message: "Order created",
      },
    });
    mocks.commitStorefrontOrderPayload.mockRejectedValue(
      new ConflictError("Another checkout submit committed first."),
    );
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const json = await response.json() as { data: { orderId: string; receiptToken: string } };
    expect(response.status).toBe(201);
    expect(json.data).toMatchObject({
      orderId: "order_race_replay",
      receiptToken: "chk_race_replay",
    });
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
  });

  it("returns an active legacy winner when atomic commit arbitration loses a race", async () => {
    mocks.resolveExistingCheckoutAttempt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
      status: "processing",
      orderId: "order_race_processing",
      statusToken: DEFAULT_STATUS_TOKEN,
    });
    mocks.commitStorefrontOrderPayload.mockRejectedValue(
      new ConflictError("Another checkout submit committed first."),
    );
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const json = await response.json() as { data: { checkoutToken?: string; statusToken: string; orderId: string; status: string } };
    expect(response.status).toBe(202);
    expect(json.data).toEqual({
      statusToken: DEFAULT_STATUS_TOKEN,
      orderId: "order_race_processing",
      status: "processing",
      message: "Order creation is already processing.",
    });
    expect(json.data.statusToken).not.toMatch(/^chk_/);
    expect(json.data).not.toHaveProperty("checkoutToken");
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects changed checkout details before policy, rate limiting, or order preparation", async () => {
    mocks.resolveExistingCheckoutAttempt.mockRejectedValue(
      new ConflictError("This checkout request was already used for different checkout details. Please refresh checkout and try again."),
    );
    mocks.limiter.limit.mockResolvedValue({ success: false });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(409);
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects stale cart items before policy, rate limiting, or atomic attempt creation", async () => {
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: false,
      issues: [
        {
          index: 0,
          productId: "product_1",
          variantId: "variant_1",
          code: "PRICE_CHANGED",
          action: "refresh_item",
          message: "The price for Queue Product changed. Please review the updated cart total.",
          productName: "Queue Product",
          variantLabel: null,
          requestedQuantity: 1,
          submittedPrice: 100,
          currentPrice: 120,
        },
      ],
      items: [],
      subtotalMinor: 0,
      hasFreeDeliveryProduct: false,
    });
    mocks.limiter.limit.mockResolvedValue({ success: false });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Some items in your cart need attention.",
        details: {
          itemIssues: [
            {
              code: "PRICE_CHANGED",
              message: "The price for Queue Product changed. Please review the updated cart total.",
              currentPrice: 120,
            },
          ],
        },
      },
    });
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontCartItems).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontDeliveryPreflight).not.toHaveBeenCalled();
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects stale delivery choices before policy, rate limiting, or atomic attempt creation", async () => {
    mocks.validateStorefrontDeliveryPreflight.mockRejectedValue(
      new ValidationError("Selected zone is no longer available for the chosen city."),
    );
    mocks.limiter.limit.mockResolvedValue({ success: false });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Selected zone is no longer available for the chosen city.",
      },
    });
    expect(mocks.buildCheckoutAttemptIdentity).toHaveBeenCalledOnce();
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontCartItems).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontDeliveryPreflight).toHaveBeenCalledWith(
      expect.anything(),
      {
        city: "city_1",
        zone: "zone_1",
        area: null,
        shippingMethodId: undefined,
        currencyCode: "BDT",
      },
      expect.objectContaining({ valid: true }),
    );
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("schedules availability purging only for a buyer-visible transition", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mocks.createStorefrontOrder.mockResolvedValue({
        checkoutToken: "chk_order_cache_failure",
        orderId: "order_cache_failure",
        paymentMethod: "cod",
        totalAmount: 100,
        taxQuote: DEFAULT_TAX_QUOTE,
        commitPayload: {
          orderData: {
            id: "order_cache_failure",
            inventoryAction: "reserved",
          },
          items: [{
            variantId: "variant_transition",
            quantity: 1,
            inventoryTracked: true,
          }],
        },
      });
      mocks.commitStorefrontOrderPayload.mockResolvedValue({
        availabilityTransitionVariantIds: ["variant_transition"],
      });
      const { app, kv } = createTestApp();

      const response = await app.request(
        "/api/v1/orders",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validOrderBody),
        },
        { CACHE: kv } as never,
      );

      const responseText = await response.clone().text();
      expect(response.status, responseText).toBe(201);
      expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
      expect(mocks.runStorefrontOrderPostCommitSideEffects).toHaveBeenCalledOnce();

      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "availability caches",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports checkout failure without creating a durable failed-attempt write", async () => {
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_2",
      orderId: "order_2",
      paymentMethod: "cod",
      totalAmount: 100,
      taxQuote: DEFAULT_TAX_QUOTE,
      commitPayload: { orderData: { id: "order_2" } },
    });
    const { app, kv, calls } = createTestApp();
    mocks.commitStorefrontOrderPayload.mockImplementation(async () => {
      calls.push("commit");
      throw new Error("commit unavailable");
    });
    mocks.runStorefrontOrderPostCommitSideEffects.mockImplementation(async () => {
      calls.push("side-effects");
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(500);
    expect(calls).toEqual(["commit"]);
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("surfaces discount commit validation failures in the response body", async () => {
    const discountError = new ValidationError("Discount code has reached its usage limit");
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_discount_limit",
      orderId: "order_discount_limit",
      paymentMethod: "cod",
      totalAmount: 100,
      taxQuote: DEFAULT_TAX_QUOTE,
      commitPayload: { orderData: { id: "order_discount_limit" } },
    });
    const { app, kv } = createTestApp();
    mocks.commitStorefrontOrderPayload.mockRejectedValue(discountError);

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Discount code has reached its usage limit",
      },
    });
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects phones outside the configured include countries before payment settings, rate limits, or attempt creation", async () => {
    const { app, kv } = createTestApp({
      allowedCountries: ["BD"],
      allowedCountriesMode: "include",
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validOrderBody,
          customerPhone: "+14155552671",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Phone numbers from US are not accepted",
      },
    });
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontCartItems).toHaveBeenCalledOnce();
    expect(mocks.validateStorefrontDeliveryPreflight).toHaveBeenCalledOnce();
    expect(mocks.getActivePaymentMethods).toHaveBeenCalledOnce();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects phones listed in configured exclude countries before payment settings, rate limits, or attempt creation", async () => {
    const { app, kv } = createTestApp({
      allowedCountries: ["BD"],
      allowedCountriesMode: "exclude",
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Phone numbers from BD are not accepted",
      },
    });
    expect(mocks.getActivePaymentMethods).toHaveBeenCalledOnce();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects guest checkout before rate limiting or order creation when merchant disables guests", async () => {
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(401);
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.getCustomerBySession).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
  });

  it("allows checkout when guests are disabled but a valid customer session is forwarded", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_1",
      email: "",
      name: "Queue Customer",
      phone: "+8801712345678",
      customerId: "customer_1",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_3",
      orderId: "order_3",
      paymentMethod: "cod",
      totalAmount: 100,
      taxQuote: DEFAULT_TAX_QUOTE,
      commitPayload: { orderData: { id: "order_3" } },
    });
    const { app, db, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_1",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(201);
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(db, "session_1", undefined);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
  });

  it("keeps signed-in ownership when the buyer uses a different delivery phone", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_guest_enabled_mismatch",
      email: "buyer@example.com",
      name: "Signed In Buyer",
      phone: "+8801812345678",
      customerId: "customer_signed_in",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    const { app, db, kv } = createTestApp({ guestCheckoutEnabled: true });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_guest_enabled_mismatch",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(db, "session_guest_enabled_mismatch", undefined);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerPhone: "+8801712345678" }),
      expect.any(String),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        customerId: "customer_signed_in",
        source: "authenticated",
      },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { masterSecret: expect.toBeOneOf([null, expect.any(String)]) },
      { apps: expect.objectContaining({ points: new Set() }), channel: "online_store", paymentProviders: expect.anything(), appProviders: expect.anything() },
    );
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
  });

  // Every sign-in permutation: a guest store never stops a buyer for a
  // session (absent or ended); a sign-in-only store says what to do.
  it.each([
    { guests: true, session: "none", status: 201, customerId: null, ended: false },
    { guests: true, session: "ended", status: 201, customerId: null, ended: true },
    { guests: true, session: "live", status: 201, customerId: "customer_live", ended: false },
    { guests: false, session: "none", status: 401, customerId: null, ended: false },
    { guests: false, session: "ended", status: 401, customerId: null, ended: false },
    { guests: false, session: "live", status: 201, customerId: "customer_live", ended: false },
  ] as const)("guest checkout $guests with a $session session answers $status", async ({ guests, session, status, customerId, ended }) => {
    mocks.getCustomerBySession.mockResolvedValue(session === "live"
      ? {
        token: "session_live",
        email: "buyer@example.com",
        name: "Signed In Buyer",
        phone: "+8801712345678",
        customerId: "customer_live",
        createdAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
      }
      : null);
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_session",
      orderId: "order_session",
      paymentMethod: "cod",
      totalAmount: 100,
      taxQuote: DEFAULT_TAX_QUOTE,
      commitPayload: { orderData: { id: "order_session" } },
    });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: guests });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session === "none" ? {} : { "X-Customer-Session": `session_${session}` }),
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status, await response.clone().text()).toBe(status);
    expect(response.headers.get("X-Customer-Session-Ended")).toBe(ended ? "1" : null);
    if (status === 401) {
      expect(await response.json()).toMatchObject({
        success: false,
        error: {
          code: "CUSTOMER_SIGN_IN_REQUIRED",
          message: "Sign in to place your order. This store sells only to signed-in customers.",
        },
      });
      expect(mocks.limiter.limit).not.toHaveBeenCalled();
      expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
      expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
      return;
    }
    expect(mocks.createStorefrontOrder.mock.calls[0]?.[6]).toEqual(customerId
      ? { customerId, source: "authenticated" }
      : undefined);
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
  });

  it("binds signed-in checkout to the session customer when guest checkout is enabled", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_guest_enabled_match",
      email: "buyer@example.com",
      name: "Signed In Buyer",
      phone: "+8801712345678",
      customerId: "customer_signed_in",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_session_owner",
      orderId: "order_session_owner",
      paymentMethod: "cod",
      totalAmount: 100,
      taxQuote: DEFAULT_TAX_QUOTE,
      commitPayload: { orderData: { id: "order_session_owner" } },
    });
    const { app, db, kv } = createTestApp({ guestCheckoutEnabled: true });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_guest_enabled_match",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(201);
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(db, "session_guest_enabled_match", undefined);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerPhone: "+8801712345678" }),
      expect.any(String),
      expect.objectContaining({
        orderId: "order_1",
        checkoutToken: "chk_order_1",
      }),
      expect.objectContaining({ valid: true }),
      expect.objectContaining({ cityName: "Dhaka", zoneName: "Mirpur" }),
      {
        customerId: "customer_signed_in",
        source: "authenticated",
      },
      { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
      expect.objectContaining({ partialPaymentEnabled: false }),
      expect.objectContaining({ classes: [], rates: [] }),
      { masterSecret: expect.toBeOneOf([null, expect.any(String)]) },
      { apps: expect.objectContaining({ points: new Set() }), channel: "online_store", paymentProviders: expect.anything(), appProviders: expect.anything() },
    );
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
  });

  it("allows a different delivery phone when signed-in checkout is required", async () => {
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_2",
      email: "",
      name: "Different Customer",
      phone: "+8801812345678",
      customerId: "customer_2",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_2",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerPhone: "+8801712345678" }),
      expect.any(String),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        customerId: "customer_2",
        source: "authenticated",
      },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { masterSecret: expect.toBeOneOf([null, expect.any(String)]) },
      { apps: expect.objectContaining({ points: new Set() }), channel: "online_store", paymentProviders: expect.anything(), appProviders: expect.anything() },
    );
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
  });

  it("lets a signed-in account without a phone check out with the order's own phone", async () => {
    // The order's contact follows the shared rule (orderContactNeeds); the
    // account's phone (none here: an e-mail sign-up with the opt-in) is not it.
    mocks.getCustomerBySession.mockResolvedValue({
      token: "session_3",
      email: "buyer@example.com",
      name: "Email Only Customer",
      customerId: "customer_3",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    const { app, kv } = createTestApp({ guestCheckoutEnabled: false });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "session_3",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerPhone: "+8801712345678" }),
      expect.any(String),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { customerId: "customer_3", source: "authenticated" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("passes an empty phone on as null, for the shared contact rule to decide", async () => {
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, customerPhone: "", customerEmail: "buyer@example.com" }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerPhone: null, customerEmail: "buyer@example.com" }),
      expect.any(String),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("rejects COD order creation when checkout mode is gateways only", async () => {
    const { app, kv } = createTestApp({ checkoutMode: "gateways_only" });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects online order creation when checkout mode is fast COD only", async () => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["stripe"],
      defaultMethod: "stripe",
    });
    const { app, kv } = createTestApp({ checkoutMode: "guest_cod_only" });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "stripe" }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects a payment method that is not in the fresh active method allowlist", async () => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["stripe"],
      defaultMethod: "stripe",
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(503);
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("fails closed for SSLCommerz before attempt creation when only JWT fallback could read credentials", async () => {
    mocks.getActivePaymentMethods.mockImplementation(async (_db, _kv, encryptionKey?: string) => ({
      enabledMethods: encryptionKey === "jwt-fallback" ? ["scalius.bangladesh:sslcommerz"] : [],
      defaultMethod: encryptionKey === "jwt-fallback" ? "scalius.bangladesh:sslcommerz" : "cod",
    }));
    const { app, db, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "scalius.bangladesh:sslcommerz" }),
      },
      { CACHE: kv, JWT_SECRET: "jwt-fallback" } as never,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "SSLCommerz is not enabled for checkout.",
      },
    });
    expect(mocks.getActivePaymentMethods).toHaveBeenCalledWith(
      db,
      undefined,
    );
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects SSLCommerz when the authoritative store currency is not BDT", async () => {
    mocks.getCurrencySettings.mockResolvedValue({
      currencyCode: "KWD",
      currencySymbol: "د.ك",
    });
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["scalius.bangladesh:sslcommerz"],
      defaultMethod: "scalius.bangladesh:sslcommerz",
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "scalius.bangladesh:sslcommerz" }),
      },
      { CACHE: kv, CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "SSLCommerz checkout requires the store currency to be BDT. Current currency: KWD.",
      },
    });
    expect(mocks.calculateStorefrontTaxQuote).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it.each([
    ["below", 9.99],
    ["above", 500000.01],
  ])("rejects SSLCommerz full-payment amounts %s provider bounds before checkout writes", async (_label, subtotal) => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["scalius.bangladesh:sslcommerz"],
      defaultMethod: "scalius.bangladesh:sslcommerz",
    });
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: true,
      issues: [],
      items: [],
      subtotal,
      hasFreeDeliveryProduct: true,
    });
    mocks.validateStorefrontDeliveryPreflight.mockResolvedValue({
      shippingCharge: 0,
      shippingMethod: {
        ...DEFAULT_SHIPPING_METHOD_SNAPSHOT,
        feeWaived: true,
      },
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: null,
    });
    mocks.calculateStorefrontTaxQuote.mockResolvedValue({
      ...DEFAULT_TAX_QUOTE,
      subtotalMinor: Math.round(subtotal * 100),
      totalMinor: Math.round(subtotal * 100),
    });
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_ssl_bounds",
      orderId: "order_ssl_bounds",
      paymentMethod: "scalius.bangladesh:sslcommerz",
      totalAmount: subtotal,
      taxQuote: {
        ...DEFAULT_TAX_QUOTE,
        subtotalMinor: Math.round(subtotal * 100),
        totalMinor: Math.round(subtotal * 100),
      },
      commitPayload: { orderData: { id: "order_ssl_bounds" } },
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "scalius.bangladesh:sslcommerz" }),
      },
      { CACHE: kv, CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "SSLCommerz payment amount must be between 10.00 BDT and 500000.00 BDT.",
      },
    });
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects SSLCommerz deposit amounts outside provider bounds before checkout writes", async () => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["scalius.bangladesh:sslcommerz"],
      defaultMethod: "scalius.bangladesh:sslcommerz",
    });
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: true,
      issues: [],
      items: [],
      subtotal: 100,
      hasFreeDeliveryProduct: true,
    });
    mocks.validateStorefrontDeliveryPreflight.mockResolvedValue({
      shippingCharge: 0,
      shippingMethod: {
        ...DEFAULT_SHIPPING_METHOD_SNAPSHOT,
        feeWaived: true,
      },
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: null,
    });
    mocks.calculateStorefrontTaxQuote.mockResolvedValue(DEFAULT_TAX_QUOTE);
    // The prepared order carries the method the buyer chose.
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_1",
      orderId: "order_1",
      paymentMethod: "scalius.bangladesh:sslcommerz",
      taxQuote: DEFAULT_TAX_QUOTE,
      commitPayload: { orderData: { id: "order_1" } },
    });
    const { app, kv } = createTestApp({
      partialPaymentEnabled: true,
      partialPaymentAmount: 9.99,
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "scalius.bangladesh:sslcommerz" }),
      },
      { CACHE: kv, CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "SSLCommerz payment amount must be between 10.00 BDT and 500000.00 BDT.",
      },
    });
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("uses the recomputed committed quote after SSLCommerz precommit validation", async () => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["scalius.bangladesh:sslcommerz"],
      defaultMethod: "scalius.bangladesh:sslcommerz",
    });
    mocks.calculateStorefrontTaxQuote.mockResolvedValue(DEFAULT_TAX_QUOTE);
    const committedQuote = {
      ...DEFAULT_TAX_QUOTE,
      taxMinor: 2_000,
      totalMinor: 12_000,
    };
    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_ssl_recomputed",
      orderId: "order_ssl_recomputed",
      paymentMethod: "scalius.bangladesh:sslcommerz",
      totalAmount: 120,
      taxQuote: committedQuote,
      commitPayload: { orderData: { id: "order_ssl_recomputed", totalAmountMinor: 12_000 } },
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "scalius.bangladesh:sslcommerz" }),
      },
      { CACHE: kv, CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as never,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        totalAmount: 120,
        totalAmountMinor: 12_000,
        taxAmountMinor: 2_000,
      },
    });
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderData: expect.objectContaining({ totalAmountMinor: 12_000 }) }),
      expect.objectContaining({
        response: expect.objectContaining({ totalAmount: 120 }),
      }),
      PREFETCHED_COMMIT_READS,
    );
  });

  it("limits checkout IP on the standard tier and phone on the strict tier with store-scoped hashed keys", async () => {
    const standard = { limit: vi.fn(async () => ({ success: true })) };
    const strict = { limit: vi.fn(async () => ({ success: true })) };
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      {
        CACHE: kv,
        RL_STANDARD: standard,
        RL_STRICT: strict,
        PUBLIC_API_BASE_URL: "https://merchant-api.example",
      } as never,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(standard.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(strict.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify([
      standard.limit.mock.calls,
      strict.limit.mock.calls,
    ])).not.toContain(validOrderBody.customerPhone);
  });

  it("rejects a checkout denied by the strict phone limiter before order writes", async () => {
    const standard = { limit: vi.fn(async () => ({ success: true })) };
    const strict = { limit: vi.fn(async () => ({ success: false })) };
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      {
        CACHE: kv,
        RL_STANDARD: standard,
        RL_STRICT: strict,
      } as never,
    );

    expect(response.status).toBe(429);
    expect(mocks.createAtomicCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
  });

  it("rate limits a new checkout after pure preparation but before order writes", async () => {
    mocks.limiter.limit.mockResolvedValue({ success: false });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(429);
    expect(mocks.resolveExistingCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.limiter.limit).toHaveBeenCalledTimes(2);
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
  });

  it("rejects COD before commit when partial payment requires an online deposit", async () => {
    const { app, kv } = createTestApp({
      partialPaymentEnabled: true,
      partialPaymentAmount: 50,
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.limiter.limit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects empty carts and non-integer quantities at the API boundary", async () => {
    const { app, kv } = createTestApp();

    const emptyCart = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, items: [] }),
      },
      { CACHE: kv } as never,
    );
    const fractionalQuantity = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validOrderBody,
          items: [{ ...validOrderBody.items[0], quantity: 1.5 }],
        }),
      },
      { CACHE: kv } as never,
    );
    const excessiveQuantity = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validOrderBody,
          items: [{ ...validOrderBody.items[0], quantity: 100 }],
        }),
      },
      { CACHE: kv } as never,
    );

    expect(emptyCart.status).toBe(400);
    expect(fractionalQuantity.status).toBe(400);
    expect(excessiveQuantity.status).toBe(400);
    expect(mocks.getActivePaymentMethods).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("rejects more discount codes than a buyer may combine at the checkout schema boundary", async () => {
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validOrderBody,
          discountCodes: ["A1A", "B2B", "C3C", "D4D", "E5E", "F6F"],
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.buildCheckoutAttemptIdentity).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["synthetic default", "default"],
  ])("rejects a %s variant before checkout identity or D1 work", async (_label, variantId) => {
    const { app, kv } = createTestApp();
    const item = { ...validOrderBody.items[0] } as Record<string, unknown>;
    if (variantId === undefined) {
      delete item.variantId;
    } else {
      item.variantId = variantId;
    }

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, items: [item] }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(mocks.buildCheckoutAttemptIdentity).not.toHaveBeenCalled();
    expect(mocks.resolveExistingCheckoutAttempt).not.toHaveBeenCalled();
    expect(mocks.validateStorefrontCartItems).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("does not write checkout status or receipt proof when location validation fails", async () => {
    mocks.validateStorefrontDeliveryPreflight.mockRejectedValue(
      new ValidationError("Selected zone is no longer available for the chosen city."),
    );
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Selected zone is no longer available for the chosen city.",
      },
    });
    expect(kv.put).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
  });

  it("does not write checkout status or receipt proof when the cart product is unavailable", async () => {
    const unavailableError = new NotFoundError("Product product_1 not found or is inactive.");
    mocks.createStorefrontOrder.mockRejectedValue(unavailableError);
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    const responseText = await response.clone().text();
    expect(response.status, responseText).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Product product_1 not found or is inactive.",
      },
    });
    expect(kv.put).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
  });
});

/**
 * Wave A is additive for the storefront: the storefront deployed before the
 * API keeps sending the pre-Wave A payloads (always an address, no buyer
 * inputs) to the new API between the two deploys. These are those payloads
 * verbatim (lib/checkout/create-order.ts, tax-quote-client.ts).
 */
describe("old-storefront payloads against the Wave A API", () => {
  const oldCheckoutBody = {
    checkoutRequestId: "checkout_req_123456",
    expectedQuoteFingerprint: DEFAULT_QUOTE_FINGERPRINT,
    customerName: "Old Storefront",
    customerPhone: "+8801712345678",
    customerEmail: null,
    shippingAddress: "123 Queue Street, Mirpur",
    city: "city_1",
    zone: "zone_1",
    area: null,
    cityName: "Dhaka",
    zoneName: "Mirpur",
    areaName: null,
    notes: null,
    items: [{
      cartKey: "line:v2:product_1:variant:variant_1",
      productId: "product_1",
      variantId: "variant_1",
      quantity: 1,
      price: 100,
      productName: "Queue Product",
      variantLabel: null,
    }],
    shippingCharge: 60,
    shippingMethodId: "shipping_1",
    discountCodes: [],
    paymentMethod: "cod",
  };

  it("creates an order from the old checkout body and answers with every old field", async () => {
    const { app, kv } = createTestApp();
    const response = await app.request("/api/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(oldCheckoutBody),
    }, { CACHE: kv } as never);

    expect(response.status, await response.clone().text()).toBe(201);
    const body = await response.json() as { data: Record<string, unknown> };
    for (const field of ["checkoutToken", "receiptToken", "statusToken", "orderId", "paymentMethod", "totalAmount", "message"]) {
      expect(body.data).toHaveProperty(field);
    }
    const [, input] = mocks.createStorefrontOrder.mock.calls[0]!;
    expect(input).toMatchObject({ shippingAddress: "123 Queue Street, Mirpur", city: "city_1", zone: "zone_1" });
    expect((input as { items: Array<Record<string, unknown>> }).items[0]!.properties).toBeUndefined();
  });

  it("quotes the old tax-quote body (address, method, no buyer inputs)", async () => {
    const { app, kv } = createTestApp();
    const response = await app.request("/api/v1/orders/tax-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ cartKey: "line_1", productId: "product_1", variantId: "variant_1", quantity: 1, productName: "Queue Product", variantLabel: null }],
        inventoryPool: "regular",
        city: "city_1",
        zone: "zone_1",
        area: null,
        shippingMethodId: "shipping_1",
        discountCodes: [],
        customerPhone: "+8801712345678",
      }),
    }, { CACHE: kv } as never);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      valid: true,
      quoteFingerprint: expect.any(String),
      shippingMethod: DEFAULT_SHIPPING_METHOD_SNAPSHOT,
      requiresShipping: true,
    });
  });

  it("accepts the new shapes too: buyer inputs, and pickup without an address", async () => {
    const { app, kv } = createTestApp();
    const response = await app.request("/api/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...oldCheckoutBody,
        shippingAddress: undefined,
        city: undefined,
        zone: undefined,
        items: [{ ...oldCheckoutBody.items[0], properties: [{ key: "engraving", value: "Anika" }] }],
      }),
    }, { CACHE: kv } as never);
    expect(response.status, await response.clone().text()).toBe(201);
    const [, input] = mocks.createStorefrontOrder.mock.calls[0]!;
    expect((input as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({
      properties: [{ key: "engraving", value: "Anika" }],
    });
  });
});
