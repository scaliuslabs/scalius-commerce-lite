import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { adminCustomerRoutes } from "./customers";

function createApp() {
  const { sqlite, db } = createSqliteD1Database();
  const customer = sqlite.prepare("INSERT INTO customers (id, name, phone) VALUES (?, 'Buyer', ?)");
  customer.run("cus_1", "+8801700000000");
  customer.run("cus_other", "+8801700000001");
  const history = sqlite.prepare(`INSERT INTO customer_history
    (id, customer_id, name, phone, change_type, created_at) VALUES (?, ?, 'Buyer', '+8801700000000', 'updated', ?)`);
  for (let index = 0; index < 23; index += 1) history.run(`hist_${index}`, "cus_1", 1_700_000_000 + index);
  history.run("hist_other", "cus_other", 1_700_000_000);
  const order = sqlite.prepare(`INSERT INTO orders (
    id, customer_id, customer_name, customer_phone, shipping_address, city, zone,
    total_amount, shipping_charge, payment_method, status, payment_status,
    paid_amount, balance_due, currency_code, currency_decimal_places, created_at, updated_at, deleted_at
  ) VALUES (?, ?, 'Buyer', '+8801700000000', 'Address', 'city', 'zone',
    100, 0, 'cod', 'pending', 'unpaid', 0, 100, 'BDT', 2, ?, ?, ?)`);
  for (let index = 0; index < 7; index += 1) {
    order.run(`ord_${index}`, "cus_1", 1_700_000_000 + index, 1_700_000_000 + index, index === 6 ? 1_700_000_100 : null);
  }
  order.run("ord_other", "cus_other", 1_700_000_000, 1_700_000_000, null);

  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/customers", adminCustomerRoutes);
  return app;
}

type HistoryBody = {
  data: {
    history: Array<{ id: string }>;
    orders: Array<{ id: string }>;
    pagination: Record<"history" | "orders", { total: number; totalPages: number; hasNextPage: boolean }>;
  };
};

describe("customer history read boundaries", () => {
  it("pages history and live orders independently with honest totals", async () => {
    const app = createApp();
    const first = await app.request("/api/v1/admin/customers/cus_1/history");
    expect(first.status).toBe(200);
    const { data } = await first.json() as HistoryBody;
    expect(data.history.map((row) => row.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `hist_${22 - index}`),
    );
    expect(data.orders.map((row) => row.id)).toEqual(["ord_5", "ord_4", "ord_3", "ord_2", "ord_1"]);
    expect(data.pagination.history).toMatchObject({ total: 23, totalPages: 2, hasNextPage: true });
    expect(data.pagination.orders).toMatchObject({ total: 6, totalPages: 2, hasNextPage: true });

    const last = await (await app.request(
      "/api/v1/admin/customers/cus_1/history?historyPage=2&ordersPage=2",
    )).json() as HistoryBody;
    expect(last.data.history.map((row) => row.id)).toEqual(["hist_2", "hist_1", "hist_0"]);
    expect(last.data.orders.map((row) => row.id)).toEqual(["ord_0"]);
    expect(last.data.pagination.history.hasNextPage).toBe(false);
    expect(last.data.pagination.orders.hasNextPage).toBe(false);
  });

  it.each(["historyLimit=51", "ordersLimit=26", "historyLimit=0"])(
    "rejects unbounded page size %s",
    async (query) => {
      const response = await createApp().request(`/api/v1/admin/customers/cus_1/history?${query}`);
      expect(response.status).toBe(400);
    },
  );
});
