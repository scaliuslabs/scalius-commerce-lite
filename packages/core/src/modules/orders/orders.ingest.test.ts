import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import type { StorefrontOrderCommitPayload } from "./orders.types";

const mocks = vi.hoisted(() => ({
  safeBatch: vi.fn(),
  reserveStockBatch: vi.fn(),
  releaseReservedStockBatch: vi.fn(),
}));

vi.mock("@scalius/database/client", async (importOriginal) => ({
  ...(await importOriginal()),
  safeBatch: mocks.safeBatch,
}));

vi.mock("../inventory", () => ({
  reserveStockBatch: mocks.reserveStockBatch,
  releaseReservedStockBatch: mocks.releaseReservedStockBatch,
}));

import { commitStorefrontOrderPayload } from "./orders.ingest";

function createPayload(overrides: Partial<StorefrontOrderCommitPayload> = {}): StorefrontOrderCommitPayload {
  return {
    checkoutToken: "chk_order_discount",
    existingCustomer: { id: "cust_existing" },
    orderData: {
      id: "order_discount",
      customerName: "Discount Buyer",
      customerPhone: "+8801712345678",
      customerEmail: "buyer@example.com",
      shippingAddress: "123 Discount Road",
      city: "city_1",
      zone: "zone_1",
      area: null,
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: null,
      notes: null,
      totalAmount: 200,
      shippingCharge: 60,
      discountAmount: 50,
      currencyCode: "BDT",
      currencyDecimalPlaces: 2,
      subtotalAmountMinor: 20_000,
      shippingAmountMinor: 6_000,
      discountAmountMinor: 5_000,
      taxAmountMinor: 0,
      totalAmountMinor: 20_000,
      taxLabel: "Tax",
      pricesIncludeTax: false,
      status: "incomplete",
      paymentMethod: "stripe",
      paymentStatus: "unpaid",
      paidAmount: 0,
      balanceDue: 200,
      fulfillmentStatus: "pending",
      inventoryPool: "regular",
      inventoryAction: "reserved",
    },
    items: [
      {
        id: "item_1",
        taxAllocationLineId: "cart:0:variant_1",
        cartKey: "line_1",
        productId: "prod_1",
        variantId: "variant_1",
        quantity: 2,
        price: 100,
        productName: "Discounted Product",
        variantLabel: null,
        productImageMediaId: "med_order_snapshot",
        unitPriceMinor: 10_000,
        lineSubtotalMinor: 20_000,
        discountAmountMinor: 5_000,
        taxableAmountMinor: 0,
        taxAmountMinor: 0,
      },
    ],
    discountUsage: { discountId: "discount_1", amountDiscounted: 50 },
    requestUrl: "https://shop.example.com/api/v1/orders",
    taxQuote: {
      schemaVersion: 1,
      calculationVersion: "tax-v1",
      enabled: false,
      currencyCode: "BDT",
      decimalPlaces: 2,
      displayLabel: "Tax",
      pricesIncludeTax: false,
      shippingTaxed: false,
      settingsVersion: 0,
      subtotalMinor: 20_000,
      shippingMinor: 6_000,
      discountMinor: 5_000,
      taxableMinor: 0,
      taxMinor: 0,
      totalMinor: 20_000,
      destination: { city: "city_1", zone: "zone_1", area: null },
      lines: [{
        lineId: "cart:0:variant_1",
        productId: "prod_1",
        variantId: "variant_1",
        taxClassId: null,
        taxClassName: null,
        unitPriceMinor: 10_000,
        quantity: 2,
        grossAmountMinor: 20_000,
        discountMinor: 5_000,
        taxableAmountMinor: 0,
        taxMinor: 0,
        totalMinor: 15_000,
        components: [],
      }],
      shipping: {
        taxClassId: null,
        taxClassName: null,
        grossAmountMinor: 6_000,
        discountMinor: 0,
        taxableAmountMinor: 0,
        taxMinor: 0,
        totalMinor: 6_000,
        components: [],
      },
    },
    ...overrides,
  };
}

function createDbMock(options: {
  activeCustomer?: { id: string } | null;
} = {}): Database & {
  insertValues: unknown[];
  conflictIgnoredInserts: unknown[];
} {
  const insertValues: unknown[] = [];
  const conflictIgnoredInserts: unknown[] = [];
  const createReadQuery = (projection: Record<string, unknown>) => ({
    where: vi.fn(() => ({
      get: vi.fn(async () => {
        if ("customerId" in projection) return undefined;
        if ("maxUses" in projection) return { maxUses: null, limitOnePerCustomer: false };
        if ("id" in projection) return options.activeCustomer === undefined ? { id: "cust_existing" } : options.activeCustomer;
        return undefined;
      }),
      limit: vi.fn(() => ({
        get: vi.fn(async () => undefined),
      })),
    })),
    leftJoin: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => ({
          get: vi.fn(async () => undefined),
        })),
      })),
    })),
  });

  return {
    select: vi.fn((projection: Record<string, unknown>) => ({
      from: vi.fn(() => createReadQuery(projection)),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ kind: "update" })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        insertValues.push(values);
        return {
          kind: "insert",
          onConflictDoNothing: vi.fn(() => {
            conflictIgnoredInserts.push(values);
            return { kind: "insert-on-conflict" };
          }),
        };
      }),
    })),
    insertValues,
    conflictIgnoredInserts,
  } as unknown as Database & {
    insertValues: unknown[];
    conflictIgnoredInserts: unknown[];
  };
}

describe("commitStorefrontOrderPayload discount trigger failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });
    mocks.releaseReservedStockBatch.mockResolvedValue({ success: true, results: [] });
  });

  it("maps max-uses trigger aborts to a checkout validation error and releases reserved stock", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockRejectedValue(new Error("D1_ERROR: DISCOUNT_MAX_USES_EXCEEDED"));

    const result = commitStorefrontOrderPayload(db, createPayload());
    await expect(result).rejects.toBeInstanceOf(ValidationError);
    await expect(result).rejects.toMatchObject({
      name: "ValidationError",
      message: "Discount code has reached its usage limit",
    });
    expect(mocks.releaseReservedStockBatch).toHaveBeenCalledWith(
      db,
      [{ variantId: "variant_1", quantity: 2, pool: "regular", orderId: "order_discount" }],
      "order_discount",
      { releaseKey: "checkout-rollback:v1" },
    );
  });

  it("commits true guest checkout without attaching the order to a customer account", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockResolvedValue([]);

    const result = await commitStorefrontOrderPayload(
      db,
      createPayload({
        existingCustomer: null,
        discountUsage: null,
        orderData: {
          ...createPayload().orderData,
          inventoryAction: "none",
        },
      }),
    );

    expect(result.customerId).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
    expect(mocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(mocks.safeBatch).toHaveBeenCalledOnce();
  });

  it("includes a durable Meta Purchase outbox claim in the order batch for final-at-create COD orders", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockResolvedValue([]);

    await commitStorefrontOrderPayload(
      db,
      createPayload({
        discountUsage: null,
        orderData: {
          ...createPayload().orderData,
          status: "pending",
          paymentMethod: "cod",
          paymentStatus: "unpaid",
          inventoryAction: "none",
        },
      }),
    );

    expect(db.conflictIgnoredInserts).toContainEqual(expect.objectContaining({
      orderId: "order_discount",
      eventId: "Purchase:order_discount",
      source: "storefront-order",
      status: "pending",
      attempts: 0,
    }));
    expect(JSON.stringify(db.conflictIgnoredInserts)).not.toContain("buyer@example.com");
    expect(JSON.stringify(db.conflictIgnoredInserts)).not.toContain("+8801712345678");
  });

  it("rejects authenticated checkout payloads when the customer account is no longer active", async () => {
    const db = createDbMock({ activeCustomer: null });

    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.toMatchObject({
        name: "ValidationError",
        message: "Customer account is no longer active. Please sign in again.",
      });

    expect(mocks.reserveStockBatch).not.toHaveBeenCalled();
    expect(mocks.safeBatch).not.toHaveBeenCalled();
  });

  it("maps one-per-customer trigger aborts even when D1 nests the cause", async () => {
    const db = createDbMock();
    const cause = new Error("SQLITE_CONSTRAINT_TRIGGER: DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED");
    mocks.safeBatch.mockRejectedValue(Object.assign(new Error("D1 batch failed"), { cause }));

    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.toMatchObject({
        name: "ValidationError",
        message: "Discount already used by this customer",
      });

    expect(mocks.releaseReservedStockBatch).toHaveBeenCalledOnce();
  });

  it("maps missing customer-key trigger aborts to a phone-specific validation error", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockRejectedValue(new Error("D1_ERROR: DISCOUNT_CUSTOMER_KEY_REQUIRED"));

    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.toThrow("A valid phone number is required to use this discount");

    expect(mocks.releaseReservedStockBatch).toHaveBeenCalledOnce();
  });

  it("preserves unrelated commit errors after releasing reserved stock", async () => {
    const db = createDbMock();
    const rawError = new Error("D1 batch unavailable");
    mocks.safeBatch.mockRejectedValue(rawError);

    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.toBe(rawError);

    expect(mocks.releaseReservedStockBatch).toHaveBeenCalledOnce();
  });

  it("fails closed when reserved stock cleanup cannot be proven after a commit error", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockRejectedValue(new Error("D1 batch unavailable"));
    mocks.releaseReservedStockBatch.mockResolvedValue({
      success: false,
      results: [
        {
          success: false,
          variantId: "variant_1",
          previousStock: 0,
          newStock: 0,
          error: "Reservation release batch failed",
        },
      ],
      error: "Reservation release batch failed",
      manualReconciliationRequired: true,
    });

    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.toMatchObject({
        name: "ServiceUnavailableError",
        message: "Checkout inventory cleanup is temporarily unavailable. Please try again.",
      });

    expect(mocks.releaseReservedStockBatch).toHaveBeenCalledOnce();
  });

  it("maps reservation failures to structured cart item issues", async () => {
    const db = createDbMock();
    mocks.reserveStockBatch.mockResolvedValue({
      success: false,
      error: "Insufficient stock for variant variant_1. Available: 0, Requested: 2",
      results: [
        {
          success: false,
          variantId: "variant_1",
          previousStock: 0,
          newStock: 0,
          error: "Insufficient stock for variant variant_1. Available: 0, Requested: 2",
        },
      ],
    });

    const result = commitStorefrontOrderPayload(db, createPayload());
    await expect(result).rejects.toMatchObject({
      name: "ValidationError",
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          {
            cartKey: "line_1",
            code: "QUANTITY_UNAVAILABLE",
            productName: "Discounted Product",
            message: "Discounted Product is no longer available in the requested quantity.",
            requestedQuantity: 2,
          },
        ],
      },
    });
    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.not.toThrow("variant_1");
    expect(mocks.safeBatch).not.toHaveBeenCalled();
  });
});
