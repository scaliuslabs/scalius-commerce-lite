import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Database } from "@scalius/database/client";
import { sql, eq, inArray } from "drizzle-orm";
import { assertManualCodDepositVerified, readPaymentPlan } from "../../payments/manual-cod-deposit";
import { applyOrderStatusChange, reconcileRefundedOrderInventory } from "../status/lifecycle";
import { OrderStatus, PaymentMethod, PaymentPlanStatus, PaymentStatus } from "@scalius/database/schema";
import { orders } from "@scalius/database/schema";

vi.mock("../../payments", () => ({
  assertManualCodDepositVerified: vi.fn().mockResolvedValue(undefined),
  assertOrderPaymentCurrency: vi.fn(),
  resolveOrderCurrencySnapshot: vi.fn().mockReturnValue({ code: "EGP", decimalPlaces: 2 }),
}));

vi.mock("./policy", () => ({
  assertGenericAdminOrderStatusTransition: vi.fn(),
}));

vi.mock("../holds", () => ({
  assertOrderNotOnHold: vi.fn(),
}));

vi.mock("../../order-kernel", () => ({
  assertNoActiveShipmentClaim: vi.fn(),
  assertNoActiveRefundAttempt: vi.fn().mockResolvedValue(undefined),
  assertNoActivePaymentSessionAttempt: vi.fn().mockResolvedValue(undefined),
  noActivePaymentSessionAttemptForOrderIdCondition: () => sql`true`,
  noActiveRefundAttemptForOrderIdCondition: () => sql`true`,
  validateTransition: vi.fn(),
}));

vi.mock("../../inventory", () => ({
  applyInventoryForStatusChangeWithImpact: vi.fn().mockResolvedValue({
    inventoryAction: "none",
    availabilityTransitionVariantIds: [],
  }),
}));

import { assertManualCodDepositVerified as mockedAssertManualCodDepositVerified } from "../../payments";

function mockDb(plan: { id: string; status: string; kind: string } | null): Database {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockResolvedValue(plan),
        }),
      }),
    }) as any,
    update: vi.fn() as any,
    insert: vi.fn() as any,
    delete: vi.fn() as any,
    batch: vi.fn().mockResolvedValue([]) as any,
    exec: vi.fn() as any,
    prepare: vi.fn() as any,
    transaction: vi.fn() as any,
  } as unknown as Database;
}

function createOrderMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "order_1",
    status: OrderStatus.PENDING,
    requiresShipping: true,
    inventoryAction: "deducted",
    version: 1,
    customerName: "Test Customer",
    customerEmail: "test@example.test",
    paymentMethod: PaymentMethod.COD,
    paymentStatus: PaymentStatus.UNPAID,
    totalAmountMinor: 10000,
    paidAmountMinor: 0,
    balanceDueMinor: 10000,
    paymentTermsDays: null,
    currencyCode: "EGP",
    currencyDecimalPlaces: 2,
    shipmentClaimId: null,
    shipmentClaimExpiresAt: null,
    ...overrides,
  };
}

function createAppDb(order: Record<string, unknown>): Database {
  let getCallCount = 0;
  const selectMock = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation(() => {
      const whereResult: any = {
        get: vi.fn().mockImplementation(async () => {
          getCallCount += 1;
          return getCallCount === 1 ? order : null;
        }),
        all: vi.fn().mockResolvedValue([]),
      };
      whereResult.groupBy = vi.fn().mockReturnValue(whereResult);
      return {
        where: vi.fn().mockReturnValue(whereResult),
      };
    }),
  }));

  const updateMock = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => ({
        returning: vi.fn().mockResolvedValue([{ id: "order_1" }]),
      })),
    })),
  }));

  return {
    select: selectMock,
    update: updateMock,
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn(),
    prepare: vi.fn(),
    transaction: vi.fn(),
  } as unknown as Database;
}

describe("assertManualCodDepositVerified", () => {
  it("throws when plan is PENDING", async () => {
    const db = mockDb({ id: "plan_1", status: PaymentPlanStatus.PENDING, kind: "manual" });
    await expect(assertManualCodDepositVerified(db, "order_1")).rejects.toThrow(
      "The deposit must be recorded before this order can move on.",
    );
  });

  it("throws when plan is CANCELLED", async () => {
    const db = mockDb({ id: "plan_1", status: PaymentPlanStatus.CANCELLED, kind: "manual" });
    await expect(assertManualCodDepositVerified(db, "order_1")).rejects.toThrow(
      "This order's deposit was refunded. Fulfilment is blocked.",
    );
  });

  it("passes when plan is DEPOSIT_PAID", async () => {
    const db = mockDb({ id: "plan_1", status: PaymentPlanStatus.DEPOSIT_PAID, kind: "manual" });
    await expect(assertManualCodDepositVerified(db, "order_1")).resolves.toBeUndefined();
  });

  it("passes when plan is COMPLETED", async () => {
    const db = mockDb({ id: "plan_1", status: PaymentPlanStatus.COMPLETED, kind: "manual" });
    await expect(assertManualCodDepositVerified(db, "order_1")).resolves.toBeUndefined();
  });

  it("passes when there is no payment plan", async () => {
    const db = mockDb(null);
    await expect(assertManualCodDepositVerified(db, "order_1")).resolves.toBeUndefined();
  });

  it("passes when plan kind is not manual", async () => {
    const db = mockDb({ id: "plan_1", status: PaymentPlanStatus.PENDING, kind: "online" });
    await expect(assertManualCodDepositVerified(db, "order_1")).resolves.toBeUndefined();
  });

  it("readPaymentPlan returns null when no plan exists", async () => {
    const db = mockDb(null);
    const plan = await readPaymentPlan(db, "order_1");
    expect(plan).toBeNull();
  });

  it("readPaymentPlan returns plan data when plan exists", async () => {
    const db = mockDb({ id: "plan_1", status: PaymentPlanStatus.PENDING, kind: "manual" });
    const plan = await readPaymentPlan(db, "order_1");
    expect(plan).toEqual({ id: "plan_1", status: PaymentPlanStatus.PENDING, kind: "manual" });
  });
});

describe("applyOrderStatusChange — CANCELLED exemption (Fix C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls assertManualCodDepositVerified for COD order transitioning to CONFIRMED", async () => {
    const db = createAppDb(createOrderMock({ paymentMethod: PaymentMethod.COD }));
    await applyOrderStatusChange(db, "order_1", OrderStatus.CONFIRMED, undefined, { generic: true });
    expect(mockedAssertManualCodDepositVerified).toHaveBeenCalledWith(db, "order_1");
  });

  it("does NOT call assertManualCodDepositVerified for COD order transitioning to CANCELLED", async () => {
    const db = createAppDb(createOrderMock({ paymentMethod: PaymentMethod.COD }));
    await applyOrderStatusChange(db, "order_1", OrderStatus.CANCELLED, undefined, { generic: true });
    expect(mockedAssertManualCodDepositVerified).not.toHaveBeenCalled();
  });

  it("does NOT call assertManualCodDepositVerified for non-COD order transitioning to CONFIRMED", async () => {
    const db = createAppDb(createOrderMock({ paymentMethod: "stripe" }));
    await applyOrderStatusChange(db, "order_1", OrderStatus.CONFIRMED, undefined, { generic: true });
    expect(mockedAssertManualCodDepositVerified).not.toHaveBeenCalled();
  });

  it("rejects status update when assertManualCodDepositVerified throws", async () => {
    const db = createAppDb(createOrderMock({ paymentMethod: PaymentMethod.COD }));
    (mockedAssertManualCodDepositVerified as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("The deposit must be recorded before this order can move on."),
    );
    await expect(
      applyOrderStatusChange(db, "order_1", OrderStatus.CONFIRMED, undefined, { generic: true }),
    ).rejects.toThrow("The deposit must be recorded before this order can move on.");
    // The order update should not be called when verification fails
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("reconcileInventoryForStatus — inventory recovery path (Fix A mandatory verification)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls applyInventoryForStatusChangeWithImpact and updates order inventoryAction", async () => {
    const { applyInventoryForStatusChangeWithImpact } = await import("../../inventory");
    const mockedApplyInventory = applyInventoryForStatusChangeWithImpact as ReturnType<typeof vi.fn>;
    mockedApplyInventory.mockResolvedValue({
      inventoryAction: "none",
      availabilityTransitionVariantIds: ["variant_1", "variant_2"],
    });

    const db = createAppDb(createOrderMock({ status: OrderStatus.CANCELLED }));

    const result = await (await import("../status/lifecycle")).reconcileInventoryForStatus(
      db,
      "order_1",
      OrderStatus.CANCELLED,
    );

    expect(mockedApplyInventory).toHaveBeenCalledWith(db, "order_1", OrderStatus.CANCELLED);
    expect(result).toEqual(["variant_1", "variant_2"]);
  });

  it("propagates inventory release failure for subsequent retry", async () => {
    const { applyInventoryForStatusChangeWithImpact } = await import("../../inventory");
    const mockedApplyInventory = applyInventoryForStatusChangeWithImpact as ReturnType<typeof vi.fn>;
    const releaseError = new Error("Insufficient stock to release");
    mockedApplyInventory.mockRejectedValue(releaseError);

    const db = createAppDb(createOrderMock({ status: OrderStatus.CANCELLED }));

    await expect(
      (await import("../status/lifecycle")).reconcileInventoryForStatus(db, "order_1", OrderStatus.CANCELLED),
    ).rejects.toThrow("Insufficient stock to release");
  });
});

describe("reconcileRefundedOrderInventory — refund inventory recovery drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds and reconciles orders with CANCELLED status, REFUNDED payment, and pending inventoryAction", async () => {
    const { applyInventoryForStatusChangeWithImpact } = await import("../../inventory");
    const mockedApplyInventory = applyInventoryForStatusChangeWithImpact as ReturnType<typeof vi.fn>;
    mockedApplyInventory.mockResolvedValue({
      inventoryAction: "restored",
      availabilityTransitionVariantIds: ["variant_1"],
    });

    // Create a mock DB that returns orders needing reconciliation
    let selectCallCount = 0;
    const selectMock = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => ({
            all: vi.fn().mockImplementation(async () => {
              selectCallCount += 1;
              if (selectCallCount === 1) {
                return [
                  { id: "order_1", inventoryAction: "deducted" },
                  { id: "order_2", inventoryAction: "reserved" },
                ];
              }
              return [];
            }),
          })),
        })),
      })),
    }));

    const updateMock = vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "order_1" }]),
        })),
      })),
    }));

    const db = {
      select: selectMock,
      update: updateMock,
      batch: vi.fn().mockResolvedValue([]),
      exec: vi.fn(),
      prepare: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database;

    const result = await reconcileRefundedOrderInventory(db, { limit: 25 });

    expect(result.scanned).toBe(2);
    expect(result.reconciled).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(mockedApplyInventory).toHaveBeenCalledTimes(2);
    expect(mockedApplyInventory).toHaveBeenCalledWith(db, "order_1", OrderStatus.CANCELLED);
    expect(mockedApplyInventory).toHaveBeenCalledWith(db, "order_2", OrderStatus.CANCELLED);
  });

  it("returns hasMore true when limit is reached", async () => {
    const { applyInventoryForStatusChangeWithImpact } = await import("../../inventory");
    const mockedApplyInventory = applyInventoryForStatusChangeWithImpact as ReturnType<typeof vi.fn>;
    mockedApplyInventory.mockResolvedValue({
      inventoryAction: "restored",
      availabilityTransitionVariantIds: [],
    });

    // Create a mock DB that returns exactly limit orders
    const limit = 3;
    const selectMock = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => ({
            all: vi.fn().mockResolvedValue(
              Array.from({ length: limit }, (_, i) => ({ id: `order_${i + 1}`, inventoryAction: "deducted" })),
            ),
          })),
        })),
      })),
    }));

    const db = {
      select: selectMock,
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "order_1" }]),
          })),
        })),
      })),
      batch: vi.fn().mockResolvedValue([]),
      exec: vi.fn(),
      prepare: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database;

    const result = await reconcileRefundedOrderInventory(db, { limit });

    expect(result.scanned).toBe(limit);
    expect(result.hasMore).toBe(true);
  });

  it("handles reconciliation failures gracefully", async () => {
    const { applyInventoryForStatusChangeWithImpact } = await import("../../inventory");
    const mockedApplyInventory = applyInventoryForStatusChangeWithImpact as ReturnType<typeof vi.fn>;
    mockedApplyInventory
      .mockResolvedValueOnce({ inventoryAction: "restored", availabilityTransitionVariantIds: [] })
      .mockRejectedValueOnce(new Error("Database connection failed"))
      .mockResolvedValueOnce({ inventoryAction: "restored", availabilityTransitionVariantIds: [] });

    const selectMock = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => ({
            all: vi.fn().mockResolvedValue([
              { id: "order_1", inventoryAction: "deducted" },
              { id: "order_2", inventoryAction: "reserved" },
              { id: "order_3", inventoryAction: "deducted" },
            ]),
          })),
        })),
      })),
    }));

    const db = {
      select: selectMock,
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "order_1" }]),
          })),
        })),
      })),
      batch: vi.fn().mockResolvedValue([]),
      exec: vi.fn(),
      prepare: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database;

    const result = await reconcileRefundedOrderInventory(db, { limit: 25 });

    expect(result.scanned).toBe(3);
    expect(result.reconciled).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("order_2");
    expect(result.errors[0]).toContain("Database connection failed");
  });

  it("skips orders that are not CANCELLED or not REFUNDED", async () => {
    const { applyInventoryForStatusChangeWithImpact } = await import("../../inventory");
    const mockedApplyInventory = applyInventoryForStatusChangeWithImpact as ReturnType<typeof vi.fn>;
    mockedApplyInventory.mockResolvedValue({
      inventoryAction: "restored",
      availabilityTransitionVariantIds: [],
    });

    const whereMock = vi.fn().mockImplementation(() => ({
      limit: vi.fn().mockImplementation(() => ({
        all: vi.fn().mockResolvedValue([]),
      })),
    }));
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    const selectMock = vi.fn().mockReturnValue({ from: fromMock });

    const db = {
      select: selectMock,
      update: vi.fn(),
      batch: vi.fn().mockResolvedValue([]),
      exec: vi.fn(),
      prepare: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database;

    const result = await reconcileRefundedOrderInventory(db, { limit: 25 });

    expect(result.scanned).toBe(0);
    expect(result.reconciled).toBe(0);
    expect(result.failed).toBe(0);
    // Verify the query filters for CANCELLED status, REFUNDED payment, and pending inventoryAction
    expect(whereMock).toHaveBeenCalled();
  });

  it("reconciles orders regardless of age — no 7-day cutoff blocks old orders", async () => {
    const { applyInventoryForStatusChangeWithImpact } = await import("../../inventory");
    const mockedApplyInventory = applyInventoryForStatusChangeWithImpact as ReturnType<typeof vi.fn>;
    mockedApplyInventory.mockResolvedValue({
      inventoryAction: "restored",
      availabilityTransitionVariantIds: [],
    });

    // An order far older than 7 days (updatedAt well in the past) must still be
    // reconciled now that the updatedAt cutoff was removed.
    const selectMock = vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => ({
            all: vi.fn().mockResolvedValue([
              { id: "order_old", inventoryAction: "deducted", updatedAt: 1_000_000 },
            ]),
          })),
        })),
      })),
    }));

    const db = {
      select: selectMock,
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({
          where: vi.fn().mockImplementation(() => ({
            returning: vi.fn().mockResolvedValue([{ id: "order_old" }]),
          })),
        })),
      })),
      batch: vi.fn().mockResolvedValue([]),
      exec: vi.fn(),
      prepare: vi.fn(),
      transaction: vi.fn(),
    } as unknown as Database;

    const result = await reconcileRefundedOrderInventory(db, { limit: 25 });

    expect(result.scanned).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockedApplyInventory).toHaveBeenCalledWith(db, "order_old", OrderStatus.CANCELLED);
  });
});
