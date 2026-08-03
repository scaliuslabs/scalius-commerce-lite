import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutAttempts, orders } from "@scalius/database/schema";

import { ConflictError, NotFoundError } from "@scalius/core/errors";
import { buildCheckoutStatusTokenFromRequestKey } from "@scalius/core/modules/orders";
import { ValidationError } from "../utils/api-error";
import { errorResponseFromError } from "../utils/api-response";
import {
  getCheckoutStatusKvKey,
  getReceiptTokenKvKey,
} from "../utils/order-receipt-token";

const DEFAULT_STATUS_REQUEST_KEY = `checkout_submit:v1:${"a".repeat(64)}`;
const DEFAULT_STATUS_TOKEN = buildCheckoutStatusTokenFromRequestKey(DEFAULT_STATUS_REQUEST_KEY);

const mocks = vi.hoisted(() => ({
  createStorefrontOrder: vi.fn(),
  loadStorefrontCheckoutAuthority: vi.fn(),
  buildCheckoutAttemptIdentity: vi.fn(),
  resolveExistingCheckoutAttempt: vi.fn(),
  createAtomicCheckoutAttempt: vi.fn(),
  getCoordinatedCheckoutEligibility: vi.fn(),
  prepareCheckoutCommitCommand: vi.fn(),
  submitCheckoutCommitToCoordinator: vi.fn(),
  submitCheckoutIntentToCoordinator: vi.fn(),
  commitStorefrontOrderPayload: vi.fn(),
  runStorefrontOrderPostCommitSideEffects: vi.fn(),
  validateStorefrontCartItems: vi.fn(),
  validateStorefrontDeliveryPreflight: vi.fn(),
  createReceiptOrderSupportRequest: vi.fn(),
  getOrderSupportRequestStatusLabel: vi.fn((status: string) => status),
  getReceiptOrderSupportRequestState: vi.fn(),
  invalidateProductAvailabilityCacheSubjects: vi.fn(),
  rateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => "127.0.0.1"),
  getCustomerBySession: vi.fn(),
  getActivePaymentMethods: vi.fn(),
  getCurrencySettings: vi.fn(),
  calculateStorefrontTaxQuote: vi.fn(),
  isDiscountValid: vi.fn(),
  calculateDiscountAmount: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/orders")>();
  return {
    ...actual,
    CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES: ["cancel_pre_shipment", "return", "refund"],
    buildCheckoutAttemptIdentity: mocks.buildCheckoutAttemptIdentity,
    resolveExistingCheckoutAttempt: mocks.resolveExistingCheckoutAttempt,
    createAtomicCheckoutAttempt: mocks.createAtomicCheckoutAttempt,
    getCoordinatedCheckoutEligibility: mocks.getCoordinatedCheckoutEligibility,
    prepareCheckoutCommitCommand: mocks.prepareCheckoutCommitCommand,
    createReceiptOrderSupportRequest: mocks.createReceiptOrderSupportRequest,
    createStorefrontOrder: mocks.createStorefrontOrder,
    loadStorefrontCheckoutAuthority: mocks.loadStorefrontCheckoutAuthority,
    getOrderSupportRequestStatusLabel: mocks.getOrderSupportRequestStatusLabel,
    getReceiptOrderSupportRequestState: mocks.getReceiptOrderSupportRequestState,
    commitStorefrontOrderPayload: mocks.commitStorefrontOrderPayload,
    runStorefrontOrderPostCommitSideEffects: mocks.runStorefrontOrderPostCommitSideEffects,
    validateStorefrontCartItems: mocks.validateStorefrontCartItems,
    validateStorefrontDeliveryPreflight: mocks.validateStorefrontDeliveryPreflight,
  };
});

vi.mock("../checkout-coordinator", () => ({
  submitCheckoutCommitToCoordinator: mocks.submitCheckoutCommitToCoordinator,
  submitCheckoutIntentToCoordinator: mocks.submitCheckoutIntentToCoordinator,
}));

vi.mock("../utils/cache-invalidation", () => ({
  getOptionalExecutionContext: (c: { executionCtx?: unknown }) => {
    try {
      return c.executionCtx;
    } catch {
      return undefined;
    }
  },
  invalidateProductAvailabilityCacheSubjects: mocks.invalidateProductAvailabilityCacheSubjects,
}));

vi.mock("@scalius/shared/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  getClientIp: mocks.getClientIp,
}));

vi.mock("@scalius/core/modules/customers/customer-auth.service", () => ({
  getCustomerBySession: mocks.getCustomerBySession,
  getSessionCookie: (cookieHeader: string | null) => {
    const match = cookieHeader?.match(/(?:^|;\s*)cs_tok=([^;]+)/);
    return match?.[1] ?? null;
  },
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments/gateway-settings")>()),
  getActivePaymentMethods: mocks.getActivePaymentMethods,
}));

vi.mock("@scalius/core/modules/settings/site-settings.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/settings/site-settings.service")>();
  return {
    ...actual,
    getCurrencySettings: mocks.getCurrencySettings,
  };
});

vi.mock("@scalius/core/modules/tax", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/tax")>();
  return {
    ...actual,
    calculateStorefrontTaxQuote: mocks.calculateStorefrontTaxQuote,
  };
});

vi.mock("@scalius/core/modules/discounts/discounts.eligibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/discounts/discounts.eligibility")>();
  return {
    ...actual,
    isDiscountValid: mocks.isDiscountValid,
    calculateDiscountAmount: mocks.calculateDiscountAmount,
  };
});

import { orderRoutes } from "./orders";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({ allowed: true });
  mocks.getClientIp.mockReturnValue("127.0.0.1");
  mocks.getCustomerBySession.mockResolvedValue(null);
  mocks.getActivePaymentMethods.mockResolvedValue({
    enabledMethods: ["cod"],
    defaultMethod: "cod",
  });
  mocks.getCurrencySettings.mockResolvedValue({
    currencyCode: "BDT",
    currencySymbol: "৳",
    usdExchangeRate: "1",
  });
  mocks.calculateStorefrontTaxQuote.mockResolvedValue(DEFAULT_TAX_QUOTE);
  mocks.isDiscountValid.mockResolvedValue({ valid: false });
  mocks.calculateDiscountAmount.mockResolvedValue(0);
  mocks.createStorefrontOrder.mockResolvedValue({
    checkoutToken: "chk_order_1",
    orderId: "order_1",
    paymentMethod: "cod",
    totalAmount: 100,
    taxQuote: DEFAULT_TAX_QUOTE,
    commitPayload: { orderData: { id: "order_1" } },
  });
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
  mocks.getCoordinatedCheckoutEligibility.mockReturnValue({
    eligible: false,
    reason: "unsupported_test_payload",
  });
  mocks.prepareCheckoutCommitCommand.mockResolvedValue({
    schemaVersion: 1,
    requestKey: "checkout_submit:v1:test",
  });
  mocks.submitCheckoutCommitToCoordinator.mockResolvedValue({
    ok: true,
    replay: false,
    orderId: "order_1",
    response: null,
    availabilityChangedSubjects: [],
  });
  mocks.submitCheckoutIntentToCoordinator.mockResolvedValue({
    ok: false,
    code: "CHECKOUT_COMMIT_UNAVAILABLE",
  });
  mocks.commitStorefrontOrderPayload.mockResolvedValue({
    availabilityChangedSubjects: [],
  });
  mocks.runStorefrontOrderPostCommitSideEffects.mockResolvedValue(undefined);
  mocks.invalidateProductAvailabilityCacheSubjects.mockResolvedValue(undefined);
  mocks.validateStorefrontCartItems.mockResolvedValue({
    valid: true,
    issues: [],
    items: [],
    subtotal: 0,
    hasFreeDeliveryProduct: false,
  });
  mocks.validateStorefrontDeliveryPreflight.mockResolvedValue({
    shippingCharge: 60,
    cityName: "Dhaka",
    zoneName: "Mirpur",
    areaName: null,
  });
});

const validOrderBody = {
  checkoutRequestId: "checkout_req_123456",
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
  discountAmount: null,
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
      currency,
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
    await next();
  });
  app.route("/orders", orderRoutes);

  return { app, db, kv, calls };
}

function createStatusTestApp(options: {
  kvStatus?: Record<string, unknown> | null;
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
  const kv = {
    get: vi.fn(async (key: string): Promise<string | null> => {
      if (key !== await getCheckoutStatusKvKey(statusToken)) return null;
      return options.kvStatus ? JSON.stringify(options.kvStatus) : null;
    }),
    put: vi.fn(async (_key: string, _value: string, _options?: { expirationTtl: number }) => undefined),
  };
  const db = {
    select: vi.fn(() => {
      let selectedTable: unknown;
      const query = {
        from: vi.fn((table: unknown) => {
          selectedTable = table;
          return query;
        }),
        where: vi.fn(() => query),
        get: vi.fn(async () => {
          if (selectedTable === checkoutAttempts) {
            return options.attempt
              ? { requestKey: DEFAULT_STATUS_REQUEST_KEY, ...options.attempt }
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

  return { app, db, kv, statusToken };
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
        usdExchangeRate: "1",
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
        {
          inventoryPool: "regular",
          currencyCode,
        },
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
      subtotal: 0,
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
        currencyCode: "BDT",
      },
      expect.objectContaining({ valid: true }),
    );
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("surfaces stale delivery choices from cart validation without creating checkout side effects", async () => {
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
        unitPrice: 100,
        productName: "Authoritative product",
        variantLabel: "Large",
        freeDelivery: false,
        availableQuantity: 4,
        taxClassId: "taxc_standard",
      }],
      subtotal: 100,
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
      items: [{
        unitPrice: 100,
        productName: "Authoritative product",
        variantLabel: "Large",
      }],
    });
    expect(payload.data.quoteFingerprint).toMatch(/^taxq_[A-Za-z0-9_-]{22}$/);
    const validatedRequestItem = mocks.validateStorefrontCartItems.mock.calls[0]?.[1]?.[0];
    expect(validatedRequestItem).not.toHaveProperty("price");
    expect(mocks.calculateStorefrontTaxQuote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lines: [expect.objectContaining({
          unitPrice: 100,
          taxClassId: "taxc_standard",
        })],
        shippingAmount: 60,
      }),
    );
  });

  it.each([
    {
      currencyCode: "JPY",
      decimalPlaces: 0,
      unitPrice: 100,
      subtotal: 200,
      subtotalMinor: 200,
      shippingMinor: 60,
      totalMinor: 260,
    },
    {
      currencyCode: "KWD",
      decimalPlaces: 3,
      unitPrice: 1.235,
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
      subtotal,
      subtotalMinor,
      shippingMinor,
      totalMinor,
    }) => {
      mocks.getCurrencySettings.mockResolvedValue({
        currencyCode,
        currencySymbol: currencyCode === "JPY" ? "¥" : "د.ك",
        usdExchangeRate: "1",
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
          unitPrice,
          productName: "Currency product",
          variantLabel: null,
          freeDelivery: false,
          inventoryTracked: true,
          availableQuantity: 4,
          taxClassId: null,
        }],
        subtotal,
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
        { inventoryPool: "regular", currencyCode },
      );
      expect(mocks.calculateStorefrontTaxQuote).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          lines: [expect.objectContaining({ unitPrice, quantity: 2 })],
          currency: { code: currencyCode, decimalPlaces },
        }),
      );
    },
  );

  it("passes validated product discount scope to the shared quote service", async () => {
    mocks.validateStorefrontCartItems.mockResolvedValue({
      valid: true,
      issues: [],
      items: [{
        index: 0,
        cartKey: "line_1",
        productId: "product_1",
        variantId: "variant_1",
        quantity: 1,
        unitPrice: 100,
        productName: "Product",
        variantLabel: null,
        freeDelivery: false,
        inventoryTracked: true,
        availableQuantity: 2,
        taxClassId: "taxc_1",
      }],
      subtotal: 100,
      hasFreeDeliveryProduct: false,
    });
    mocks.isDiscountValid.mockResolvedValue({
      valid: true,
      discount: {
        id: "discount_1",
        type: "amount_off_products",
        valueType: "fixed_amount",
        discountValue: 50,
      },
      applicableProductIds: new Set(["product_1"]),
      hasProductRestrictions: true,
    });
    mocks.calculateDiscountAmount.mockResolvedValue(50);
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders/tax-quote",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ productId: "product_1", variantId: "variant_1", quantity: 1 }],
          city: "city_1",
          zone: "zone_1",
          shippingMethodId: "shipping_1",
          discountCode: "PRODUCT50",
          customerPhone: "+8801712345678",
        }),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.calculateStorefrontTaxQuote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        discountAmount: 50,
        discountType: "amount_off_products",
        applicableProductIds: ["product_1"],
      }),
    );
    expect(mocks.isDiscountValid).toHaveBeenCalledWith(
      expect.anything(),
      "PRODUCT50",
      100,
      expect.any(Array),
      "+8801712345678",
      "",
      "BDT",
    );
    expect(mocks.calculateDiscountAmount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Number),
      expect.any(Array),
      60,
      new Set(["product_1"]),
      "BDT",
      true,
    );
  });
});

describe("checkout status recovery hints", () => {
  it("rejects receipt proof in the status URL before KV or D1 reads", async () => {
    const { app, db, kv } = createStatusTestApp({
      attempt: {
        status: "committed",
        orderId: "order_1",
        checkoutToken: "chk_status",
      },
    });

    const response = await app.request(
      "/api/v1/orders/status/chk_status",
      {},
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Invalid checkout status token",
      },
    });
    expect(kv.get).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("repairs checkout status and receipt KV after a committed D1 fallback", async () => {
    const { app, kv, statusToken } = createStatusTestApp({
      attempt: {
        status: "committed",
        orderId: "order_1",
        checkoutToken: "chk_status",
      },
    });
    const executionCtx = createWaitUntilContext();

    const response = await app.request(
      `/api/v1/orders/status/${statusToken}`,
      {},
      { CACHE: kv } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    const json = await response.json() as { data: Record<string, unknown> };
    expect(json).toMatchObject({
      success: true,
      data: {
        status: "completed",
        orderId: "order_1",
      },
    });
    expect(json.data).not.toHaveProperty("receiptToken");
    expect(JSON.stringify(json)).not.toContain("chk_status");
    expect(JSON.stringify(json)).not.toContain("chk_");
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    const statusKey = await getCheckoutStatusKvKey(statusToken);
    const receiptKey = await getReceiptTokenKvKey("chk_status");
    const statusWrite = kv.put.mock.calls.find(([key]) => key === statusKey);
    const receiptWrite = kv.put.mock.calls.find(([key]) => key === receiptKey);
    expect(statusKey).not.toContain("chk_status");
    expect(statusKey).not.toContain(statusToken);
    expect(JSON.parse(String(statusWrite?.[1]))).toMatchObject({
      status: "completed",
      orderId: "order_1",
    });
    expect(JSON.parse(String(statusWrite?.[1]))).not.toHaveProperty("receiptToken");
    expect(String(statusWrite?.[1])).not.toContain("chk_status");
    expect(String(statusWrite?.[1])).not.toContain("chk_");
    expect(statusWrite?.[2]).toEqual({ expirationTtl: 86400 });
    expect(receiptKey).not.toContain("chk_status");
    expect(JSON.parse(String(receiptWrite?.[1]))).toEqual({ orderId: "order_1" });
    expect(receiptWrite?.[2]).toEqual({ expirationTtl: 60 * 60 * 24 * 7 });
  });

  it("repairs success hints when a processing D1 attempt already has an order", async () => {
    const { app, kv, statusToken } = createStatusTestApp({
      attempt: {
        status: "processing",
        orderId: "order_1",
        checkoutToken: "chk_status",
      },
      orderExists: true,
    });
    const executionCtx = createWaitUntilContext();

    const response = await app.request(
      `/api/v1/orders/status/${statusToken}`,
      {},
      { CACHE: kv } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    const json = await response.json() as { data: Record<string, unknown> };
    expect(json).toMatchObject({
      success: true,
      data: {
        status: "completed",
        orderId: "order_1",
      },
    });
    expect(json.data).not.toHaveProperty("receiptToken");
    expect(JSON.stringify(json)).not.toContain("chk_status");
    expect(JSON.stringify(json)).not.toContain("chk_");
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    const statusKey = await getCheckoutStatusKvKey(statusToken);
    const receiptKey = await getReceiptTokenKvKey("chk_status");
    expect(statusKey).not.toContain("chk_status");
    expect(statusKey).not.toContain(statusToken);
    expect(kv.put.mock.calls.map(([key]) => key)).toEqual(expect.arrayContaining([
      statusKey,
      receiptKey,
    ]));
  });

  it("repairs stale processing KV when the order is already committed", async () => {
    const { app, kv, statusToken } = createStatusTestApp({
      kvStatus: {
        status: "processing",
        orderId: "order_1",
        updatedAt: Date.now() - 60_000,
      },
      attempt: {
        status: "processing",
        orderId: "order_1",
        checkoutToken: "chk_status",
      },
      orderExists: true,
    });
    const executionCtx = createWaitUntilContext();

    const response = await app.request(
      `/api/v1/orders/status/${statusToken}`,
      {},
      { CACHE: kv } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    const json = await response.json() as { data: Record<string, unknown> };
    expect(json).toMatchObject({
      success: true,
      data: {
        status: "completed",
        orderId: "order_1",
      },
    });
    expect(json.data).not.toHaveProperty("receiptToken");
    expect(JSON.stringify(json)).not.toContain("chk_status");
    expect(JSON.stringify(json)).not.toContain("chk_");
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    const statusKey = await getCheckoutStatusKvKey(statusToken);
    const statusWrite = kv.put.mock.calls.find(([key]) => key === statusKey);
    expect(statusKey).not.toContain("chk_status");
    expect(statusKey).not.toContain(statusToken);
    expect(JSON.parse(String(statusWrite?.[1]))).toMatchObject({
      status: "completed",
      orderId: "order_1",
    });
    expect(JSON.parse(String(statusWrite?.[1]))).not.toHaveProperty("receiptToken");
    expect(String(statusWrite?.[1])).not.toContain("chk_status");
    expect(String(statusWrite?.[1])).not.toContain("chk_");
  });

  it("does not leak receipt proof from legacy checkout status KV rows", async () => {
    const { app, kv, statusToken } = createStatusTestApp({
      kvStatus: {
        status: "completed",
        orderId: "order_1",
        receiptToken: "chk_legacy_status",
        checkoutToken: "chk_legacy_checkout",
        updatedAt: Date.now() - 60_000,
      },
    });

    const response = await app.request(
      `/api/v1/orders/status/${statusToken}`,
      {},
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(200);
    const json = await response.json() as { data: Record<string, unknown> };
    expect(json).toMatchObject({
      success: true,
      data: {
        status: "completed",
        orderId: "order_1",
      },
    });
    expect(json.data).not.toHaveProperty("receiptToken");
    expect(json.data).not.toHaveProperty("checkoutToken");
    expect(JSON.stringify(json)).not.toContain("chk_");
  });

  it("repairs failed checkout status after a failed D1 fallback", async () => {
    const { app, kv, statusToken } = createStatusTestApp({
      attempt: {
        status: "failed",
        orderId: "order_1",
        checkoutToken: "chk_status",
        lastError: "Discount code has reached its usage limit",
      },
    });
    const executionCtx = createWaitUntilContext();

    const response = await app.request(
      `/api/v1/orders/status/${statusToken}`,
      {},
      { CACHE: kv } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        status: "failed",
        orderId: "order_1",
        error: "Discount code has reached its usage limit",
      },
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    const statusKey = await getCheckoutStatusKvKey(statusToken);
    const statusWrite = kv.put.mock.calls.find(([key]) => key === statusKey);
    expect(statusKey).not.toContain("chk_status");
    expect(statusKey).not.toContain(statusToken);
    expect(JSON.parse(String(statusWrite?.[1]))).toMatchObject({
      status: "failed",
      orderId: "order_1",
      error: "Discount code has reached its usage limit",
    });
    expect(kv.put.mock.calls.some(([key]) => String(key).startsWith("order_receipt:"))).toBe(false);
  });
});

describe("create order currency parity", () => {
  it.each([
    { currencyCode: "JPY", decimalPlaces: 0, unitPrice: 100, subtotal: 200, totalMinor: 260 },
    { currencyCode: "KWD", decimalPlaces: 3, unitPrice: 1.235, subtotal: 2.47, totalMinor: 62_470 },
  ])(
    "keeps $currencyCode cart authority through order creation",
    async ({ currencyCode, decimalPlaces, unitPrice, subtotal, totalMinor }) => {
      const cartValidation = {
        valid: true,
        issues: [],
        items: [{
          index: 0,
          cartKey: null,
          productId: "product_1",
          variantId: "variant_1",
          quantity: 2,
          unitPrice,
          productName: "Currency product",
          variantLabel: null,
          freeDelivery: false,
          inventoryTracked: true,
          availableQuantity: 4,
          taxClassId: null,
        }],
        subtotal,
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
        usdExchangeRate: "1",
      });
      mocks.validateStorefrontCartItems.mockResolvedValue(cartValidation);
      mocks.createStorefrontOrder.mockResolvedValue({
        checkoutToken: `chk_${currencyCode.toLowerCase()}`,
        orderId: `order_${currencyCode.toLowerCase()}`,
        paymentMethod: "cod",
        totalAmount: subtotal + 60,
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
        expect.objectContaining({ currencyCode }),
        cartValidation,
      );
      expect(mocks.createStorefrontOrder.mock.calls[0]?.[6]).toBe(cartValidation);
    },
  );
});

describe("create order commit/KV ordering", () => {
  it("invalidates a coordinated sold-out transition when projection owns side effects", async () => {
    const commitPayload = { orderData: { id: "order_1" }, marker: "coordinated" };
    const coordinatedResponse = {
      checkoutToken: "chk_order_1",
      receiptToken: "chk_order_1",
      statusToken: DEFAULT_STATUS_TOKEN,
      orderId: "order_1",
      paymentMethod: "cod",
      totalAmount: 100,
      totalAmountMinor: 10_000,
      taxAmount: 0,
      taxAmountMinor: 0,
      taxLabel: "Tax",
      pricesIncludeTax: false,
      currencyCode: "BDT",
      decimalPlaces: 2,
      message: "Order created",
    };
    const availabilityChangedSubjects = [{
      productId: "product_1",
      slug: "queue-product",
      categoryId: "category_1",
    }];
    const coordinatorBinding = {} as DurableObjectNamespace;

    mocks.createStorefrontOrder.mockResolvedValue({
      checkoutToken: "chk_order_1",
      orderId: "order_1",
      paymentMethod: "cod",
      totalAmount: 100,
      taxQuote: DEFAULT_TAX_QUOTE,
      commitPayload,
    });
    mocks.submitCheckoutIntentToCoordinator.mockResolvedValue({
      ok: true,
      replay: false,
      orderId: "order_1",
      response: coordinatedResponse,
      availabilityChangedSubjects,
      postCommitPayload: null,
    });

    const { app, kv } = createTestApp();
    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv, CHECKOUT_COORDINATOR: coordinatorBinding } as never,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      data: coordinatedResponse,
    });
    expect(mocks.submitCheckoutIntentToCoordinator).toHaveBeenCalledWith(
      coordinatorBinding,
      "d1",
      expect.objectContaining({
        attempt: expect.objectContaining({ orderId: "order_1" }),
        data: expect.objectContaining({ paymentMethod: "cod" }),
      }),
    );
    expect(mocks.submitCheckoutCommitToCoordinator).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCacheSubjects).toHaveBeenCalledWith(
      availabilityChangedSubjects,
      expect.anything(),
      expect.anything(),
    );
  });

  it("commits the order before scheduling checkout recovery hints and side effects", async () => {
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
      return {
        availabilityChangedSubjects: [{
          productId: "product_1",
          slug: "queue-product",
          categoryId: "category_1",
        }],
      };
    });
    mocks.runStorefrontOrderPostCommitSideEffects.mockImplementation(async () => {
      calls.push("side-effects");
    });
    mocks.invalidateProductAvailabilityCacheSubjects.mockImplementation(async () => {
      calls.push("availability");
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
      expect(executionCtx.waitUntil).toHaveBeenCalledTimes(2);
      await Promise.all(waitUntilPromises);

      const statusKey = await getCheckoutStatusKvKey(DEFAULT_STATUS_TOKEN);
      const receiptKey = await getReceiptTokenKvKey("chk_order_1");
      const kvKeys = kv.put.mock.calls.map(([key]) => String(key));
      const statusWrite = kv.put.mock.calls.find(([key]) => key === statusKey) as [string, string, unknown?] | undefined;
      const receiptWrite = kv.put.mock.calls.find(([key]) => key === receiptKey) as [string, string, unknown?] | undefined;
      expect(calls[0]).toBe("commit");
      expect(calls).toContain(`kv:${statusKey}`);
      expect(calls).toContain(`kv:${receiptKey}`);
      expect(calls).toContain("side-effects");
      expect(calls).toContain("availability");
      expect(kvKeys).toEqual(expect.arrayContaining([statusKey, receiptKey]));
      expect(statusKey).not.toContain("chk_order_1");
      expect(statusKey).not.toContain(DEFAULT_STATUS_TOKEN);
      expect(receiptKey).not.toContain("chk_order_1");
      expect(JSON.stringify(kvKeys)).not.toContain("chk_order_1");
      expect(String(statusWrite?.[1])).not.toContain("chk_order_1");
      expect(String(statusWrite?.[1])).not.toContain("chk_");
      expect(JSON.parse(String(statusWrite?.[1]))).not.toHaveProperty("receiptToken");
      expect(String(receiptWrite?.[1])).not.toContain("chk_order_1");
      expect(String(receiptWrite?.[1])).not.toContain("chk_");
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
      );
      expect(mocks.createStorefrontOrder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ checkoutRequestId: "checkout_req_123456" }),
        expect.any(String),
        expect.any(Function),
        expect.any(Function),
        {
          orderId: "order_1",
          checkoutToken: "chk_order_1",
        },
        expect.objectContaining({ valid: true }),
        expect.objectContaining({
          shippingCharge: 60,
          cityName: "Dhaka",
          zoneName: "Mirpur",
        }),
        undefined,
        { code: "BDT", decimalPlaces: 2 },
        undefined,
        expect.objectContaining({ partialPaymentEnabled: false }),
        expect.objectContaining({ classes: [], rates: [] }),
      );
      expect(mocks.invalidateProductAvailabilityCacheSubjects).toHaveBeenCalledWith(
        [{
          productId: "product_1",
          slug: "queue-product",
          categoryId: "category_1",
        }],
        expect.objectContaining({
          env: expect.objectContaining({ CACHE: kv }),
          executionCtx,
        }),
        expect.anything(),
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
    mocks.rateLimit.mockResolvedValue({ allowed: false });
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
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
    mocks.rateLimit.mockResolvedValue({ allowed: false });
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
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
    mocks.rateLimit.mockResolvedValue({ allowed: false });
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
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
      subtotal: 0,
      hasFreeDeliveryProduct: false,
    });
    mocks.rateLimit.mockResolvedValue({ allowed: false });
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects stale delivery choices before policy, rate limiting, or atomic attempt creation", async () => {
    mocks.validateStorefrontDeliveryPreflight.mockRejectedValue(
      new ValidationError("Selected zone is no longer available for the chosen city."),
    );
    mocks.rateLimit.mockResolvedValue({ allowed: false });
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("keeps a committed order successful when product availability cache invalidation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      mocks.createStorefrontOrder.mockResolvedValue({
        checkoutToken: "chk_order_cache_failure",
        orderId: "order_cache_failure",
        paymentMethod: "cod",
        totalAmount: 100,
        taxQuote: DEFAULT_TAX_QUOTE,
        commitPayload: { orderData: { id: "order_cache_failure" } },
      });
      mocks.commitStorefrontOrderPayload.mockResolvedValue({
        availabilityChangedSubjects: [{
          productId: "product_cache_failure",
          slug: "cache-failure",
          categoryId: null,
        }],
      });
      mocks.invalidateProductAvailabilityCacheSubjects.mockRejectedValue(new Error("cache unavailable"));
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
      expect(mocks.invalidateProductAvailabilityCacheSubjects).toHaveBeenCalledWith(
        [{
          productId: "product_cache_failure",
          slug: "cache-failure",
          categoryId: null,
        }],
        expect.any(Object),
        expect.anything(),
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[Orders] Failed to invalidate product availability caches after order commit:",
        expect.objectContaining({ productCount: 1 }),
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
    const statusKey = await getCheckoutStatusKvKey(DEFAULT_STATUS_TOKEN);
    await vi.waitFor(() => {
      expect(calls).toEqual([
        "commit",
        `kv:${statusKey}`,
      ]);
    });
    expect(statusKey).not.toContain("chk_order_2");
    expect(mocks.runStorefrontOrderPostCommitSideEffects).not.toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCacheSubjects).not.toHaveBeenCalled();
    const failedStatusWrite = kv.put.mock.calls.at(-1) as [string, string] | undefined;
    expect(failedStatusWrite?.[0]).toBe(statusKey);
    expect(JSON.parse(String(failedStatusWrite?.[1]))).toMatchObject({
      status: "failed",
      orderId: "order_2",
    });
  });

  it("surfaces discount commit validation failures in checkout status and response body", async () => {
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
    expect(mocks.invalidateProductAvailabilityCacheSubjects).not.toHaveBeenCalled();
    const statusKey = await getCheckoutStatusKvKey(DEFAULT_STATUS_TOKEN);
    await vi.waitFor(() => {
      expect(kv.put).toHaveBeenCalled();
    });
    const failedStatusWrite = kv.put.mock.calls.at(-1) as [string, string] | undefined;
    expect(failedStatusWrite?.[0]).toBe(statusKey);
    expect(statusKey).not.toContain("chk_order_discount_limit");
    expect(JSON.parse(String(failedStatusWrite?.[1]))).toMatchObject({
      status: "failed",
      orderId: "order_discount_limit",
      error: "Discount code has reached its usage limit",
    });
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
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

  it("rejects signed-in checkout with a mismatched phone even when guest checkout is enabled", async () => {
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

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "Checkout phone must match the signed-in customer phone.",
      },
    });
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(db, "session_guest_enabled_mismatch", undefined);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects stale customer sessions with a recoverable code when guest checkout is enabled", async () => {
    mocks.getCustomerBySession.mockResolvedValue(null);
    const { app, db, kv } = createTestApp({ guestCheckoutEnabled: true });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Customer-Session": "expired_session",
        },
        body: JSON.stringify(validOrderBody),
      },
      { CACHE: kv } as never,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: "CUSTOMER_SESSION_STALE",
        message: "Your session expired. Please sign in again or continue as a guest.",
      },
    });
    expect(mocks.getCustomerBySession).toHaveBeenCalledWith(db, "expired_session", undefined);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
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
      expect.any(Function),
      expect.any(Function),
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
      { code: "BDT", decimalPlaces: 2 },
      undefined,
      expect.objectContaining({ partialPaymentEnabled: false }),
      expect.objectContaining({ classes: [], rates: [] }),
    );
    expect(mocks.commitStorefrontOrderPayload).toHaveBeenCalledOnce();
  });

  it("rejects authenticated checkout if the forwarded session phone differs from order phone", async () => {
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

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
  });

  it("rejects authenticated checkout if the customer session has no phone proof", async () => {
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

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
  });

  it("fails closed for SSLCommerz before attempt creation when only JWT fallback could read credentials", async () => {
    mocks.getActivePaymentMethods.mockImplementation(async (_db, _kv, encryptionKey?: string) => ({
      enabledMethods: encryptionKey === "jwt-fallback" ? ["sslcommerz"] : [],
      defaultMethod: encryptionKey === "jwt-fallback" ? "sslcommerz" : "cod",
    }));
    const { app, db, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "sslcommerz" }),
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects SSLCommerz when the authoritative store currency is not BDT", async () => {
    mocks.getCurrencySettings.mockResolvedValue({
      currencyCode: "KWD",
      currencySymbol: "د.ك",
      usdExchangeRate: "1",
    });
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["sslcommerz"],
      defaultMethod: "sslcommerz",
    });
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "sslcommerz" }),
      },
      { CACHE: kv, CREDENTIAL_ENCRYPTION_KEY: "credential-key" } as never,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        message: "SSLCommerz checkout requires the store currency to be BDT.",
      },
    });
    expect(mocks.calculateStorefrontTaxQuote).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).not.toHaveBeenCalled();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it.each([
    ["below", 9.99],
    ["above", 500000.01],
  ])("rejects SSLCommerz full-payment amounts %s provider bounds before checkout writes", async (_label, subtotal) => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["sslcommerz"],
      defaultMethod: "sslcommerz",
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
      paymentMethod: "sslcommerz",
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
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "sslcommerz" }),
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects SSLCommerz deposit amounts outside provider bounds before checkout writes", async () => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["sslcommerz"],
      defaultMethod: "sslcommerz",
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
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: null,
    });
    mocks.calculateStorefrontTaxQuote.mockResolvedValue(DEFAULT_TAX_QUOTE);
    const { app, kv } = createTestApp({
      partialPaymentEnabled: true,
      partialPaymentAmount: 9.99,
    });

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "sslcommerz" }),
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("uses the recomputed committed quote after SSLCommerz precommit validation", async () => {
    mocks.getActivePaymentMethods.mockResolvedValue({
      enabledMethods: ["sslcommerz"],
      defaultMethod: "sslcommerz",
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
      paymentMethod: "sslcommerz",
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
        body: JSON.stringify({ ...validOrderBody, paymentMethod: "sslcommerz" }),
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
    );
  });

  it("uses native on-machine checkout limiters without touching KV counters", async () => {
    const ipLimiter = { limit: vi.fn(async () => ({ success: true })) };
    const phoneLimiter = { limit: vi.fn(async () => ({ success: true })) };
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
        ORDER_IP_RATE_LIMITER: ipLimiter,
        ORDER_PHONE_RATE_LIMITER: phoneLimiter,
        PUBLIC_API_BASE_URL: "https://merchant-api.example",
      } as never,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(ipLimiter.limit).toHaveBeenCalledWith({
      key: expect.stringMatching(/^checkout:ip:[a-f0-9]{64}$/),
    });
    expect(phoneLimiter.limit).toHaveBeenCalledWith({
      key: expect.stringMatching(/^checkout:phone:[a-f0-9]{64}$/),
    });
    expect(JSON.stringify([
      ipLimiter.limit.mock.calls,
      phoneLimiter.limit.mock.calls,
    ])).not.toContain(validOrderBody.customerPhone);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("rejects a checkout denied by a native limiter before order writes", async () => {
    const ipLimiter = { limit: vi.fn(async () => ({ success: true })) };
    const phoneLimiter = { limit: vi.fn(async () => ({ success: false })) };
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
        ORDER_IP_RATE_LIMITER: ipLimiter,
        ORDER_PHONE_RATE_LIMITER: phoneLimiter,
      } as never,
    );

    expect(response.status).toBe(429);
    expect(mocks.createAtomicCheckoutAttempt).toHaveBeenCalledOnce();
    expect(mocks.createStorefrontOrder).toHaveBeenCalledOnce();
    expect(mocks.commitStorefrontOrderPayload).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("rate limits a new checkout after pure preparation but before order writes", async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false });
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
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
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
    expect(mocks.rateLimit).not.toHaveBeenCalled();
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

  it("rejects multiple discount codes at the checkout schema boundary", async () => {
    const { app, kv } = createTestApp();

    const response = await app.request(
      "/api/v1/orders",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...validOrderBody,
          discountCode: ["SAVE10", "DELIVERY"],
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
