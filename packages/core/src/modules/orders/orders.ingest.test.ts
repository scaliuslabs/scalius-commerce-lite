import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import type { OrderIngestQueuePayload } from "./orders.types";

const mocks = vi.hoisted(() => ({
  safeBatch: vi.fn(),
  reserveStockBatch: vi.fn(),
  releaseMultiple: vi.fn(),
}));

vi.mock("@scalius/database/client", async (importOriginal) => ({
  ...(await importOriginal()),
  safeBatch: mocks.safeBatch,
}));

vi.mock("../inventory", () => ({
  reserveStockBatch: mocks.reserveStockBatch,
  releaseMultiple: mocks.releaseMultiple,
}));

import { commitStorefrontOrderPayload } from "./orders.ingest";

function createPayload(overrides: Partial<OrderIngestQueuePayload> = {}): OrderIngestQueuePayload {
  return {
    type: "order.ingest",
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
        productId: "prod_1",
        variantId: "variant_1",
        quantity: 2,
        price: 100,
        productName: "Discounted Product",
        variantLabel: null,
      },
    ],
    discountUsage: { discountId: "discount_1", amountDiscounted: 50 },
    requestUrl: "https://shop.example.com/api/v1/orders",
    ...overrides,
  };
}

function createDbMock(): Database {
  const createReadQuery = (projection: Record<string, unknown>) => ({
    where: vi.fn(() => ({
      get: vi.fn(async () => {
        if ("customerId" in projection) return undefined;
        if ("maxUses" in projection) return { maxUses: null, limitOnePerCustomer: false };
        if ("id" in projection) return { id: "cust_existing" };
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
      values: vi.fn(() => ({ kind: "insert" })),
    })),
  } as unknown as Database;
}

describe("commitStorefrontOrderPayload discount trigger failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reserveStockBatch.mockResolvedValue({ success: true, results: [] });
    mocks.releaseMultiple.mockResolvedValue({ success: true, results: [] });
  });

  it("maps max-uses trigger aborts to a checkout validation error and releases reserved stock", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockRejectedValue(new Error("D1_ERROR: DISCOUNT_MAX_USES_EXCEEDED"));

    const result = commitStorefrontOrderPayload(db, undefined, createPayload());
    await expect(result).rejects.toBeInstanceOf(ValidationError);
    await expect(result).rejects.toMatchObject({
      name: "ValidationError",
      message: "Discount code has reached its usage limit",
    });
    expect(mocks.releaseMultiple).toHaveBeenCalledWith(
      db,
      [{ variantId: "variant_1", quantity: 2, pool: "regular", orderId: "order_discount" }],
      "order_discount",
    );
  });

  it("maps one-per-customer trigger aborts even when D1 nests the cause", async () => {
    const db = createDbMock();
    const cause = new Error("SQLITE_CONSTRAINT_TRIGGER: DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED");
    mocks.safeBatch.mockRejectedValue(Object.assign(new Error("D1 batch failed"), { cause }));

    await expect(commitStorefrontOrderPayload(db, undefined, createPayload()))
      .rejects.toMatchObject({
        name: "ValidationError",
        message: "Discount already used by this customer",
      });

    expect(mocks.releaseMultiple).toHaveBeenCalledOnce();
  });

  it("maps missing customer-key trigger aborts to a phone-specific validation error", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockRejectedValue(new Error("D1_ERROR: DISCOUNT_CUSTOMER_KEY_REQUIRED"));

    await expect(commitStorefrontOrderPayload(db, undefined, createPayload()))
      .rejects.toThrow("A valid phone number is required to use this discount");

    expect(mocks.releaseMultiple).toHaveBeenCalledOnce();
  });

  it("preserves unrelated commit errors after releasing reserved stock", async () => {
    const db = createDbMock();
    const rawError = new Error("D1 batch unavailable");
    mocks.safeBatch.mockRejectedValue(rawError);

    await expect(commitStorefrontOrderPayload(db, undefined, createPayload()))
      .rejects.toBe(rawError);

    expect(mocks.releaseMultiple).toHaveBeenCalledOnce();
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

    const result = commitStorefrontOrderPayload(db, undefined, createPayload());
    await expect(result).rejects.toMatchObject({
      name: "ValidationError",
      message: "Some items in your cart need attention.",
      details: {
        itemIssues: [
          {
            code: "QUANTITY_UNAVAILABLE",
            productName: "Discounted Product",
            message: "Discounted Product is no longer available in the requested quantity.",
            requestedQuantity: 2,
          },
        ],
      },
    });
    await expect(commitStorefrontOrderPayload(db, undefined, createPayload()))
      .rejects.not.toThrow("variant_1");
    expect(mocks.safeBatch).not.toHaveBeenCalled();
  });
});
