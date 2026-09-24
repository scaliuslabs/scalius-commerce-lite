import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { customerSessions, customers, OrderStatus, PaymentStatus } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

import {
  bulkDeleteCustomers,
  buildCustomerOrderMetricsProjection,
  buildCustomerOrderItemDetailProjection,
  customerAccountOrderVisibilityCondition,
  buildCustomerOrderTracking,
  customerOrderStatusLabel,
  decodeCustomerOrdersCursor,
  deleteCustomer,
  encodeCustomerOrdersCursor,
  getCustomerOrderDetail,
  getCustomerOrders,
  getCustomerVisibleBalanceDueMinor,
  listCustomers,
  permanentlyDeleteCustomer,
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
  totalSpentMinor: 25_000,
  spendDecimalPlaces: 2,
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
      totalSpent: 250,
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
    const totalSpent = dialect.sqlToQuery(metrics.totalSpentMinor);

    expect(totalOrders.sql).toContain('count("orders"."id")');
    expect(totalSpent.sql).toContain('"orders"."paid_amount_minor"');
    expect(totalSpent.sql).not.toContain('"orders"."total_amount_minor"');
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
  it("hides actionable balance due for closed or refunded customer-visible states", () => {
    for (const status of [
      OrderStatus.CANCELLED,
      OrderStatus.RETURNED,
      OrderStatus.REFUNDED,
      OrderStatus.PARTIALLY_REFUNDED,
    ]) {
      expect(getCustomerVisibleBalanceDueMinor({
        status,
        paymentStatus: PaymentStatus.UNPAID,
        balanceDueMinor: 100,
      })).toBe(0);
    }

    expect(getCustomerVisibleBalanceDueMinor({
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.REFUNDED,
      balanceDueMinor: 100,
    })).toBe(0);

    expect(getCustomerVisibleBalanceDueMinor({
      status: OrderStatus.PENDING,
      paymentStatus: PaymentStatus.FAILED,
      balanceDueMinor: 100,
    })).toBe(0);
  });

  it("keeps stored active balances", () => {
    expect(getCustomerVisibleBalanceDueMinor({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PARTIAL,
      balanceDueMinor: 60,
    })).toBe(60);

    expect(getCustomerVisibleBalanceDueMinor({
      status: OrderStatus.INCOMPLETE,
      paymentStatus: PaymentStatus.FAILED,
      balanceDueMinor: 100,
    })).toBe(100);
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

  it("tracks an order in buyer words: one step tracker and a dated list, newest first", () => {
    const at = (timestamp: number) => new Date(timestamp * 1000).toISOString();
    const { progress, timeline } = buildCustomerOrderTracking({
      order: { id: "order_1", status: OrderStatus.SHIPPED, createdAt: 1_780_000_000 },
      statusEvents: [
        { notificationType: "order_created", createdAt: 1_780_000_000 },
        { notificationType: "order_confirmed", createdAt: 1_780_000_600 },
        { notificationType: "order_processing", createdAt: 1_780_000_900 },
        { notificationType: "order_shipped", createdAt: 1_780_003_600 },
        { notificationType: "support_request_submitted", createdAt: 1_780_000_700 },
      ],
      shipments: [{ createdAt: at(1_780_003_000), providerName: "Steadfast", courierName: null }],
      payments: [
        { id: "pay_pending", status: "pending", createdAt: at(1_780_000_000), updatedAt: null },
        { id: "pay_ok", status: "confirmed", createdAt: at(1_780_000_100), updatedAt: at(1_780_000_200) },
      ],
      refunds: [],
      requests: [],
    });

    expect(progress).toEqual({
      steps: [
        { key: "placed", label: "Order placed", done: true, happenedAt: at(1_780_000_000) },
        { key: "confirmed", label: "Confirmed", done: true, happenedAt: at(1_780_000_600) },
        { key: "shipped", label: "On its way", done: true, happenedAt: at(1_780_003_600) },
        { key: "delivered", label: "Delivered", done: false, happenedAt: null },
      ],
      outcome: null,
    });
    expect(timeline.map(({ label, details, happenedAt }) => ({ label, details, happenedAt }))).toEqual([
      { label: "On its way", details: "With Steadfast.", happenedAt: at(1_780_003_600) },
      { label: "Confirmed", details: "The store confirmed your order.", happenedAt: at(1_780_000_600) },
      { label: "Payment received", details: null, happenedAt: at(1_780_000_200) },
      { label: "Order placed", details: "We received your order.", happenedAt: at(1_780_000_000) },
    ]);
    expect(JSON.stringify(timeline)).not.toMatch(/notification|Accepted|Current status/i);
  });

  it("replaces the tracker with the outcome of a cancelled order and keeps reached steps", () => {
    const at = (timestamp: number) => new Date(timestamp * 1000).toISOString();
    const { progress, timeline } = buildCustomerOrderTracking({
      order: { id: "order_2", status: OrderStatus.CANCELLED, createdAt: 1_780_000_000 },
      statusEvents: [
        { notificationType: "order_confirmed", createdAt: 1_780_000_600 },
        { notificationType: "order_cancelled", createdAt: 1_780_001_200 },
      ],
      shipments: [],
      payments: [],
      refunds: [],
      requests: [{
        id: "req_1",
        status: "approved",
        label: "Cancellation request approved",
        reason: "Ordered by mistake",
        submittedAt: at(1_780_000_900),
        updatedAt: null,
        createdAt: null,
      }],
    });

    expect(progress.outcome).toEqual({ key: "cancelled", label: "Cancelled", happenedAt: at(1_780_001_200) });
    expect(progress.steps.map((step) => step.done)).toEqual([true, true, false, false]);
    expect(timeline.map((event) => event.label)).toEqual([
      "Cancelled",
      "Cancellation request approved",
      "Confirmed",
      "Order placed",
    ]);
    expect(customerOrderStatusLabel(OrderStatus.PROCESSING)).toBe("Confirmed");
    expect(customerOrderStatusLabel(OrderStatus.COMPLETED)).toBe("Delivered");
    expect(customerOrderStatusLabel(OrderStatus.INCOMPLETE)).toBe("Awaiting payment");
  });
});

describe("customer account order reads (SQLite)", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(async () => {
    ({ sqlite, db } = createSqliteD1Database());
    await db.insert(customers).values({ id: "account_1", name: "Buyer", email: "buyer@example.com", phone: "+8801722222222" });
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, city_name, zone_name,
        total_amount_minor, balance_due_minor, status, account_owner_customer_id, created_at, updated_at)
      VALUES
        ('order_open', 'Recipient Name', '+8801711111111', 'House 1, Road 2', 'city_1', 'zone_1', 'Dhaka', 'Mirpur',
          58000, 58000, 'confirmed', 'account_1', 1780000000, 1780000600),
        ('order_quiet', 'Buyer', '+8801722222222', 'House 3', 'city_1', 'zone_1', 'Dhaka', 'Mirpur',
          50000, 50000, 'pending', 'account_1', 1780000100, 1780000100);
      INSERT INTO order_notification_outbox (id, dedupe_key, order_id, notification_type, source, payload, created_at, updated_at)
      VALUES ('outbox_1', 'dedupe_1', 'order_open', 'order_confirmed', 'test', '{}', 1780000600, 1780000600);
      INSERT INTO order_notification_delivery_receipts (id, receipt_key, outbox_id, order_id, notification_type, channel,
        provider, recipient_hash, status, accepted_at, created_at, updated_at)
      VALUES ('receipt_1', 'receipt_key_1', 'outbox_1', 'order_open', 'order_confirmed', 'email', 'resend', 'hash',
        'accepted', 1780000610, 1780000610, 1780000610);
      INSERT INTO order_support_requests (id, order_id, customer_id, type, status, reason, active_key)
      VALUES ('req_open', 'order_open', 'account_1', 'cancel_pre_shipment', 'submitted', 'Ordered by mistake', 'order:order_open');
    `);
  });

  afterEach(() => sqlite.close());

  it("flags an open request and labels each order in buyer words", async () => {
    const { orders: rows } = await getCustomerOrders(db, "account_1");
    expect(rows.map(({ id, statusLabel, openSupportRequestType }) => ({ id, statusLabel, openSupportRequestType }))).toEqual([
      { id: "order_quiet", statusLabel: "Order placed", openSupportRequestType: null },
      { id: "order_open", statusLabel: "Confirmed", openSupportRequestType: "cancel_pre_shipment" },
    ]);
  });

  it("returns the recipient, the step tracker and status history without provider delivery receipts", async () => {
    const detail = await getCustomerOrderDetail(db, "account_1", "order_open");
    expect(detail.order).toMatchObject({
      customerName: "Recipient Name",
      customerPhone: "+8801711111111",
      statusLabel: "Confirmed",
    });
    expect(detail.progress.steps.map((step) => [step.key, step.done])).toEqual([
      ["placed", true], ["confirmed", true], ["shipped", false], ["delivered", false],
    ]);
    expect(detail.progress.steps[1]?.happenedAt).toBe(new Date(1_780_000_600 * 1000).toISOString());
    expect(detail.timeline.map((event) => event.label)).toEqual([
      "Cancellation request submitted",
      "Confirmed",
      "Order placed",
    ]);
    expect(detail).not.toHaveProperty("notifications");
    expect(JSON.stringify(detail)).not.toMatch(/Accepted|resend/);
  });
});
