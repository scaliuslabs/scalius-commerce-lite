import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Database } from "@scalius/database/client";
import { sql } from "drizzle-orm";
import { assertManualCodDepositVerified, readPaymentPlan } from "../../payments/manual-cod-deposit";
import { applyOrderStatusChange } from "../status/lifecycle";
import { OrderStatus, PaymentMethod, PaymentPlanStatus, PaymentStatus } from "@scalius/database/schema";

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
