// Catalogue jobs end to end on the real migrated schema: the queued
// projection rebuild walks the catalogue in keyset chunks; transactional
// dependency triggers refresh only changed output; recommendation refreshes store each product's
// list; the nightly pass refreshes sales stats and queues both.
import "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";



import { PLAN_LIMITS, type WorkersPlan } from "@scalius/shared/plan-limits";
import {
  enqueueRecommendationRefresh,
  processCatalogQueueMessage,
  scheduleRecommendationRefreshAfterWrite,
  type CatalogQueueMessage,
} from "./catalog-jobs";
import {
  isNightlyCatalogTick,
  PROJECTIONS_REBUILT_FOR_VERSION_KEY,
  queuePostDeployProjectionRebuild,
  runNightlyCatalogMaintenance,
} from "../scheduled/catalog-projections";
import { adminCatalogProjectionRoutes } from "../routes/admin/catalog-projections";
import { errorResponseFromError } from "./api-response";

function seeded(products: number) {
  const harness = createSqliteD1Database();
  const insertProduct = harness.sqlite.prepare(
    "INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at) VALUES (?, ?, 10000, ?, 'cat_a', 1, ?)",
  );
  const insertSku = harness.sqlite.prepare(
    "INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES (?, ?, ?, 10000, 2, 1, 1)",
  );
  harness.sqlite.exec("INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'A', 'a', 'published')");
  for (let index = 0; index < products; index += 1) {
    const id = `prod_${String(index).padStart(5, "0")}`;
    insertProduct.run(id, `Product ${index}`, `product-${index}`, 1_700_000_000 + index);
    insertSku.run(`var_${id}`, id, `SKU-${index}`);
  }
  const count = (table: string) => (harness.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { ...harness, count };
}

function fakeQueue() {
  const sent: CatalogQueueMessage[] = [];
  return {
    sent,
    queue: {
      send: vi.fn(async (body: CatalogQueueMessage) => { sent.push(body); }),
      sendBatch: vi.fn(async (messages: Array<{ body: CatalogQueueMessage }>) => { sent.push(...messages.map((message) => message.body)); }),
    } as unknown as Queue,
  };
}

describe.each(["free", "paid"] as const satisfies readonly WorkersPlan[])("catalogue queue jobs on the %s profile", (plan) => {
  const limits = PLAN_LIMITS[plan].queue;
  beforeEach(() => { vi.stubGlobal("__SCALIUS_PLAN__", plan); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("rebuilds in chunks, advances dependencies for drift, and leaves unchanged output valid", async () => {
    const chunk = limits.catalogRebuildChunk;
    const { db, count, sqlite } = seeded(chunk + 5);
    const storeSeq = () => Number((sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = 'store'").get() as { seq: number } | undefined)?.seq ?? 0);
    const before = storeSeq();
    const { queue, sent } = fakeQueue();
    const env = { JOBS_QUEUE: queue } as unknown as Env;

    await processCatalogQueueMessage({ type: "catalog.projections.rebuild", afterProductId: null }, db, env);
    expect(count("product_buyer_state")).toBe(chunk);
    expect(storeSeq()).toBeGreaterThan(before);
    expect(sent).toEqual([{ type: "catalog.projections.rebuild", afterProductId: `prod_${String(chunk - 1).padStart(5, "0")}` }]);

    await processCatalogQueueMessage(sent[0]!, db, env);
    expect(count("product_buyer_state")).toBe(chunk + 5);
    expect(sent).toHaveLength(1);
    const unchanged = storeSeq();
    await processCatalogQueueMessage({ type: "catalog.projections.rebuild", afterProductId: null }, db, env);
    expect(storeSeq()).toBe(unchanged);
  });

  it("stores recommendations for the products a message names, as many per message as the plan allows", async () => {
    const { db, count } = seeded(30);
    await processCatalogQueueMessage({ type: "catalog.projections.rebuild", afterProductId: null }, db, { JOBS_QUEUE: fakeQueue().queue } as unknown as Env);
    const { queue, sent } = fakeQueue();
    const per = limits.recommendationProductsPerMessage;
    const ids = Array.from({ length: per + 5 }, (_, index) => `prod_${String(index).padStart(5, "0")}`);
    // The bulk lane has room for a page of messages; this is two.
    await expect(enqueueRecommendationRefresh(queue, ids)).resolves.toBe(2);
    expect(sent.map((message) => message.type === "catalog.recommendations.refresh" && message.productIds.length)).toEqual([per, 5]);

    await processCatalogQueueMessage(sent[1]!, db, {} as Env);
    // Each of the 5 stores its top 24 of the 29 other public products.
    expect(count("product_recommendations")).toBe(5 * 24);
  });

  it("enqueues no more recommendation messages than the bulk lane has room for, and none when it is full", async () => {
    const ids = Array.from({ length: limits.recommendationProductsPerMessage * (limits.bulkPageSize + 10) }, (_, index) => `prod_${index}`);
    const open = fakeQueue();
    (open.queue as unknown as { metrics: () => Promise<unknown> }).metrics = async () => ({ backlogCount: 0 });
    // One page at most per call, however many products ask.
    await expect(enqueueRecommendationRefresh(open.queue, ids)).resolves.toBe(limits.bulkPageSize);

    const nearlyFull = fakeQueue();
    (nearlyFull.queue as unknown as { metrics: () => Promise<unknown> }).metrics = async () => ({ backlogCount: limits.bulkBacklogLimit - 3 });
    await expect(enqueueRecommendationRefresh(nearlyFull.queue, ids)).resolves.toBe(Math.min(3, limits.bulkPageSize));

    const full = fakeQueue();
    (full.queue as unknown as { metrics: () => Promise<unknown> }).metrics = async () => ({ backlogCount: limits.bulkBacklogLimit });
    await expect(enqueueRecommendationRefresh(full.queue, ids)).resolves.toBe(0);
    expect(full.sent).toEqual([]);
  });

  it("schedules a write's recommendation targets off the request path, and never fails the write", async () => {
    const { db } = seeded(3);
    await processCatalogQueueMessage({ type: "catalog.projections.rebuild", afterProductId: null }, db, { JOBS_QUEUE: fakeQueue().queue } as unknown as Env);
    const { queue, sent } = fakeQueue();
    const pending: Promise<unknown>[] = [];
    const executionCtx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
    scheduleRecommendationRefreshAfterWrite({ env: { JOBS_QUEUE: queue } as unknown as Env, executionCtx }, db, ["prod_00001"]);
    await Promise.all(pending);
    expect(sent).toEqual([{
      type: "catalog.recommendations.refresh",
      productIds: expect.arrayContaining(["prod_00000", "prod_00001", "prod_00002"]),
    }]);

    const failing = { send: vi.fn(), sendBatch: vi.fn(async () => { throw new Error("queue down"); }) } as unknown as Queue;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    scheduleRecommendationRefreshAfterWrite({ env: { JOBS_QUEUE: failing } as unknown as Env, executionCtx }, db, ["prod_00001"]);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    warn.mockRestore();
  });
});

describe("nightly catalogue maintenance", () => {
  it("runs on the first tick of the night only", () => {
    // 02:00 in Dhaka is 20:00 UTC.
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 20, 0), "Asia/Dhaka")).toBe(true);
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 20, 14, 59), "Asia/Dhaka")).toBe(true);
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 20, 15), "Asia/Dhaka")).toBe(false);
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 8, 0), "Asia/Dhaka")).toBe(false);
    expect(isNightlyCatalogTick(undefined, "Asia/Dhaka")).toBe(false);
  });

  it("runs at the store's 02:00, daylight saving included", () => {
    // New York: 02:00 EDT is 06:00 UTC; 02:00 EST is 07:00 UTC.
    expect(isNightlyCatalogTick(Date.UTC(2026, 6, 1, 6, 0), "America/New_York")).toBe(true);
    expect(isNightlyCatalogTick(Date.UTC(2026, 0, 15, 7, 0), "America/New_York")).toBe(true);
    expect(isNightlyCatalogTick(Date.UTC(2026, 0, 15, 6, 0), "America/New_York")).toBe(false);
    // 8 March 2026 skips 02:00: the night runs at 03:00 EDT (07:00 UTC).
    expect(isNightlyCatalogTick(Date.UTC(2026, 2, 8, 7, 0), "America/New_York")).toBe(true);
  });

  it("refreshes sales stats, queues the rebuild and the never-computed recommendation lists", async () => {
    const { db, sqlite } = seeded(3);
    await processCatalogQueueMessage({ type: "catalog.projections.rebuild", afterProductId: null }, db, { JOBS_QUEUE: fakeQueue().queue } as unknown as Env);
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at)
      VALUES ('ord_1', 'A', '01711000001', 'Road', 'c', 'z', 'confirmed', ${now - 60}, ${now - 60});
      INSERT INTO order_items (id, order_id, product_id, quantity) VALUES ('line_1', 'ord_1', 'prod_00002', 4);
    `);
    const { queue, sent } = fakeQueue();
    const result = await runNightlyCatalogMaintenance(db, { JOBS_QUEUE: queue } as unknown as Env, Date.now());

    expect(result).toEqual({ salesStatsProducts: 1, recommendationMessages: 1, rebuildQueued: true });
    expect(sqlite.prepare("SELECT product_id, sold_30d FROM product_sales_stats").all()).toEqual([{ product_id: "prod_00002", sold_30d: 4 }]);
    expect(sent[0]).toEqual({ type: "catalog.projections.rebuild", afterProductId: null });
    // Sold today first, then the never-computed lists.
    expect(sent[1]).toEqual({ type: "catalog.recommendations.refresh", productIds: ["prod_00002", "prod_00000", "prod_00001"] });
  });
});

describe("post-deploy projection rebuild", () => {
  const marker = (sqlite: ReturnType<typeof createSqliteD1Database>["sqlite"]) =>
    (sqlite.prepare("SELECT value FROM system_kv WHERE key = ?").get(PROJECTIONS_REBUILT_FOR_VERSION_KEY) as { value?: string } | undefined)?.value;

  it("queues one rebuild per API version", async () => {
    const { sqlite, binding } = createSqliteD1Database();
    const { queue, sent } = fakeQueue();
    const env = (id: string | undefined) => ({
      DB: binding,
      JOBS_QUEUE: queue,
      CF_VERSION_METADATA: id ? { id, tag: "", timestamp: "" } : undefined,
    }) as unknown as Env;

    await expect(queuePostDeployProjectionRebuild(env("v1"))).resolves.toBe(true);
    await expect(queuePostDeployProjectionRebuild(env("v1"))).resolves.toBe(false);
    await expect(queuePostDeployProjectionRebuild(env("v2"))).resolves.toBe(true);
    await expect(queuePostDeployProjectionRebuild(env(undefined))).resolves.toBe(false);
    expect(sent).toEqual([
      { type: "catalog.projections.rebuild", afterProductId: null },
      { type: "catalog.projections.rebuild", afterProductId: null },
    ]);
    expect(marker(sqlite)).toBe("v2");
  });

  it("releases the claim when the queue rejects the rebuild, so the next tick retries", async () => {
    const { sqlite, binding } = createSqliteD1Database();
    const version = { id: "v9", tag: "", timestamp: "" };
    const failing = { send: async () => { throw new Error("queue down"); }, sendBatch: async () => undefined };
    const down = { DB: binding, JOBS_QUEUE: failing, CF_VERSION_METADATA: version } as unknown as Env;
    await expect(queuePostDeployProjectionRebuild(down)).resolves.toBe(false);
    expect(marker(sqlite)).toBeUndefined();

    const { queue, sent } = fakeQueue();
    const up = { DB: binding, JOBS_QUEUE: queue, CF_VERSION_METADATA: version } as unknown as Env;
    await expect(queuePostDeployProjectionRebuild(up)).resolves.toBe(true);
    expect(sent).toEqual([{ type: "catalog.projections.rebuild", afterProductId: null }]);
  });
});

describe("POST /api/v1/admin/catalog/projections/rebuild", () => {
  it("rebuilds one chunk per call and reports completion", async () => {
    const { db, count } = seeded(5);
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/admin/catalog", adminCatalogProjectionRoutes);
    const post = async (body: unknown) => {
      const response = await app.request("/api/v1/admin/catalog/projections/rebuild", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, {} as Env);
      return { status: response.status, body: await response.json() as { data: { processed: number; nextAfterProductId: string | null; done: boolean } } };
    };

    const first = await post({ limit: 3 });
    expect(first).toMatchObject({ status: 200, body: { data: { processed: 3, nextAfterProductId: "prod_00002", done: false } } });
    const second = await post({ afterProductId: first.body.data.nextAfterProductId, limit: 3 });
    expect(second).toMatchObject({ status: 200, body: { data: { processed: 2, nextAfterProductId: null, done: true } } });
    expect(count("product_buyer_state")).toBe(5);
    expect((await post({ limit: 0 })).status).toBe(400);
  });
});
