import { describe, expect, it, vi } from "vitest";
import { customerSessions, customers, OrderStatus, PaymentStatus } from "@scalius/database/schema";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

import {
  bulkDeleteCustomers,
  buildCustomerOrderMetricsProjection,
  buildCustomerOrderItemDetailProjection,
  customerAccountOrderVisibilityCondition,
  buildCustomerOrderBaseTimelineEvents,
  buildCustomerOrderNotificationTimelineEvents,
  decodeCustomerOrdersCursor,
  deleteCustomer,
  encodeCustomerOrdersCursor,
  getCustomerSpendContribution,
  getCustomerVisibleBalanceDue,
  listCustomers,
  permanentlyDeleteCustomer,
  projectCustomerOrderNotifications,
  summarizeCustomerAccountOrders,
} from "./customers.service";

interface CapturedListQuery {
  fields: Record<string, unknown>;
  joins: unknown[];
  limit?: number;
  offset?: number;
}

function createListCustomersDb(options: {
  count: number;
  rows: Record<string, unknown>[];
}) {
  const queries: CapturedListQuery[] = [];
  const select = vi.fn((fields: Record<string, unknown>) => {
    const query: CapturedListQuery = { fields, joins: [] };
    const builder = {} as {
      from: ReturnType<typeof vi.fn>;
      leftJoin: ReturnType<typeof vi.fn>;
      where: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
      offset: ReturnType<typeof vi.fn>;
      orderBy: ReturnType<typeof vi.fn>;
    };
    builder.from = vi.fn(() => builder);
    builder.leftJoin = vi.fn((_table: unknown, condition: unknown) => {
      query.joins.push(condition);
      return builder;
    });
    builder.where = vi.fn(() => builder);
    builder.groupBy = vi.fn(() => builder);
    builder.limit = vi.fn((value: number) => {
      query.limit = value;
      return builder;
    });
    builder.offset = vi.fn((value: number) => {
      query.offset = value;
      return builder;
    });
    builder.orderBy = vi.fn(() => builder);
    queries.push(query);
    return builder;
  });
  const batch = vi.fn(async (_statements: unknown[]) => [
    [{ count: options.count }],
    options.rows,
  ]);

  return { db: { select, batch }, batch, queries };
}

const customerListRow = {
  id: "cust_list_1",
  name: "Buyer",
  email: null,
  phone: "+8801712345678",
  address: null,
  city: "city_nondeleted",
  zone: "zone_deleted",
  area: "area_missing",
  cityName: "Dhaka",
  zoneName: "zone_deleted",
  areaName: "area_missing",
  accountClaimedAt: null,
  totalOrders: 2,
  totalSpent: 250,
  lastOrderAt: 1_780_000_100,
  createdAt: 1_780_000_000,
  updatedAt: 1_780_000_200,
};

describe("admin customer list location projection", () => {
  it("resolves non-deleted location names and falls back for deleted or missing rows", async () => {
    const { db, batch, queries } = createListCustomersDb({
      count: 1,
      rows: [customerListRow],
    });

    const result = await listCustomers(db as never);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(result.customers[0]).toMatchObject({
      city: "city_nondeleted",
      cityName: "Dhaka",
      zone: "zone_deleted",
      zoneName: "zone_deleted",
      area: "area_missing",
      areaName: "area_missing",
    });

    const resultQuery = queries[1]!;
    expect(resultQuery.joins).toHaveLength(4);
    const dialect = new SQLiteSyncDialect();
    for (const [field, aliasName, idColumn] of [
      ["cityName", "customer_city_location", "city"],
      ["zoneName", "customer_zone_location", "zone"],
      ["areaName", "customer_area_location", "area"],
    ] as const) {
      const projectionSql = dialect.sqlToQuery(resultQuery.fields[field] as never).sql.toLowerCase();
      expect(projectionSql).toContain("coalesce");
      expect(projectionSql).toContain(`"${aliasName}"."name"`);
      expect(projectionSql).toContain(`"customers"."${idColumn}"`);
    }

    const locationJoinSql = resultQuery.joins.slice(1)
      .map((condition) => dialect.sqlToQuery(condition as never).sql.toLowerCase())
      .join(" ");
    expect(locationJoinSql).toContain('"customer_city_location"."deleted_at" is null');
    expect(locationJoinSql).toContain('"customer_zone_location"."deleted_at" is null');
    expect(locationJoinSql).toContain('"customer_area_location"."deleted_at" is null');
  });

  it("keeps the count and page window independent from paged location resolution", async () => {
    const { db, batch, queries } = createListCustomersDb({
      count: 25,
      rows: [customerListRow],
    });

    const result = await listCustomers(db as never, { page: 2, limit: 10 });

    expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(queries[0]?.joins).toHaveLength(0);
    expect(queries[1]).toMatchObject({ limit: 10, offset: 10 });
    expect(result.pagination).toEqual({
      total: 25,
      page: 2,
      limit: 10,
      totalPages: 3,
    });
  });
});

describe("admin customer commerce metrics", () => {
  it("derives lifetime value from paid value while retaining unpaid orders in the count", () => {
    const metrics = buildCustomerOrderMetricsProjection();
    const dialect = new SQLiteSyncDialect();
    const totalOrders = dialect.sqlToQuery(metrics.totalOrders);
    const totalSpent = dialect.sqlToQuery(metrics.totalSpent);

    expect(totalOrders.sql).toContain('count("orders"."id")');
    expect(totalSpent.sql).toContain('"orders"."paid_amount"');
    expect(totalSpent.sql).not.toContain('"orders"."total_amount"');
    expect(totalSpent.sql).not.toContain("partially_refunded");
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
  it("aliases the repeated price projection before saved minor-unit fields", () => {
    const projection = buildCustomerOrderItemDetailProjection();
    const dialect = new SQLiteSyncDialect();
    const unitPriceSql = dialect.sqlToQuery(projection.unitPrice.sql).sql;

    expect(unitPriceSql).toContain('"order_items"."price"');
    expect(projection.unitPrice.fieldAlias).toBe("unitPrice");
    expect(projection.price).not.toBe(projection.unitPrice);
    expect(Object.keys(projection).indexOf("unitPrice"))
      .toBeLessThan(Object.keys(projection).indexOf("unitPriceMinor"));
  });

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
      {
        status: OrderStatus.PARTIALLY_REFUNDED,
        paymentStatus: PaymentStatus.PARTIAL,
        totalAmount: 400,
        paidAmount: 250,
        balanceDue: 0,
      },
    ];

    expect(visibleOrders.reduce((sum, order) => sum + getCustomerSpendContribution(order), 0)).toBe(0);
    expect(summarizeCustomerAccountOrders(allOrders)).toEqual({
      totalOrders: 4,
      totalSpent: 750,
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
