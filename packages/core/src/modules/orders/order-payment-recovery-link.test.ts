import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import {
  orderPayments,
  orderReceipts,
  orders,
  paymentPlans,
  paymentSessionAttempts,
  OrderStatus,
  PaymentMethod,
  PaymentPlanStatus,
  PaymentRecordStatus,
  PaymentStatus,
} from "@scalius/database/schema";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import {
  createOrderPaymentRecoveryLink,
} from "./orders.admin";
import { hashOrderReceiptToken } from "./order-receipts";

type RecoveryOrderRow = {
  id: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  paidAmount: number;
  balanceDue: number;
  deletedAt: number | null;
  shipmentClaimId: string | null;
  shipmentClaimExpiresAt: number | null;
};

type AttemptRow = {
  orderId: string;
  gateway: string;
  paymentType: string;
  amount: number;
  status: string;
  attempts: number;
  claimExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

function recoveryOrder(overrides: Partial<RecoveryOrderRow> = {}): RecoveryOrderRow {
  return {
    id: "order_1",
    status: OrderStatus.INCOMPLETE,
    paymentStatus: PaymentStatus.FAILED,
    paymentMethod: PaymentMethod.SSLCOMMERZ,
    paidAmount: 0,
    balanceDue: 120,
    deletedAt: null,
    shipmentClaimId: null,
    shipmentClaimExpiresAt: null,
    ...overrides,
  };
}

function createRecoveryLinkDb(options: {
  order?: RecoveryOrderRow | null;
  attempts?: AttemptRow[];
  payments?: Array<{ status: string }>;
  plan?: { status: string; depositAmount: number } | null;
} = {}) {
  const insertedReceipts: Array<Record<string, unknown>> = [];

  const db = {
    select: () => {
      let selectedTable: unknown;
      const query = {
        from: (table: unknown) => {
          selectedTable = table;
          return query;
        },
        where: () => query,
        get: async () => {
          if (selectedTable === orders) return options.order ?? null;
          if (selectedTable === paymentPlans) return options.plan ?? null;
          return null;
        },
        all: async () => {
          if (selectedTable === paymentSessionAttempts) return options.attempts ?? [];
          if (selectedTable === orderPayments) return options.payments ?? [];
          return [];
        },
      };
      return query;
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          if (table === orderReceipts) insertedReceipts.push(values);
        },
      }),
    }),
  } as unknown as Database;

  return { db, insertedReceipts };
}

describe("admin order payment recovery links", () => {
  it("issues a hash-backed receipt token for eligible SSLCommerz recovery", async () => {
    const { db, insertedReceipts } = createRecoveryLinkDb({
      order: recoveryOrder(),
      attempts: [{
        orderId: "order_1",
        gateway: PaymentMethod.SSLCOMMERZ,
        paymentType: "deposit",
        amount: 60,
        status: "failed",
        attempts: 1,
        claimExpiresAt: null,
        createdAt: 90,
        updatedAt: 95,
      }],
      payments: [{ status: PaymentRecordStatus.FAILED }],
      plan: { status: PaymentPlanStatus.PENDING, depositAmount: 60 },
    });

    const result = await createOrderPaymentRecoveryLink(db, "order_1", { nowSeconds: 100 });

    expect(result).toMatchObject({
      orderId: "order_1",
      gateway: PaymentMethod.SSLCOMMERZ,
      expiresAt: 100 + 60 * 60 * 24 * 7,
      paymentType: "deposit",
      depositAmount: 60,
      paymentRecovery: {
        state: "needs_attention",
        gateway: PaymentMethod.SSLCOMMERZ,
      },
    });
    expect(result.receiptToken).toMatch(/^chk_/);
    expect(insertedReceipts).toHaveLength(1);
    expect(insertedReceipts[0]).toMatchObject({
      tokenHash: await hashOrderReceiptToken(result.receiptToken),
      orderId: "order_1",
      source: "admin_payment_recovery",
      status: "active",
      expiresAt: result.expiresAt,
    });
    expect(JSON.stringify(insertedReceipts[0])).not.toContain(result.receiptToken);
  });

  it("fails closed for Stripe until storefront receipt retry supports it", async () => {
    const { db, insertedReceipts } = createRecoveryLinkDb({
      order: recoveryOrder({ paymentMethod: PaymentMethod.STRIPE }),
      attempts: [{
        orderId: "order_1",
        gateway: PaymentMethod.STRIPE,
        paymentType: "full",
        amount: 120,
        status: "failed",
        attempts: 1,
        claimExpiresAt: null,
        createdAt: 90,
        updatedAt: 95,
      }],
    });

    await expect(createOrderPaymentRecoveryLink(db, "order_1"))
      .rejects.toBeInstanceOf(ValidationError);
    expect(insertedReceipts).toHaveLength(0);
  });

  it("does not issue a link while hosted payment setup is actively processing", async () => {
    const { db, insertedReceipts } = createRecoveryLinkDb({
      order: recoveryOrder({ paymentStatus: PaymentStatus.UNPAID }),
      attempts: [{
        orderId: "order_1",
        gateway: PaymentMethod.POLAR,
        paymentType: "full",
        amount: 120,
        status: "processing",
        attempts: 1,
        claimExpiresAt: 500,
        createdAt: 90,
        updatedAt: 95,
      }],
    });

    await expect(createOrderPaymentRecoveryLink(db, "order_1", { nowSeconds: 100 }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(insertedReceipts).toHaveLength(0);
  });

  it("does not issue a link when unsafe payment evidence exists", async () => {
    const { db, insertedReceipts } = createRecoveryLinkDb({
      order: recoveryOrder(),
      payments: [{ status: PaymentRecordStatus.SUCCEEDED }],
    });

    await expect(createOrderPaymentRecoveryLink(db, "order_1"))
      .rejects.toBeInstanceOf(ValidationError);
    expect(insertedReceipts).toHaveLength(0);
  });

  it("does not issue a failed-payment link without failed local evidence", async () => {
    const { db, insertedReceipts } = createRecoveryLinkDb({
      order: recoveryOrder(),
    });

    await expect(createOrderPaymentRecoveryLink(db, "order_1"))
      .rejects.toBeInstanceOf(ValidationError);
    expect(insertedReceipts).toHaveLength(0);
  });

  it("does not issue a link while shipment recovery owns the order", async () => {
    const { db, insertedReceipts } = createRecoveryLinkDb({
      order: recoveryOrder({
        shipmentClaimId: "claim_1",
        shipmentClaimExpiresAt: 500,
      }),
      payments: [{ status: PaymentRecordStatus.FAILED }],
    });

    await expect(createOrderPaymentRecoveryLink(db, "order_1", { nowSeconds: 100 }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(insertedReceipts).toHaveLength(0);
  });
});
