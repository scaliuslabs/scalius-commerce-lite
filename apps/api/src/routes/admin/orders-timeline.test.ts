import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { encodeListCursor } from "@scalius/shared/pagination";
import { listOrderTimeline } from "@scalius/core/modules/orders";
import type { Database } from "@scalius/database/client";
import { errorResponseFromError } from "../../utils/api-response";
import { adminOrdersRoutes } from "./orders";

type Page = { events: Array<{ id: string; kind: string; own: boolean; body: string | null; actorName: string | null }>; nextCursor: string | null };

describe("order timeline cursor HTTP contract", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let app: OpenAPIHono<{ Bindings: Env }>;
  const env = {} as Env;
  beforeEach(() => {
    const created = createSqliteD1Database();
    sqlite = created.sqlite;
    db = created.db;
    sqlite.exec(`
      INSERT INTO user (id,name,email) VALUES ('staff','Staff','staff@example.test');
      INSERT INTO places (id,name,country_code,level,parent_id,external_ids,metadata,is_active)
      VALUES ('city','Dhaka','BD',1,NULL,'{}','{}',1),('zone','North','BD',2,'city','{}','{}',1);
      INSERT INTO orders (id,order_number,customer_name,customer_phone,shipping_address,city,zone,
        city_name,zone_name,shipping_country_code,shipping_locality,shipping_dependent_locality,
        total_amount_minor,balance_due_minor,status,payment_method,payment_status,version,created_at)
      VALUES ('order_a',1001,'Fixture','+8801712345601','Fixture','city','zone','Dhaka','North','BD','Dhaka','North',100,100,'pending','cod','unpaid',1,1700000000),
        ('order_b',1002,'Fixture','+8801712345602','Fixture','city','zone','Dhaka','North','BD','Dhaka','North',100,100,'pending','cod','unpaid',1,1700000000);
    `);
    app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.use("*", async (c, next) => { c.set("db", created.db); c.set("user", { id: "staff" } as never); await next(); });
    app.route("/orders", adminOrdersRoutes);
    app.onError((error, c) => { const { body, status } = errorResponseFromError(error); return c.json(body, status as never); });
  });
  afterEach(() => sqlite.close());
  function seed(count: number) {
    const statement = sqlite.prepare("INSERT INTO order_events (id,order_id,kind,body,actor_id,created_at) VALUES (?,'order_a','comment',?,'staff',1700000100)");
    for (let i = 1; i <= count; i++) statement.run(`evt_${String(i).padStart(4, "0")}`, `Note ${i}`);
  }
  async function page(cursor?: string, order = "order_a"): Promise<Page> {
    const response = await app.request(`/api/v1/admin/orders/${order}/timeline${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`, {}, env);
    expect(response.status).toBe(200);
    return (await response.json() as { data: Page }).data;
  }
  const post = () => app.request("/api/v1/admin/orders/order_a/timeline", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "timeline-replay-0001" },
    body: JSON.stringify({ body: "Original note" }),
  }, env);

  it("walks all 205 tied events without repeats or a false placed marker and filters app facts", async () => {
    seed(205);
    sqlite.exec("INSERT INTO order_events (id,order_id,kind,created_at) VALUES ('fact','order_a','app_risk',1700000101)");
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const current = await page(cursor);
      const actual = current.events.filter((event) => event.kind !== "placed");
      expect(actual.length).toBeLessThanOrEqual(50);
      expect(current.events.filter((event) => event.kind === "placed")).toHaveLength(current.nextCursor !== null ? 0 : 1);
      expect(actual.every((event) => event.own && event.actorName === "Staff")).toBe(true);
      seen.push(...actual.map((event) => event.id));
      cursor = current.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 205 }, (_, i) => `evt_${String(205 - i).padStart(4, "0")}`));
    expect(new Set(seen).size).toBe(205);
  });

  it.each([0, 50, 51])("places the final marker correctly at the %i-event boundary", async (count) => {
    seed(count);
    const first = await page();
    expect(first.nextCursor !== null).toBe(count > 50);
    expect(first.events.at(-1)?.kind === "placed").toBe(count <= 50);
    if (first.nextCursor) expect((await page(first.nextCursor)).events.at(-1)?.id).toBe("placed_order_a");
  });

  it("rejects malformed, wrong-order, wrong-sort and fractional cursors with typed 400", async () => {
    seed(51);
    const good = (await page()).nextCursor!;
    const fractional = encodeListCursor({ sort: "orderTimeline", direction: "desc", values: [1700000100.5, "order_a"], id: "evt_0002" });
    const wrongSort = encodeListCursor({ sort: "other", direction: "desc", values: [1700000100, "order_a"], id: "evt_0002" });
    for (const [orderId, cursor] of [["order_a", "bad"], ["order_a", ""], ["order_b", good], ["order_a", fractional], ["order_a", wrongSort]]) {
      const response = await app.request(`/api/v1/admin/orders/${orderId}/timeline?cursor=${encodeURIComponent(cursor!)}`, {}, env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });
    }
  });

  it("continues from a deleted boundary and does not repeat a new head event", async () => {
    seed(105);
    const first = await page();
    sqlite.prepare("DELETE FROM order_events WHERE id=?").run(first.events.at(-1)!.id);
    sqlite.exec("INSERT INTO order_events (id,order_id,kind,body,created_at) VALUES ('new_head','order_a','comment','New',1700000200)");
    const second = await page(first.nextCursor!);
    expect(second.events[0]!.id).toBe("evt_0055");
    expect(second.events.some((event) => event.id === "new_head")).toBe(false);
    expect(second.events.some((event) => first.events.some((old) => old.id === event.id))).toBe(false);
  });

  it("preserves 404 and the small legacy projection without claiming a truncated history is complete", async () => {
    expect((await app.request("/api/v1/admin/orders/missing/timeline", {}, env)).status).toBe(404);
    seed(2);
    expect((await listOrderTimeline(db, "order_a", "staff")).map((event) => event.id)).toEqual(["evt_0002", "evt_0001", "placed_order_a"]);
    sqlite.exec("DELETE FROM order_events WHERE order_id='order_a'"); seed(205);
    const capped = await listOrderTimeline(db, "order_a", "staff");
    expect(capped).toHaveLength(200); expect(capped.some((event) => event.kind === "placed")).toBe(false);
  });

  it("replays the exact original comment even after it leaves the old 200-event cap", async () => {
    const first = await post();
    expect(first.status).toBe(201);
    const original = await first.json() as { data: { id: string } };
    sqlite.prepare("UPDATE order_events SET created_at=1700000001 WHERE id=?").run(original.data.id);
    seed(250);
    const replay = await post();
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ data: { id: original.data.id, own: true, body: "Original note" } });
    expect(sqlite.prepare("SELECT count(*) AS total FROM order_events WHERE body='Original note'").get()).toEqual({ total: 1 });
  });
});
