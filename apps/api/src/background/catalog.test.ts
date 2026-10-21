// Catalogue background work end to end on the real migrated schema: the
// projection rebuild walks the catalogue in keyset chunks from a durable lap
// state (`system_kv`) that a new request never sends back to the start;
// transactional dependency triggers refresh only changed output; the
// recommendation rotation visits every public product in turn from its own
// cursor; a catalogue write refreshes its targets right after the response;
// the nightly pass refreshes sales stats, checks a window of projections for
// drift and refreshes the products sold that day.
import "@hono/zod-openapi";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PLAN_LIMITS, type WorkersPlan } from "@scalius/shared/plan-limits";
import {
  PROJECTION_REBUILD_CURSOR_KEY,
  RECOMMENDATION_LAP_SECONDS,
  nextCatalogRebuildState,
  parseCatalogRebuildState,
  RECOMMENDATION_ROTATION_CURSOR_KEY,
  drainCatalogProjectionRebuild,
  rebuildCatalogProjectionsAfterWrite,
  refreshRecommendationsAfterWrite,
  requestCatalogProjectionRebuild,
  rotateRecommendations,
} from "./catalog";
import {
  isNightlyCatalogTick,
  PROJECTION_DRIFT_CURSOR_KEY,
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
  const lap = () => parseCatalogRebuildState(kv(PROJECTION_REBUILD_CURSOR_KEY) ?? null);
  return { ...harness, count, kv, lap };
}

const productId = (index: number) => `prod_${String(index).padStart(5, "0")}`;

/** Builds the projections once (the rotation and refreshes read them). */
async function project(db: ReturnType<typeof seeded>["db"]) {
  await requestCatalogProjectionRebuild(db);
  while (await drainCatalogProjectionRebuild(db) > 0) { /* until done */ }
}

describe.each(["free", "paid"] as const satisfies readonly WorkersPlan[])("catalogue background work on the %s profile", (plan) => {
  const limits = PLAN_LIMITS[plan].background;
  beforeEach(() => { vi.stubGlobal("__SCALIUS_PLAN__", plan); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("rebuilds in chunks from its lap state, advances dependencies for drift, and leaves unchanged output valid", async () => {
    const chunk = limits.catalogRebuildChunk;
    const perDrain = limits.catalogRebuildChunksPerDrain;
    const { db, count, sqlite, kv, lap } = seeded(chunk * perDrain + 5);
    const storeSeq = () => Number((sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = 'store'").get() as { seq: number } | undefined)?.seq ?? 0);
    const before = storeSeq();

    // No request: nothing runs.
    await expect(drainCatalogProjectionRebuild(db)).resolves.toBe(0);
    await requestCatalogProjectionRebuild(db);
    expect(lap()).toEqual({ mode: "full", after: null, stop: null, wrapped: false, repairCounts: true });

    await expect(drainCatalogProjectionRebuild(db)).resolves.toBe(chunk * perDrain);
    expect(count("product_buyer_state")).toBe(chunk * perDrain);
    expect(storeSeq()).toBeGreaterThan(before);
    expect(lap()).toEqual({ mode: "full", after: productId(chunk * perDrain - 1), stop: null, wrapped: false, repairCounts: false });

    await expect(drainCatalogProjectionRebuild(db)).resolves.toBe(5);
    expect(count("product_buyer_state")).toBe(chunk * perDrain + 5);
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBeUndefined();

    const unchanged = storeSeq();
    await project(db);
    expect(storeSeq()).toBe(unchanged);
  }); // A Paid drain recomputes 9,000 seeded products.

  it("keeps a lap's progress when a request lands mid-lap: it wraps once and ends where the request found it", async () => {
    const chunk = limits.catalogRebuildChunk;
    const { db, kv, lap, sqlite } = seeded(chunk * 2 + 5);
    await project(db);
    const running = { mode: "full", after: productId(chunk - 1), stop: null, wrapped: false, repairCounts: false } as const;
    sqlite.prepare("INSERT INTO system_kv (key, value) VALUES (?, ?)").run(PROJECTION_REBUILD_CURSOR_KEY, JSON.stringify(running));
    // The request lands while the next chunk writes: that chunk's save loses, the position stays.
    sqlite.exec(`CREATE TEMP TRIGGER request_mid_chunk AFTER UPDATE ON product_buyer_state BEGIN
      UPDATE system_kv SET value = '${JSON.stringify(nextCatalogRebuildState(running, "full"))}'
      WHERE key = '${PROJECTION_REBUILD_CURSOR_KEY}';
    END`);
    // Every product's price changed without its projection: the lap must reach each one.
    sqlite.exec("UPDATE product_variants SET price_minor = 20000");
    await drainCatalogProjectionRebuild(db);
    sqlite.exec("DROP TRIGGER request_mid_chunk");
    expect(lap()).toEqual({ mode: "full", after: productId(chunk - 1), stop: productId(chunk - 1), wrapped: false, repairCounts: true });
    // It goes on from there, wraps once, and finishes at the stop: every product is current.
    let drains = 0;
    while (kv(PROJECTION_REBUILD_CURSOR_KEY) !== undefined && drains < 100) {
      await drainCatalogProjectionRebuild(db);
      drains += 1;
    }
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBeUndefined();
    expect(sqlite.prepare("SELECT count(*) AS n FROM product_buyer_state WHERE from_minor <> 20000").get()).toEqual({ n: 0 });
  });

  // The lap logic is the same on both plans; Paid's chunks would seed 27,000 products.
  it.runIf(plan === "free")("reaches every product while requests keep arriving, and ends one circle after the last", async () => {
    const chunk = limits.catalogRebuildChunk;
    const perDrain = limits.catalogRebuildChunksPerDrain;
    const products = chunk * perDrain * 3 + 7;
    const circle = Math.ceil(products / (chunk * perDrain));
    const { db, kv, sqlite } = seeded(products);
    await project(db);
    const last = productId(products - 1);
    const lastPrice = () => (sqlite.prepare("SELECT from_minor FROM product_buyer_state WHERE product_id = ?").get(last) as { from_minor: number }).from_minor;
    // A store-wide edit before every tick, for more than a circle. The old
    // cursor reset sent the lap back to the first product each time, so the
    // last product never saw any of them.
    for (let tick = 0; tick < circle + 2; tick += 1) {
      sqlite.exec(`UPDATE product_variants SET price_minor = ${20_000 + tick}`);
      await requestCatalogProjectionRebuild(db);
      await drainCatalogProjectionRebuild(db);
    }
    expect(lastPrice()).toBeGreaterThan(10_000);
    // The edits stop: the lap ends within one more circle, and everything is current.
    let drains = 0;
    while (kv(PROJECTION_REBUILD_CURSOR_KEY) !== undefined && drains < circle + 5) {
      await drainCatalogProjectionRebuild(db);
      drains += 1;
    }
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBeUndefined();
    expect(drains).toBeLessThanOrEqual(circle + 1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM product_buyer_state WHERE from_minor <> ?").get(20_000 + circle + 1)).toEqual({ n: 0 });
  });

  // Plan-independent logic; Paid's band chunks would seed 50,000 products.
  it.runIf(plan === "free")("runs a band-only lap for a band input and turns it into a full lap when a full request lands", async () => {
    const products = limits.catalogBandRefreshChunk * limits.catalogRebuildChunksPerDrain + 3;
    const { db, lap } = seeded(products);
    await project(db);
    await requestCatalogProjectionRebuild(db, "bands");
    expect(lap()).toEqual({ mode: "bands", after: null, stop: null, wrapped: false, repairCounts: false });
    // Band chunks (one statement each) are larger than rebuild chunks.
    await expect(drainCatalogProjectionRebuild(db)).resolves.toBe(products - 3);
    const position = lap()!.after;
    expect(position).toBe(productId(products - 4));
    await requestCatalogProjectionRebuild(db, "full");
    expect(lap()).toEqual({ mode: "full", after: position, stop: position, wrapped: false, repairCounts: true });
  });

  it("reads the cursor of the previous release as a full lap", () => {
    expect(parseCatalogRebuildState("")).toEqual({ mode: "full", after: null, stop: null, wrapped: false, repairCounts: true });
    expect(parseCatalogRebuildState("prod_00009")).toEqual({ mode: "full", after: "prod_00009", stop: null, wrapped: false, repairCounts: false });
    expect(parseCatalogRebuildState(null)).toBeNull();
    // A wrapped lap that is asked again ends where it is now.
    expect(nextCatalogRebuildState({ mode: "bands", after: "prod_00002", stop: "prod_00005", wrapped: true, repairCounts: false }, "bands"))
      .toEqual({ mode: "bands", after: "prod_00002", stop: "prod_00002", wrapped: false, repairCounts: false });
  });

  it("visits every public product once a lap in id order, then rests until the day's lap is due again", async () => {
    const perRun = limits.recommendationRotationPerRun;
    const products = perRun * 2 + 3;
    const { db, kv, sqlite } = seeded(products);
    await project(db);
    // A product that is not public is never visited.
    sqlite.exec("UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'prod_00001'");
    const publicIds = (sqlite.prepare("SELECT product_id AS id FROM product_buyer_state WHERE is_public = 1 ORDER BY product_id").all() as Array<{ id: string }>).map((row) => row.id);
    const now = 1_900_000_000;
    const counts: number[] = [];
    for (let run = 0; run < 4; run += 1) counts.push(await rotateRecommendations(db, now + run * 900));
    // Two full runs, then the rest; the lap is done and the next run rests.
    expect(counts).toEqual([perRun, perRun, publicIds.length - 2 * perRun, 0]);
    expect(JSON.parse(kv(RECOMMENDATION_ROTATION_CURSOR_KEY)!)).toEqual({ lapStartedAt: now, after: publicIds.at(-1), done: true });
    const stored = (sqlite.prepare("SELECT count(DISTINCT product_id) AS n FROM product_recommendations").get() as { n: number }).n;
    expect(stored).toBe(publicIds.length);
    expect(sqlite.prepare("SELECT count(*) AS n FROM product_recommendations WHERE product_id = 'prod_00001'").get()).toEqual({ n: 0 });
    // A day after the lap started, the next lap starts from the beginning.
    expect(await rotateRecommendations(db, now + RECOMMENDATION_LAP_SECONDS - 1)).toBe(0);
    expect(await rotateRecommendations(db, now + RECOMMENDATION_LAP_SECONDS)).toBe(perRun);
    expect(JSON.parse(kv(RECOMMENDATION_ROTATION_CURSOR_KEY)!)).toEqual({ lapStartedAt: now + RECOMMENDATION_LAP_SECONDS, after: publicIds[perRun - 1], done: false });
  }); // A Paid lap ranks about seventy products.

  it("refreshes products a buyer read queued before the lap, even on a resting day", async () => {
    const { enqueueRecommendationRefresh, queuedRecommendationRefresh } = await import("@scalius/core/modules/catalog");
    const perRun = limits.recommendationRotationPerRun;
    const { db, kv, sqlite } = seeded(perRun + 2);
    await project(db);
    const now = 1_900_000_000;
    // Today's lap is done: the rotation rests.
    while (await rotateRecommendations(db, now) > 0);
    sqlite.exec("DELETE FROM product_recommendations");
    const lap = kv(RECOMMENDATION_ROTATION_CURSOR_KEY);
    const last = (sqlite.prepare("SELECT max(product_id) AS id FROM product_buyer_state").get() as { id: string }).id;
    await enqueueRecommendationRefresh(db, [last]);
    expect(await rotateRecommendations(db, now + 60)).toBe(1);
    expect(sqlite.prepare("SELECT count(DISTINCT product_id) AS n FROM product_recommendations").get()).toEqual({ n: 1 });
    expect(await queuedRecommendationRefresh(db, 10)).toEqual([]);
    // The lap's cursor is untouched, and with nothing queued the rotation rests again.
    expect(kv(RECOMMENDATION_ROTATION_CURSOR_KEY)).toBe(lap);
    expect(await rotateRecommendations(db, now + 120)).toBe(0);
  });

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
    expect(parseCatalogRebuildState(kv(PROJECTION_REBUILD_CURSOR_KEY) ?? null)).toMatchObject({ mode: "full", after: null });
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

  it("refreshes sales stats, checks a window of projections for drift and refreshes the products sold that day", async () => {
    const { db, sqlite, kv } = seeded(3);
    await project(db);
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at)
      VALUES ('ord_1', 'A', '01711000001', 'Road', 'c', 'z', 'confirmed', ${now - 60}, ${now - 60});
      INSERT INTO order_items (id, order_id, product_id, quantity) VALUES ('line_1', 'ord_1', 'prod_00002', 4);
    `);
    const result = await runNightlyCatalogMaintenance(db, Date.now());

    expect(result).toEqual({ salesStatsProducts: 1, soldRecommendations: 1, projectionsChecked: 3, projectionsRepaired: 0 });
    expect(sqlite.prepare("SELECT product_id, sold_30d FROM product_sales_stats").all()).toEqual([{ product_id: "prod_00002", sold_30d: 4 }]);
    // No drift: no rebuild lap. The window reached the end, so the next night starts again.
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBeUndefined();
    expect(kv(PROJECTION_DRIFT_CURSOR_KEY)).toBe("");
    expect(sqlite.prepare("SELECT DISTINCT product_id FROM product_recommendations").all()).toEqual([{ product_id: "prod_00002" }]);

    // Drift (a write that skipped the projection): repaired in place, and a full lap is requested.
    sqlite.exec("UPDATE product_buyer_state SET from_minor = 1, base_minor = 1, to_minor = 1 WHERE product_id = 'prod_00001'");
    expect(await runNightlyCatalogMaintenance(db, Date.now())).toMatchObject({ projectionsChecked: 3, projectionsRepaired: 1 });
    expect(sqlite.prepare("SELECT from_minor FROM product_buyer_state WHERE product_id = 'prod_00001'").get()).toEqual({ from_minor: 10000 });
    expect(parseCatalogRebuildState(kv(PROJECTION_REBUILD_CURSOR_KEY) ?? null)).toMatchObject({ mode: "full" });
  });

  it("checks a rotating window of the plan's size each night", async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", "free");
    const window = PLAN_LIMITS.free.background.catalogDriftCheckPerNight;
    const { db, kv } = seeded(window + 4);
    await project(db);
    expect(await runNightlyCatalogMaintenance(db, Date.now())).toMatchObject({ projectionsChecked: window });
    expect(kv(PROJECTION_DRIFT_CURSOR_KEY)).toBe(productId(window - 1));
    expect(await runNightlyCatalogMaintenance(db, Date.now())).toMatchObject({ projectionsChecked: 4 });
    expect(kv(PROJECTION_DRIFT_CURSOR_KEY)).toBe("");
    vi.unstubAllGlobals();
  });
});

describe("post-deploy projection rebuild", () => {
  it("requests one rebuild per API version, and only when the projection's definition changed", async () => {
    const { sqlite, binding } = createSqliteD1Database();
    const kv = (key: string) => (sqlite.prepare("SELECT value FROM system_kv WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
    const env = (id: string | undefined) => ({
      DB: binding,
      CF_VERSION_METADATA: id ? { id, tag: "", timestamp: "" } : undefined,
    }) as unknown as Env;

    // The first version knows no stored definition: it rebuilds.
    await expect(requestPostDeployProjectionRebuild(env("v1"))).resolves.toBe(true);
    expect(parseCatalogRebuildState(kv(PROJECTION_REBUILD_CURSOR_KEY) ?? null)).toMatchObject({ mode: "full" });
    sqlite.prepare("DELETE FROM system_kv WHERE key = ?").run(PROJECTION_REBUILD_CURSOR_KEY);
    await expect(requestPostDeployProjectionRebuild(env("v1"))).resolves.toBe(false);
    // A new version with the same definition requests nothing.
    await expect(requestPostDeployProjectionRebuild(env("v2"))).resolves.toBe(false);
    expect(kv(PROJECTION_REBUILD_CURSOR_KEY)).toBeUndefined();
    expect(kv(PROJECTIONS_REBUILT_FOR_VERSION_KEY)).toBe("v2");
    // A changed definition (simulated: another stored hash) rebuilds.
    sqlite.prepare("UPDATE system_kv SET value = 'old-definition' WHERE key = 'catalog:projections:definition'").run();
    await expect(requestPostDeployProjectionRebuild(env("v3"))).resolves.toBe(true);
    await expect(requestPostDeployProjectionRebuild(env(undefined))).resolves.toBe(false);
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
