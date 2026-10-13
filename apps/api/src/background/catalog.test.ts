// Catalogue background work end to end on the real migrated schema: the
// projection rebuild walks the catalogue in keyset chunks from a durable
// cursor (`system_kv`); transactional dependency triggers refresh only
// changed output; the recommendation rotation visits every public product in
// turn from its own cursor; a catalogue write refreshes its targets right
// after the response; the nightly pass refreshes sales stats, requests the
// rebuild and refreshes the products sold that day.
import "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PLAN_LIMITS, type WorkersPlan } from "@scalius/shared/plan-limits";
import {
  PROJECTION_REBUILD_CURSOR_KEY,
  RECOMMENDATION_ROTATION_CURSOR_KEY,
  drainCatalogProjectionRebuild,
  rebuildCatalogProjectionsAfterWrite,
  refreshRecommendationsAfterWrite,
  requestCatalogProjectionRebuild,
  rotateRecommendations,
} from "./catalog";
import {
  isNightlyCatalogTick,
  PROJECTIONS_REBUILT_FOR_VERSION_KEY,
  requestPostDeployProjectionRebuild,
  runNightlyCatalogMaintenance,
} from "../scheduled/catalog-projections";
import { adminCatalogProjectionRoutes } from "../routes/admin/catalog-projections";
import { errorResponseFromError } from "../utils/api-response";

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
  const kv = (key: string) => (harness.sqlite.prepare("SELECT value FROM system_kv WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
  return { ...harness, count, kv };
}

/** Builds the projections once (the rotation and refreshes read them). */
async function project(db: ReturnType<typeof seeded>["db"]) {
  await requestCatalogProjectionRebuild(db);
  while (await drainCatalogProjectionRebuild(db) > 0) { /* until done */ }
}

describe.each(["free", "paid"] as const satisfies readonly WorkersPlan[])("catalogue background work on the %s profile", (plan) => {
  const limits = PLAN_LIMITS[plan].background;
  beforeEach(() => { vi.stubGlobal("__SCALIUS_PLAN__", plan); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("rebuilds in chunks from its cursor, advances dependencies for drift, and leaves unchanged output valid", async () => {
    const chunk = limits.catalogRebuildChunk;
    const perDrain = limits.catalogRebuildChunksPerDrain;
    const { db, count, sqlite, kv } = seeded(chunk * perDrain + 5);
    const storeSeq = () => Number((sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = 'store'").get() as { seq: number } | undefined)?.seq ?? 0);
    const before = storeSeq();

    // No request: nothing runs.
    await expect(drainCatalogProjectionRebuild(db)).resolves.toBe(0);
    await requestCatalogProjectionRebuild(db);
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBe("");

    await expect(drainCatalogProjectionRebuild(db)).resolves.toBe(chunk * perDrain);
    expect(count("product_buyer_state")).toBe(chunk * perDrain);
    expect(storeSeq()).toBeGreaterThan(before);
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBe(`prod_${String(chunk * perDrain - 1).padStart(5, "0")}`);

    await expect(drainCatalogProjectionRebuild(db)).resolves.toBe(5);
    expect(count("product_buyer_state")).toBe(chunk * perDrain + 5);
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBeUndefined();

    const unchanged = storeSeq();
    await project(db);
    expect(storeSeq()).toBe(unchanged);
  }, 60_000); // A Paid drain recomputes 9,000 seeded products.

  it("keeps a rebuild requested while a chunk runs instead of overwriting it", async () => {
    const { db, kv, sqlite } = seeded(limits.catalogRebuildChunk + 5);
    // Mid-rebuild, then a new request lands while the next chunk writes.
    sqlite.prepare("INSERT INTO system_kv (key, value) VALUES (?, 'prod_00000')").run(PROJECTION_REBUILD_CURSOR_KEY);
    sqlite.exec(`CREATE TEMP TRIGGER request_mid_chunk AFTER INSERT ON product_buyer_state BEGIN
      UPDATE system_kv SET value = '' WHERE key = '${PROJECTION_REBUILD_CURSOR_KEY}';
    END`);
    await drainCatalogProjectionRebuild(db);
    sqlite.exec("DROP TRIGGER request_mid_chunk");
    // The drain saved nothing over the request: the next drain starts again from the start.
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBe("");
  });

  it("rotates through every public product in id order, wrapping, without repeating a product in one lap", async () => {
    const products = limits.recommendationRotationPerRun * 3 + 1;
    const { db, kv, sqlite } = seeded(products);
    await project(db);
    // A product that is not public is never visited.
    sqlite.exec("UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'prod_00001'");
    const visited: string[] = [];
    const laps = Math.ceil((products - 1) / limits.recommendationRotationPerRun);
    for (let run = 0; run < laps; run += 1) {
      const before = kv(RECOMMENDATION_ROTATION_CURSOR_KEY) ?? "";
      const refreshed = await rotateRecommendations(db);
      expect(refreshed).toBe(limits.recommendationRotationPerRun);
      const after = kv(RECOMMENDATION_ROTATION_CURSOR_KEY)!;
      const ids = (sqlite.prepare("SELECT product_id AS id FROM product_buyer_state WHERE is_public = 1 ORDER BY product_id").all() as Array<{ id: string }>).map((row) => row.id);
      const start = before ? ids.indexOf(before) + 1 : 0;
      for (let step = 0; step < refreshed; step += 1) visited.push(ids[(start + step) % ids.length]!);
      expect(visited.at(-1)).toBe(after);
    }
    // One lap: every public product once (the last run wraps to the start).
    const publicIds = (sqlite.prepare("SELECT product_id AS id FROM product_buyer_state WHERE is_public = 1").all() as Array<{ id: string }>).map((row) => row.id);
    expect(new Set(visited.slice(0, publicIds.length))).toEqual(new Set(publicIds));
    expect(visited).not.toContain("prod_00001");
    // Their lists exist: unchanged lists on the next lap write nothing new.
    const stored = (sqlite.prepare("SELECT count(DISTINCT product_id) AS n FROM product_recommendations").get() as { n: number }).n;
    expect(stored).toBe(publicIds.length);
  }, 60_000); // A Paid lap ranks about a hundred products.

  it("refreshes a write's recommendation targets after the response, as many as the plan allows, and never fails the write", async () => {
    const { db, sqlite } = seeded(3);
    await project(db);
    const pending: Promise<unknown>[] = [];
    const executionCtx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
    await refreshRecommendationsAfterWrite({ executionCtx }, db, ["prod_00001"]);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const refreshed = (sqlite.prepare("SELECT DISTINCT product_id AS id FROM product_recommendations ORDER BY 1").all() as Array<{ id: string }>).map((row) => row.id);
    expect(refreshed).toEqual(["prod_00000", "prod_00001", "prod_00002"].slice(0, Math.max(3, limits.recommendationProductsAfterWrite)));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(db, "select").mockImplementation(() => { throw new Error("D1 down"); });
    await refreshRecommendationsAfterWrite({ executionCtx }, db, ["prod_00001"]);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recommendation refresh failed"), { error: "Error" });
    vi.restoreAllMocks();
  });

  it("records the rebuild request with the write and runs its first chunks after the response", async () => {
    const { db, count, kv } = seeded(5);
    const pending: Promise<unknown>[] = [];
    await rebuildCatalogProjectionsAfterWrite({ waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } }, db, "test");
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBe("");
    await Promise.all(pending);
    expect(count("product_buyer_state")).toBe(5);
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBeUndefined();
  });
});

describe("nightly catalogue maintenance", () => {
  it("runs on the first minute of the night only", () => {
    // 02:00 in Dhaka is 20:00 UTC.
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 20, 0), "Asia/Dhaka")).toBe(true);
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 20, 0, 59), "Asia/Dhaka")).toBe(true);
    expect(isNightlyCatalogTick(Date.UTC(2026, 8, 25, 20, 1), "Asia/Dhaka")).toBe(false);
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

  it("refreshes sales stats, requests the rebuild and refreshes the products sold that day", async () => {
    const { db, sqlite, kv } = seeded(3);
    await project(db);
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at)
      VALUES ('ord_1', 'A', '01711000001', 'Road', 'c', 'z', 'confirmed', ${now - 60}, ${now - 60});
      INSERT INTO order_items (id, order_id, product_id, quantity) VALUES ('line_1', 'ord_1', 'prod_00002', 4);
    `);
    const result = await runNightlyCatalogMaintenance(db, Date.now());

    expect(result).toEqual({ salesStatsProducts: 1, soldRecommendations: 1 });
    expect(sqlite.prepare("SELECT product_id, sold_30d FROM product_sales_stats").all()).toEqual([{ product_id: "prod_00002", sold_30d: 4 }]);
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBe("");
    expect(sqlite.prepare("SELECT DISTINCT product_id FROM product_recommendations").all()).toEqual([{ product_id: "prod_00002" }]);
  });
});

describe("post-deploy projection rebuild", () => {
  it("requests one rebuild per API version", async () => {
    const { sqlite, binding } = createSqliteD1Database();
    const kv = (key: string) => (sqlite.prepare("SELECT value FROM system_kv WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
    const env = (id: string | undefined) => ({
      DB: binding,
      CF_VERSION_METADATA: id ? { id, tag: "", timestamp: "" } : undefined,
    }) as unknown as Env;

    await expect(requestPostDeployProjectionRebuild(env("v1"))).resolves.toBe(true);
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBe("");
    sqlite.prepare("DELETE FROM system_kv WHERE key = ?").run(PROJECTION_REBUILD_CURSOR_KEY);
    await expect(requestPostDeployProjectionRebuild(env("v1"))).resolves.toBe(false);
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBeUndefined();
    await expect(requestPostDeployProjectionRebuild(env("v2"))).resolves.toBe(true);
    await expect(requestPostDeployProjectionRebuild(env(undefined))).resolves.toBe(false);
    expect(kv(PROJECTIONS_REBUILT_FOR_VERSION_KEY)).toBe("v2");
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
