// Catalogue jobs end to end on the real migrated schema: the queued
// projection rebuild walks the catalogue in keyset chunks and bumps the cache
// generation once at the end; recommendation refreshes store each product's
// list; the nightly pass refreshes sales stats and queues both.
import "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

const mocks = vi.hoisted(() => ({ bumpCacheGeneration: vi.fn(async () => undefined) }));
vi.mock("./cache-generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cache-generation")>()),
  bumpCacheGeneration: mocks.bumpCacheGeneration,
}));

import {
  CATALOG_PROJECTION_REBUILD_CHUNK,
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

describe("catalogue queue jobs", () => {
  it("rebuilds the projections chunk by chunk and bumps the generation once at the end", async () => {
    const { db, count } = seeded(CATALOG_PROJECTION_REBUILD_CHUNK + 5);
    const { queue, sent } = fakeQueue();
    const env = { JOBS_QUEUE: queue } as unknown as Env;
    mocks.bumpCacheGeneration.mockClear();

    await processCatalogQueueMessage({ type: "catalog.projections.rebuild", afterProductId: null }, db, env);
    expect(count("product_buyer_state")).toBe(CATALOG_PROJECTION_REBUILD_CHUNK);
    expect(sent).toEqual([{ type: "catalog.projections.rebuild", afterProductId: "prod_00899" }]);
    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();

    await processCatalogQueueMessage(sent[0]!, db, env);
    expect(count("product_buyer_state")).toBe(CATALOG_PROJECTION_REBUILD_CHUNK + 5);
    expect(sent).toHaveLength(1);
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledTimes(1);
  });

  it("stores recommendations for the products a message names, 20 per message", async () => {
    const { db, count } = seeded(30);
    await processCatalogQueueMessage({ type: "catalog.projections.rebuild", afterProductId: null }, db, { JOBS_QUEUE: fakeQueue().queue } as unknown as Env);
    const { queue, sent } = fakeQueue();
    const ids = Array.from({ length: 25 }, (_, index) => `prod_${String(index).padStart(5, "0")}`);
    await expect(enqueueRecommendationRefresh(queue, ids)).resolves.toBe(2);
    expect(sent.map((message) => message.type === "catalog.recommendations.refresh" && message.productIds.length)).toEqual([20, 5]);

    await processCatalogQueueMessage(sent[1]!, db, {} as Env);
    // Each of the 5 stores its top 24 of the 29 other public products.
    expect(count("product_recommendations")).toBe(5 * 24);
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
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 20, 0))).toBe(true);
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 20, 14, 59))).toBe(true);
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 20, 15))).toBe(false);
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 8, 0))).toBe(false);
    expect(isNightlyCatalogTick(undefined)).toBe(false);
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
  it("queues one rebuild per API version", async () => {
    const kv = new Map<string, string>();
    const cache = { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); } };
    const { queue, sent } = fakeQueue();
    const env = (id: string | undefined) => ({
      CACHE: cache,
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
    expect(kv.get(PROJECTIONS_REBUILT_FOR_VERSION_KEY)).toBe("v2");
  });
});

describe("POST /api/v1/admin/catalog/projections/rebuild", () => {
  it("rebuilds one chunk per call and bumps the generation when done", async () => {
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
    mocks.bumpCacheGeneration.mockClear();

    const first = await post({ limit: 3 });
    expect(first).toMatchObject({ status: 200, body: { data: { processed: 3, nextAfterProductId: "prod_00002", done: false } } });
    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
    const second = await post({ afterProductId: first.body.data.nextAfterProductId, limit: 3 });
    expect(second).toMatchObject({ status: 200, body: { data: { processed: 2, nextAfterProductId: null, done: true } } });
    expect(count("product_buyer_state")).toBe(5);
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledTimes(1);
    expect((await post({ limit: 0 })).status).toBe(400);
  });
});
