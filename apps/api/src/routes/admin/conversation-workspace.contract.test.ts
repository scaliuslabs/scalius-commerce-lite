import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getOrCreateOrderThread } from "@scalius/core/modules/conversations";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorResponseFromError } from "../../utils/api-response";
import { ValidationError } from "../../utils/api-error";
import { adminConversationRoutes } from "./conversations";

const catalog = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock("../../utils/conversation-products", () => ({
  validateConversationProductRefs: catalog.validate,
  hydrateConversationProducts: async (_db: unknown, thread: unknown) => thread,
  projectConversationProductCards: async () => [],
}));

let sqlite: DatabaseSync;
let db: Database;
const base = "/api/v1/admin/conversations";
const products = [{ productId: "product_1", skuId: "sku_1" }];
beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO user(id,name,email,email_verified,role,is_super_admin) VALUES
      ('staff_1','Nadia','nadia@example.test',1,'admin',0);
    INSERT INTO orders(id,customer_name,customer_phone,shipping_address,city,zone,total_amount_minor,subtotal_amount_minor,status)
      VALUES('order_1','Buyer','+8801711111111','House','c','z',1000,1000,'confirmed');
  `);
  catalog.validate.mockReset().mockResolvedValue([{ ...products[0], title: "Shirt", variantLabel: null }]);
});
afterEach(() => sqlite.close());

function request(method: string, path: string, body?: unknown) {
  const app = new OpenAPIHono<{ Bindings: Env }>();
  app.use("*", async (c, next) => { c.set("db", db); c.set("user" as never, { id: "staff_1" } as never); await next(); });
  app.onError((error, c) => { const result = errorResponseFromError(error); return c.json(result.body, result.status); });
  app.route(base, adminConversationRoutes);
  return app.request(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }, {} as Env);
}

describe("workspace API contracts", () => {
  it("accepts card-only replies and replays before revalidating a now-unavailable SKU", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    const body = { products, visibility: "public", requestKey: "card-retry" };
    expect((await request("POST", `/${thread.id}/messages`, body)).status).toBe(201);
    catalog.validate.mockRejectedValue(new ValidationError("Product no longer published"));
    expect((await request("POST", `/${thread.id}/messages`, body)).status).toBe(201);
    expect(catalog.validate).toHaveBeenCalledTimes(1);
    expect((await request("POST", `/${thread.id}/messages`, { ...body, body: "Changed" })).status).toBe(409);
    expect(sqlite.prepare("SELECT count(*) AS n FROM conversation_messages").get()).toEqual({ n: 1 });
  });

  it("keeps order facts private without orders.view, while preserving support history", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    await request("POST", `/${thread.id}/messages`, { body: "Hello", visibility: "public", requestKey: "text" });
    const response = await request("GET", `/${thread.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { conversation: { order: null, cases: [], messages: [{ body: "Hello" }] } } });
    const context = await request("GET", `/${thread.id}/context`);
    expect(await context.json()).toMatchObject({ data: { customer: null, recentOrders: null, customerDenied: true, ordersDenied: true } });
  });

  it("searches private content through bodies, and rejects conflicting timeline windows", async () => {
    const thread = await getOrCreateOrderThread(db, "order_1");
    await request("POST", `/${thread.id}/messages`, { body: "Private question", visibility: "public", requestKey: "search" });
    const found = await request("POST", "/query", { q: "question", status: "all" });
    expect(found.status).toBe(200);
    expect(found.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await found.json()).toMatchObject({ data: { items: [{ id: thread.id }], scanExhausted: true } });
    const hit = await request("POST", `/${thread.id}/search`, { q: "question" });
    expect(await hit.json()).toMatchObject({ data: { items: [{ seq: 1 }] } });
    expect((await request("GET", `/${thread.id}?beforeSeq=2&aroundSeq=1`)).status).toBe(400);
    for (const path of ["/query", `/${thread.id}/search`]) {
      expect(getRoutePermission(`${base}${path}`, "POST")).toEqual({ permission: "conversations.view" });
    }
    expect(getRoutePermission(`${base}/assignees`, "GET")).toEqual({ permission: "conversations.reply" });
  });
});
