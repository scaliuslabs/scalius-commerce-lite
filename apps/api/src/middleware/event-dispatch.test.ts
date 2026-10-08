// The post-write flush (COMMERCE-HOOKS H3): a mutating request that wrote an
// evented table hands its events to the queue after the response; reads and
// writes of other tables cost nothing.
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { conversations, orders, settings } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { eventDispatchMiddleware } from "./event-dispatch";

describe("eventDispatchMiddleware", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let app: Hono<{ Bindings: Env }>;
  const sendBatch = vi.fn(async () => undefined);
  const publish = vi.fn(async () => ({ sockets: 0 }));
  const env = {
    JOBS_QUEUE: { send: vi.fn(), sendBatch },
    REALTIME_HUB: { idFromName: () => ({}), get: () => ({ publish }) },
  } as unknown as Env;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sendBatch.mockClear();
    publish.mockClear();
    sqlite.exec(`INSERT INTO webhook_subscriptions (id, url, topics, api_version, secret_ciphertext, secret_hint)
      VALUES ('whs_1', 'https://hooks.example.com/x', '["*"]', '2026-10', 'enc:x:y', 'abcd')`);
    sqlite.exec("UPDATE webhook_subscriptions SET created_at = created_at - 60");
    app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.use("*", eventDispatchMiddleware);
    app.post("/orders", async (c) => {
      await db.insert(orders).values({
        id: "ord_mw",
        customerName: "Rahim",
        customerPhone: "+8801711111111",
        shippingAddress: "House 1",
        city: "city_1",
        zone: "zone_1",
      });
      return c.json({ ok: true });
    });
    app.post("/settings", async (c) => {
      await db.insert(settings).values({ id: "set_mw", key: "k", value: "v", type: "string", category: "test" });
      return c.json({ ok: true });
    });
    app.post("/inbox", async (c) => {
      await db.update(conversations).set({ status: "pending" }).where(eq(conversations.id, "cnv_missing_1"));
      return c.json({ ok: true });
    });
    app.post("/read", async (c) => {
      await db.select().from(orders).all();
      return c.json({ ok: true });
    });
    app.get("/orders", async (c) => c.json(await db.select().from(orders).all()));
  });
  afterEach(() => sqlite.close());

  async function request(method: string, path: string) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException() {} } as unknown as ExecutionContext;
    const response = await app.request(path, { method }, env, ctx);
    await Promise.all(pending);
    return { status: response.status, waited: pending.length };
  }

  it("flushes after a request that wrote an evented table, and tells the hub in one RPC", async () => {
    expect(await request("POST", "/orders")).toEqual({ status: 200, waited: 1 });
    expect(sendBatch).toHaveBeenCalledWith([{ body: { type: "events.dispatch", eventId: expect.stringMatching(/^evt_/) } }]);
    expect(sqlite.prepare("SELECT status FROM event_outbox").get()).toEqual({ status: "queued" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith([{ topic: "orders", kind: "order.created", id: "ord_mw", status: expect.any(String) }]);
  });

  it("sends a table-level notice for a realtime table without events, with no read", async () => {
    expect(await request("POST", "/inbox")).toEqual({ status: 200, waited: 1 });
    expect(publish).toHaveBeenCalledWith([{ topic: "inbox", kind: "changed" }]);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("does nothing for reads, or for writes to tables without events", async () => {
    expect(await request("POST", "/settings")).toEqual({ status: 200, waited: 0 });
    expect(await request("POST", "/read")).toEqual({ status: 200, waited: 0 });
    expect(await request("GET", "/orders")).toEqual({ status: 200, waited: 0 });
    expect(sendBatch).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
