import { describe, expect, it, vi } from "vitest";
import { customerSessions, customers, OrderStatus, PaymentStatus } from "@scalius/database/schema";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

import {
  bulkDeleteCustomers,
  buildCustomerOrderMetricsProjection,
  customerAccountOrderVisibilityCondition,
  buildCustomerOrderBaseTimelineEvents,
  buildCustomerOrderNotificationTimelineEvents,
  decodeCustomerOrdersCursor,
  deleteCustomer,
  encodeCustomerOrdersCursor,
  getCustomerSpendContribution,
  getCustomerVisibleBalanceDue,
  permanentlyDeleteCustomer,
  projectCustomerOrderNotifications,
  summarizeCustomerAccountOrders,
} from "./customers.service";

describe("admin customer commerce metrics", () => {
  it("derives lifetime value from paid value while retaining unpaid orders in the count", () => {
    const metrics = buildCustomerOrderMetricsProjection();
    const dialect = new SQLiteSyncDialect();
    const totalOrders = dialect.sqlToQuery(metrics.totalOrders);
    const totalSpent = dialect.sqlToQuery(metrics.totalSpent);

    expect(totalOrders.sql).toContain("count(*)");
    expect(totalOrders.sql).toContain("customer_orders.customer_id");
    expect(totalSpent.sql).toContain("customer_orders.paid_amount");
    expect(totalSpent.sql).not.toContain("customer_orders.total_amount");
    expect(totalSpent.sql).toContain("partially_refunded");
    expect(totalSpent.sql).toContain("customer_orders.deleted_at IS NULL");
  });

  it("filters private account history and detail reads by verified ownership", () => {
    const compiled = new SQLiteSyncDialect().sqlToQuery(
      customerAccountOrderVisibilityCondition("cust_account"),
    );

    expect(compiled.sql).toContain('"orders"."account_owner_customer_id" = ?');
    expect(compiled.sql).toContain('"orders"."deleted_at" is null');
    expect(compiled.sql).not.toContain('"orders"."customer_id" = ?');
    expect(compiled.params).toEqual(["cust_account"]);
  });
});

const existingCustomer = {
  id: "cust_1",
  name: "Buyer",
  email: "buyer@example.com",
  phone: "+8801712345678",
  address: null,
  city: null,
  zone: null,
  area: null,
  cityName: null,
  zoneName: null,
  areaName: null,
};

function createDb(existing: unknown = existingCustomer) {
  const get = vi.fn(async () => existing);
  const selectWhere = vi.fn(() => ({
    get,
    limit: vi.fn(() => ({ get })),
  }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  const update = vi.fn((table: unknown) => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({ op: "update", table })),
    })),
  }));
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn(() => ({ op: "insert", table })),
  }));
  const deleteFrom = vi.fn((table: unknown) => ({
    where: vi.fn(() => ({ op: "delete", table })),
  }));
  const batch = vi.fn(async (ops: unknown[]) => ops);

  return { select, update, insert, delete: deleteFrom, batch };
}

describe("customers service session revocation", () => {
  it("revokes active customer sessions when soft-deleting one customer", async () => {
    const db = createDb();

    await deleteCustomer(db as never, "cust_1");

    expect(db.update).toHaveBeenCalledWith(customers);
    expect(db.update).toHaveBeenCalledWith(customerSessions);
    expect(db.batch).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ op: "update", table: customerSessions }),
    ]));
  });

  it("deletes customer session rows during permanent delete", async () => {
    const db = createDb(null);

    await permanentlyDeleteCustomer(db as never, "cust_1");

    expect(db.delete).toHaveBeenCalledWith(customerSessions);
    expect(db.batch).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ op: "delete", table: customerSessions }),
    ]));
  });

  it("revokes or deletes session rows during bulk customer deletion", async () => {
    const softDb = createDb();
    await bulkDeleteCustomers(softDb as never, ["cust_1", "cust_2"], false);
    expect(softDb.update).toHaveBeenCalledWith(customerSessions);

    const permanentDb = createDb(null);
    await bulkDeleteCustomers(permanentDb as never, ["cust_1", "cust_2"], true);
    expect(permanentDb.delete).toHaveBeenCalledWith(customerSessions);
  });

  it("blocks permanent deletion when order audit history references the customer", async () => {
    const db = createDb({ id: "order_1" });

    await expect(permanentlyDeleteCustomer(db as never, "cust_1"))
      .rejects.toThrow("Customers with order history cannot be permanently deleted");

    expect(db.delete).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });
});

describe("customer account order money projection", () => {
  it("hides actionable balance due for closed or refunded customer-visible states", () => {
    for (const status of [
      OrderStatus.CANCELLED,
      OrderStatus.RETURNED,
      OrderStatus.REFUNDED,
      OrderStatus.PARTIALLY_REFUNDED,
    ]) {
      expect(getCustomerVisibleBalanceDue({
        status,
        paymentStatus: PaymentStatus.UNPAID,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      })).toBe(0);
    }

    expect(getCustomerVisibleBalanceDue({
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.REFUNDED,
      totalAmount: 100,
      paidAmount: 0,
      balanceDue: 100,
    })).toBe(0);
  });

  it("keeps stored active balances with a safe computed fallback", () => {
    expect(getCustomerVisibleBalanceDue({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PARTIAL,
      totalAmount: 100,
      paidAmount: 40,
      balanceDue: 60,
    })).toBe(60);

    expect(getCustomerVisibleBalanceDue({
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      totalAmount: 100,
      paidAmount: 25,
      balanceDue: null,
    })).toBe(75);
  });

  it("summarizes lifetime account stats independently from displayed order pages", () => {
    const visibleOrders = [
      {
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        totalAmount: 100,
        paidAmount: 0,
        balanceDue: 100,
      },
    ];
    const allOrders = [
      ...visibleOrders,
      {
        status: OrderStatus.DELIVERED,
        paymentStatus: PaymentStatus.PAID,
        totalAmount: 500,
        paidAmount: 500,
        balanceDue: 0,
      },
      {
        status: OrderStatus.REFUNDED,
        paymentStatus: PaymentStatus.REFUNDED,
        totalAmount: 300,
        paidAmount: 0,
        balanceDue: 300,
      },
    ];

    expect(visibleOrders.reduce((sum, order) => sum + getCustomerSpendContribution(order), 0)).toBe(0);
    expect(summarizeCustomerAccountOrders(allOrders)).toEqual({
      totalOrders: 3,
      totalSpent: 500,
      completedOrders: 1,
      pendingOrders: 1,
    });
  });
});

describe("customer account order history pagination and timeline", () => {
  it("round-trips stable order-history cursors", () => {
    const cursor = encodeCustomerOrdersCursor({
      id: "order_2026/06 with spaces",
      createdAt: 1_780_000_000,
    });

    expect(cursor).toBe("1780000000~order_2026%2F06%20with%20spaces");
    expect(decodeCustomerOrdersCursor(cursor ?? undefined)).toEqual({
      id: "order_2026/06 with spaces",
      createdAt: 1_780_000_000,
    });
  });

  it("rejects malformed order-history cursors", () => {
    expect(() => decodeCustomerOrdersCursor("not-a-cursor")).toThrow("Invalid order-history cursor.");
    expect(() => decodeCustomerOrdersCursor("0~order_1")).toThrow("Invalid order-history cursor.");
  });

  it("keeps order-created timeline copy immutable and adds current status separately", () => {
    expect(buildCustomerOrderBaseTimelineEvents({
      id: "order_1",
      status: OrderStatus.DELIVERED,
      createdAt: 1_780_000_000,
      updatedAt: 1_780_003_600,
    })).toEqual([
      {
        id: "order-created:order_1",
        type: "order",
        status: "placed",
        label: "Order placed",
        happenedAt: "2026-05-28T20:26:40.000Z",
        details: "We received your order.",
      },
      {
        id: "order-status:order_1:delivered",
        type: "order",
        status: OrderStatus.DELIVERED,
        label: "Current status: Delivered",
        happenedAt: "2026-05-28T21:26:40.000Z",
        details: "Order is currently Delivered.",
      },
    ]);
  });

  it("surfaces post-sale notification receipts as customer account timeline events", () => {
    const iso = (timestamp: number) => new Date(timestamp * 1000).toISOString();
    const notifications = projectCustomerOrderNotifications([
      {
        id: "receipt_balance",
        notificationType: "payment_balance_paid",
        channel: "email",
        status: "accepted",
        provider: "resend",
        providerStatus: null,
        acceptedAt: 1_780_004_000,
        deliveredAt: null,
        failedAt: null,
        skippedAt: null,
        updatedAt: 1_780_003_990,
        createdAt: 1_780_003_980,
      },
      {
        id: "receipt_refund",
        notificationType: "order_refunded",
        channel: "sms",
        status: "delivered",
        provider: "sms_net_bd",
        providerStatus: "sent",
        acceptedAt: 1_780_005_000,
        deliveredAt: 1_780_005_015,
        failedAt: null,
        skippedAt: null,
        updatedAt: 1_780_005_010,
        createdAt: 1_780_004_990,
      },
      {
        id: "receipt_partial_refund",
        notificationType: "order_partially_refunded",
        channel: "whatsapp",
        status: "skipped",
        provider: "meta",
        providerStatus: "template_paused",
        acceptedAt: null,
        deliveredAt: null,
        failedAt: null,
        skippedAt: 1_780_006_000,
        updatedAt: 1_780_005_990,
        createdAt: 1_780_005_980,
      },
    ]);

    expect(notifications).toMatchObject([
      {
        id: "receipt_balance",
        notificationType: "payment_balance_paid",
        acceptedAt: iso(1_780_004_000),
        updatedAt: iso(1_780_003_990),
      },
      {
        id: "receipt_refund",
        notificationType: "order_refunded",
        deliveredAt: iso(1_780_005_015),
        providerStatus: "sent",
      },
      {
        id: "receipt_partial_refund",
        notificationType: "order_partially_refunded",
        skippedAt: iso(1_780_006_000),
        providerStatus: "template_paused",
      },
    ]);

    expect(buildCustomerOrderNotificationTimelineEvents(notifications)).toEqual([
      {
        id: "notification:receipt_balance",
        type: "notification",
        status: "accepted",
        label: "Email notification Accepted",
        happenedAt: iso(1_780_004_000),
        details: "Payment Balance Paid",
      },
      {
        id: "notification:receipt_refund",
        type: "notification",
        status: "delivered",
        label: "SMS notification Delivered",
        happenedAt: iso(1_780_005_015),
        details: "Order Refunded",
      },
      {
        id: "notification:receipt_partial_refund",
        type: "notification",
        status: "skipped",
        label: "WhatsApp notification Skipped",
        happenedAt: iso(1_780_006_000),
        details: "Order Partially Refunded",
      },
    ]);
  });
});
