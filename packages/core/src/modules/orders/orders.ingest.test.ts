import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import type { StorefrontOrderCommitPayload } from "./orders.types";

const mocks = vi.hoisted(() => ({
  safeBatch: vi.fn(),
  prepareStockReservationBatch: vi.fn(),
  isInventoryReservationConflictError: vi.fn(() => false),
  prepareAtomicCheckoutAttemptCommit: vi.fn(),
  isCheckoutAttemptCommitConflictError: vi.fn(() => false),
  verifyPromotionCheckoutSnapshot: vi.fn(),
}));

vi.mock("@scalius/database/client", async (importOriginal) => ({
  ...(await importOriginal()),
  safeBatch: mocks.safeBatch,
}));

vi.mock("../inventory", () => ({
  prepareStockReservationBatch: mocks.prepareStockReservationBatch,
  isInventoryReservationConflictError: mocks.isInventoryReservationConflictError,
}));

vi.mock("../promotions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../promotions")>()),
  verifyPromotionCheckoutSnapshot: mocks.verifyPromotionCheckoutSnapshot,
}));

vi.mock("./checkout-attempts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./checkout-attempts")>()),
  prepareAtomicCheckoutAttemptCommit: mocks.prepareAtomicCheckoutAttemptCommit,
  isCheckoutAttemptCommitConflictError: mocks.isCheckoutAttemptCommitConflictError,
}));

import { commitStorefrontOrderPayload } from "./orders.ingest";

function createPayload(overrides: Partial<StorefrontOrderCommitPayload> = {}): StorefrontOrderCommitPayload {
  return {
    checkoutToken: "chk_order_discount",
    checkoutAuthorityRevision: null,
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
  activeCustomer?: { id: string; accountClaimedAt: Date | null; deletedAt: Date | null } | null;
  customerReads?: Array<{ id: string; accountClaimedAt: Date | null; deletedAt: Date | null } | undefined>;
  existingOrder?: { id: string; customerId: string | null; accountOwnerCustomerId: string | null };
} = {}): Database & {
  insertValues: unknown[];
  conflictIgnoredInserts: unknown[];
} {
  const insertValues: unknown[] = [];
  const conflictIgnoredInserts: unknown[] = [];
  const customerReads = [...(options.customerReads ?? [])];
  const createReadQuery = (projection: Record<string, unknown>) => ({
    where: vi.fn(() => ({
      get: vi.fn(async () => {
        if ("accountOwnerCustomerId" in projection) return options.existingOrder;
        if ("customerId" in projection) return undefined;
        if ("maxUses" in projection) return { maxUses: null, limitOnePerCustomer: false };
        if ("accountClaimedAt" in projection) {
          if (customerReads.length > 0) return customerReads.shift();
          return options.activeCustomer === undefined
            ? { id: "cust_existing", accountClaimedAt: new Date(1_700_000_000_000), deletedAt: null }
            : options.activeCustomer;
        }
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
    mocks.prepareStockReservationBatch.mockImplementation(async (_db, items: unknown[]) => ({
      success: true,
      results: [],
      statements: items.length > 0 ? [{ kind: "inventory-guard-and-write" }] : [],
      resolveIdempotentReplay: vi.fn(async () => null),
    }));
    mocks.isInventoryReservationConflictError.mockReturnValue(false);
    mocks.prepareAtomicCheckoutAttemptCommit.mockResolvedValue({
      writesBeforeOrder: [
        { kind: "checkout-attempt-insert" },
        { kind: "checkout-attempt-guard" },
      ],
      writesAfterOrder: [{ kind: "checkout-receipt" }],
    });
    mocks.isCheckoutAttemptCommitConflictError.mockReturnValue(false);
    mocks.verifyPromotionCheckoutSnapshot.mockReset();
  });

  it("maps max-uses trigger aborts while the atomic batch rolls inventory back", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockRejectedValue(new Error("D1_ERROR: DISCOUNT_MAX_USES_EXCEEDED"));

    const result = commitStorefrontOrderPayload(db, createPayload());
    await expect(result).rejects.toBeInstanceOf(ValidationError);
    await expect(result).rejects.toMatchObject({
      name: "ValidationError",
      message: "Discount code has reached its usage limit",
    });
    expect(mocks.safeBatch).toHaveBeenCalledOnce();
  });

  it("creates a CRM profile for true guest checkout without granting account ownership", async () => {
    const db = createDbMock({ customerReads: [undefined] });
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

    expect(result.customerId).toMatch(/^cust_/);
    expect(result.accountOwnerCustomerId).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
    expect(mocks.prepareStockReservationBatch).toHaveBeenCalledOnce();
    expect(mocks.safeBatch).toHaveBeenCalledOnce();
    expect(db.insertValues).toContainEqual(expect.objectContaining({
      phone: "+8801712345678",
      totalOrders: 1,
      totalSpent: 0,
    }));
    expect(db.insertValues).toContainEqual(expect.objectContaining({
      id: "order_discount",
      customerId: result.customerId,
      accountOwnerCustomerId: null,
      totalAmount: 200,
    }));
  });

  it("keeps authenticated CRM and verified account ownership aligned", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockResolvedValue([]);

    const result = await commitStorefrontOrderPayload(db, createPayload({
      discountUsage: null,
      orderData: { ...createPayload().orderData, inventoryAction: "none" },
    }));

    expect(result).toMatchObject({
      customerId: "cust_existing",
      accountOwnerCustomerId: "cust_existing",
    });
    expect(db.insertValues).toContainEqual(expect.objectContaining({
      id: "order_discount",
      customerId: "cust_existing",
      accountOwnerCustomerId: "cust_existing",
    }));
  });

  it("commits COD tracking in the same write batch as a COD order", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockResolvedValue([]);

    await commitStorefrontOrderPayload(db, createPayload({
      discountUsage: null,
      orderData: {
        ...createPayload().orderData,
        paymentMethod: "cod",
        status: "pending",
        inventoryAction: "none",
      },
    }));

    expect(db.insertValues).toContainEqual(expect.objectContaining({
      orderId: "order_discount",
      deliveryAttempts: 0,
      codStatus: "pending",
    }));
    expect(mocks.safeBatch).toHaveBeenCalledOnce();
  });

  it("retries one guest phone race after the failed atomic batch without compensation", async () => {
    const db = createDbMock({
      customerReads: [
        undefined,
        { id: "cust_race_winner", accountClaimedAt: null, deletedAt: null },
      ],
    });
    mocks.safeBatch
      .mockRejectedValueOnce(new Error("UNIQUE constraint failed: customers.phone"))
      .mockResolvedValueOnce([]);

    const result = await commitStorefrontOrderPayload(db, createPayload({
      existingCustomer: null,
      discountUsage: null,
    }));

    expect(result).toMatchObject({
      customerId: "cust_race_winner",
      accountOwnerCustomerId: null,
      alreadyCommitted: false,
    });
    expect(mocks.prepareStockReservationBatch).toHaveBeenCalledTimes(2);
    expect(mocks.safeBatch).toHaveBeenCalledTimes(2);
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

  it("rejects an inactive authenticated customer without executing the prepared inventory writes", async () => {
    const db = createDbMock({ activeCustomer: null });

    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.toMatchObject({
        name: "ValidationError",
        message: "Customer account is no longer active. Please sign in again.",
      });

    expect(mocks.prepareStockReservationBatch).toHaveBeenCalledOnce();
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

    expect(mocks.safeBatch).toHaveBeenCalledOnce();
  });

  it("commits one typed redemption and immutable line allocation in the order batch", async () => {
    const db = createDbMock();
    const applied = {
      promotionId: "promo_1",
      promotionRevision: 2,
      promotionName: "Typed promotion",
      method: "code" as const,
      promotionCode: "SAVE50",
      totalDiscountMinor: 5_000,
      allocations: [{
        promotionId: "promo_1",
        promotionRevision: 2,
        evaluatorVersion: 1,
        promotionName: "Typed promotion",
        promotionCode: "SAVE50",
        method: "code" as const,
        effectId: "peff_1",
        effectKind: "fixed_amount_off" as const,
        target: "order" as const,
        lineId: "cart:0:variant_1",
        quantity: 2,
        currencyCode: "BDT",
        baseAmountMinor: 20_000,
        discountAmountMinor: 5_000,
      }],
    };
    mocks.verifyPromotionCheckoutSnapshot.mockResolvedValue(applied);
    mocks.safeBatch.mockResolvedValue([]);
    const payload = createPayload({
      discountUsage: null,
      promotion: {
        cart: {
          currencyCode: "BDT",
          lines: [{
            id: "cart:0:variant_1",
            productId: "prod_1",
            variantId: "variant_1",
            unitPriceMinor: 10_000,
            quantity: 2,
          }],
          shippingAmountMinor: 6_000,
          submittedCodes: ["SAVE50"],
        },
        applied,
      },
      orderData: { ...createPayload().orderData, inventoryAction: "none" },
    });

    await commitStorefrontOrderPayload(db, payload);

    expect(mocks.verifyPromotionCheckoutSnapshot).toHaveBeenCalledWith(
      db,
      payload.promotion,
      "cust_existing",
    );
    expect(db.insertValues).toContainEqual(expect.objectContaining({
      promotionId: "promo_1",
      orderId: "order_discount",
      customerId: "cust_existing",
      promotionCode: "SAVE50",
      discountAmountMinor: 5_000,
    }));
    expect(db.insertValues).toContainEqual([
      expect.objectContaining({
        orderItemId: "item_1",
        effectId: "peff_1",
        target: "order",
        discountAmountMinor: 5_000,
      }),
    ]);
  });

  it("maps concurrent typed budget exhaustion from the all-or-nothing batch", async () => {
    const db = createDbMock();
    const payload = createPayload({
      discountUsage: null,
      promotion: { cart: {} as never, applied: {} as never },
    });
    mocks.verifyPromotionCheckoutSnapshot.mockResolvedValue({
      promotionId: "promo_1",
      promotionRevision: 2,
      promotionName: "Typed promotion",
      method: "code",
      promotionCode: "SAVE50",
      totalDiscountMinor: 5_000,
      allocations: [{
        promotionId: "promo_1",
        promotionRevision: 2,
        evaluatorVersion: 1,
        promotionName: "Typed promotion",
        promotionCode: "SAVE50",
        method: "code",
        effectId: "peff_1",
        effectKind: "fixed_amount_off",
        target: "order",
        lineId: "cart:0:variant_1",
        quantity: 2,
        currencyCode: "BDT",
        baseAmountMinor: 20_000,
        discountAmountMinor: 5_000,
      }],
    });
    mocks.safeBatch.mockRejectedValue(new Error("PROMOTION_REDEMPTION_SPEND_LIMIT"));

    await expect(commitStorefrontOrderPayload(db, payload)).rejects.toThrow(
      "campaign budget is no longer available",
    );
    expect(mocks.safeBatch).toHaveBeenCalledOnce();
  });

  it("returns the committed order on a checkout retry without re-claiming the promotion", async () => {
    const db = createDbMock({
      existingOrder: {
        id: "order_discount",
        customerId: "cust_existing",
        accountOwnerCustomerId: "cust_existing",
      },
    });
    const payload = createPayload({
      discountUsage: null,
      promotion: { cart: {} as never, applied: {} as never },
    });

    await expect(commitStorefrontOrderPayload(db, payload)).resolves.toEqual({
      orderId: "order_discount",
      customerId: "cust_existing",
      accountOwnerCustomerId: "cust_existing",
      alreadyCommitted: true,
    });
    expect(mocks.verifyPromotionCheckoutSnapshot).not.toHaveBeenCalled();
    expect(mocks.prepareStockReservationBatch).not.toHaveBeenCalled();
    expect(mocks.safeBatch).not.toHaveBeenCalled();
  });

  it("maps missing customer-key trigger aborts to a phone-specific validation error", async () => {
    const db = createDbMock();
    mocks.safeBatch.mockRejectedValue(new Error("D1_ERROR: DISCOUNT_CUSTOMER_KEY_REQUIRED"));

    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.toThrow("A valid phone number is required to use this discount");

    expect(mocks.safeBatch).toHaveBeenCalledOnce();
  });

  it("preserves unrelated atomic commit errors", async () => {
    const db = createDbMock();
    const rawError = new Error("D1 batch unavailable");
    mocks.safeBatch.mockRejectedValue(rawError);

    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.toBe(rawError);

    expect(mocks.safeBatch).toHaveBeenCalledOnce();
  });

  it("re-prepares checkout state after an exhausted provider write conflict", async () => {
    const db = createDbMock();
    mocks.isInventoryReservationConflictError.mockReturnValue(true);
    mocks.safeBatch.mockRejectedValue(Object.assign(new Error("write conflict"), {
      code: "SQLITE_BUSY_SNAPSHOT",
    }));

    await expect(commitStorefrontOrderPayload(db, createPayload()))
      .rejects.toThrow("Inventory is changing quickly. Please retry checkout.");

    expect(mocks.safeBatch).toHaveBeenCalledTimes(3);
    expect(mocks.prepareStockReservationBatch).toHaveBeenCalledTimes(3);
  });

  it("composes inventory and order writes into one batch with no cleanup batch", async () => {
    const db = createDbMock();
    const inventoryStatement = { kind: "inventory-guard-ledger-and-cas" };
    mocks.prepareStockReservationBatch.mockResolvedValue({
      success: true,
      results: [],
      statements: [inventoryStatement],
      resolveIdempotentReplay: vi.fn(async () => null),
    });
    mocks.safeBatch.mockResolvedValue([]);

    await commitStorefrontOrderPayload(db, createPayload());

    expect(mocks.safeBatch).toHaveBeenCalledOnce();
    const statements = mocks.safeBatch.mock.calls[0]?.[1] as unknown[];
    expect(statements[0]).toBe(inventoryStatement);
    expect(statements.length).toBeGreaterThan(1);
  });

  it("commits a new idempotency candidate with the order and skips the impossible existing-order read", async () => {
    const db = createDbMock();
    const attemptWrite = { kind: "checkout-attempt-insert" };
    const attemptGuard = { kind: "checkout-attempt-atomic-guard" };
    const inventoryStatement = { kind: "inventory-guard-ledger-and-cas" };
    const receiptWrite = { kind: "checkout-receipt" };
    mocks.prepareStockReservationBatch.mockResolvedValue({
      success: true,
      results: [],
      statements: [inventoryStatement],
      resolveIdempotentReplay: vi.fn(async () => null),
    });
    mocks.prepareAtomicCheckoutAttemptCommit.mockResolvedValue({
      writesBeforeOrder: [attemptWrite, attemptGuard],
      writesAfterOrder: [receiptWrite],
    });
    mocks.safeBatch.mockResolvedValue([]);

    await commitStorefrontOrderPayload(db, createPayload(), {
      attempt: {
        commitMode: "atomic",
        origin: "new",
        id: "attempt_atomic_1",
        requestKey: "checkout_submit:v1:key",
        requestHash: "request_hash",
        orderId: "order_discount",
        checkoutToken: "chk_order_discount",
        statusToken: "cst_status",
      },
      response: { orderId: "order_discount", message: "Order created" },
    });

    expect(mocks.prepareAtomicCheckoutAttemptCommit).toHaveBeenCalledOnce();
    const statements = mocks.safeBatch.mock.calls[0]?.[1] as unknown[];
    expect(statements[0]).toBe(attemptWrite);
    expect(statements[1]).toBe(attemptGuard);
    expect(statements[2]).toBe(inventoryStatement);
    expect(statements.at(-1)).toBe(receiptWrite);
    expect(db.select).not.toHaveBeenCalledWith(expect.objectContaining({
      accountOwnerCustomerId: expect.anything(),
    }));
  });

  it("returns the committed order after an uncertain successful commit", async () => {
    const db = createDbMock({
      existingOrder: {
        id: "order_discount",
        customerId: "cust_existing",
        accountOwnerCustomerId: "cust_existing",
      },
    });
    mocks.prepareStockReservationBatch.mockResolvedValue({
      success: true,
      results: [],
      statements: [{ kind: "fresh-inventory-write" }],
      resolveIdempotentReplay: vi.fn(async () => null),
    });
    mocks.safeBatch.mockRejectedValue(new Error("response lost after commit"));

    const result = await commitStorefrontOrderPayload(db, createPayload(), {
      attempt: {
        commitMode: "atomic",
        origin: "new",
        id: "attempt_atomic_uncertain",
        requestKey: "checkout_submit:v1:uncertain",
        requestHash: "request_hash",
        orderId: "order_discount",
        checkoutToken: "chk_order_discount",
        statusToken: "cst_uncertain",
      },
      response: { orderId: "order_discount", message: "Order created" },
    });

    expect(result).toMatchObject({
      orderId: "order_discount",
      alreadyCommitted: true,
    });
  });

  it("maps reservation failures to structured cart item issues", async () => {
    const db = createDbMock();
    mocks.prepareStockReservationBatch.mockResolvedValue({
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
      statements: [],
      resolveIdempotentReplay: vi.fn(async () => null),
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
