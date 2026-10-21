// Bulk runs on the test D1 (routes/admin/resources-bulk.ts): a dry run plans
// every item and writes nothing; a real run is one bulk_runs row whose chunks
// commit with their writes, finishes on the cron's drain, and advances the
// cache clock coarsely (`store`) for what it changed; stock writes ledger-v2 movements.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../utils/api-response";
import { drainBulkRuns } from "../../bulk-runs/engine";
import { idempotentReplay } from "./idempotency";
import { adminResourceBulkRoutes } from "./resources-bulk";

let sqlite: DatabaseSync;
let db: Database;

const SIMPLE = 150;
const OPTIONED = 15;
const SKUS_PER_OPTIONED = 10;

function seedCatalog(): void {
  sqlite.exec(`
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_shoes', 'Shoes', 'shoes', 'published'), ('cat_bags', 'Bags', 'bags', 'published');
    INSERT INTO products (id, name, slug, price_minor, category_id, is_active) VALUES ('p_bag', 'Tote', 'tote', 90000, 'cat_bags', 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_bag', 'p_bag', 'BAG-1', 90000, 5, 1, 1, 'physical');
  `);
  const product = sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, category_id, is_active) VALUES (?, ?, ?, ?, 'cat_shoes', 1)");
  const sku = sqlite.prepare(`INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, option_combination_key, track_inventory, fulfillment_kind)
    VALUES (?, ?, ?, ?, 10, ?, ?, 1, 'physical')`);
  for (let index = 0; index < SIMPLE; index += 1) {
    const price = index === 0 ? 123_400 : 100_000;
    product.run(`p_s${String(index).padStart(3, "0")}`, `Shoe ${index}`, `shoe-${index}`, price);
    sku.run(`v_s${String(index).padStart(3, "0")}`, `p_s${String(index).padStart(3, "0")}`, `SHOE-${index}`, price, 1, null);
  }
  for (let index = 0; index < OPTIONED; index += 1) {
    const productId = `p_o${String(index).padStart(2, "0")}`;
    product.run(productId, `Boot ${index}`, `boot-${index}`, 200_000);
    for (let option = 0; option < SKUS_PER_OPTIONED; option += 1) {
      sku.run(`v_o${String(index).padStart(2, "0")}_${option}`, productId, `BOOT-${index}-${option}`, 200_000 + option * 1_000, 0, `size:${option}`);
    }
  }
}

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)`);
  seedCatalog();
});
afterEach(() => sqlite.close());

async function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
    await next();
  });
  app.use("*", idempotentReplay);
  app.route("/resources", adminResourceBulkRoutes);
  app.onError((error, c) => { const { body, status } = errorResponseFromError(error); return c.json(body, status); });
  const response = await app.request(`/api/v1/admin${path}`, {
    method,
    headers: { ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
  return { status: response.status, body: await response.json() as { data: any; error: { code: string; message: string } } };
}

const prices = () => sqlite.prepare("SELECT id, price_minor AS price FROM product_variants ORDER BY id").all() as Array<{ id: string; price: number }>;
const count = (table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const clock = () => (sqlite.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM cache_dep").get() as { seq: number }).seq;
const depsSince = (seq: number) => new Set((sqlite.prepare("SELECT dep FROM cache_dep WHERE seq > ?").all(seq) as Array<{ dep: string }>).map((row) => row.dep));

const raiseShoes = { filter: { category: "cat_shoes" }, change: { mode: "percent", percent: 5 } };

describe("bulk set prices", () => {
  it("previews 300 SKUs before and after, and writes nothing", async () => {
    const before = prices();
    const seq = clock();
    const preview = await call("POST", "/resources/variants/bulk-set-prices", { body: { ...raiseShoes, dryRun: true } });
    expect(preview.status).toBe(200);
    expect(preview.body.data.run).toMatchObject({
      id: null, status: "preview", dryRun: true, kind: "variants.set_prices", currency: "BDT",
      total: 300, processed: 300, changed: 300, unchanged: 0, failed: 0,
    });
    expect(preview.body.data.run.sample).toHaveLength(50);
    // Half up to the whole-taka increment: 1,234.00 + 5% = 1,295.70 → 1,296.
    expect(preview.body.data.run.sample).toContainEqual(expect.objectContaining({ variantId: "v_o00_0", beforeMinor: 200_000, afterMinor: 210_000 }));
    expect(prices()).toEqual(before);
    expect(count("bulk_runs")).toBe(0);
    expect(depsSince(seq).size).toBe(0);
  });

  it("runs as one bulk run, finishes on the cron drain, and advances each product's dependencies", async () => {
    const seq = clock();
    const revisions = sqlite.prepare("SELECT id, aggregate_revision AS revision FROM products ORDER BY id").all();
    const headers = { "Idempotency-Key": "raise-shoes-5-percent" };
    const started = await call("POST", "/resources/variants/bulk-set-prices", { body: raiseShoes, headers });
    expect(started.status).toBe(202);
    expect(started.body.data.run).toMatchObject({ status: "running", total: 300, dryRun: false });
    const runId = started.body.data.run.id as string;
    expect(count("bulk_runs")).toBe(1);

    // The same key answers with the same run, never a second one.
    const again = await call("POST", "/resources/variants/bulk-set-prices", { body: raiseShoes, headers });
    expect(again.body.data.run.id).toBe(runId);
    expect(count("bulk_runs")).toBe(1);

    for (let tick = 0; tick < 5; tick += 1) await drainBulkRuns(db, 3);
    const run = await call("GET", `/resources/bulk-runs/${runId}`);
    expect(run.body.data.run).toMatchObject({ status: "done", total: 300, processed: 300, changed: 300, failed: 0 });

    const after = new Map(prices().map((row) => [row.id, row.price]));
    expect(after.get("v_s000")).toBe(129_600);
    expect(after.get("v_s001")).toBe(105_000);
    expect(after.get("v_o00_9")).toBe(219_500);
    expect(after.get("v_bag")).toBe(90_000);
    // The simple product follows its SKU, the optioned one its lowest SKU; no revision churn.
    expect(sqlite.prepare("SELECT price_minor AS price FROM products WHERE id = 'p_s000'").get()).toEqual({ price: 129_600 });
    expect(sqlite.prepare("SELECT price_minor AS price FROM products WHERE id = 'p_o00'").get()).toEqual({ price: 210_000 });
    expect(sqlite.prepare("SELECT id, aggregate_revision AS revision FROM products ORDER BY id").all()).toEqual(revisions);
    expect(sqlite.prepare("SELECT from_minor AS fromMinor FROM product_buyer_state WHERE product_id = 'p_o00'").get()).toEqual({ fromMinor: 210_000 });

    // Coarse cache clock: the chunks advanced `store` (every public entry
    // depends on it), not each product's keys.
    const deps = depsSince(seq);
    expect([...deps]).toEqual(["store"]);
    expect(sqlite.prepare("SELECT coarse FROM cache_clock").get()).toEqual({ coarse: 0 });
  });

  it("refuses a SKU whose price changed since it was read and finishes the rest in the request", async () => {
    const done = await call("POST", "/resources/variants/bulk-set-prices", {
      body: { variants: [{ id: "v_s001", expectedPriceMinor: 100_000 }, { id: "v_s002", expectedPriceMinor: 99_000 }], change: { mode: "amount", amountMinor: -5_000 } },
    });
    expect(done.status).toBe(200);
    expect(done.body.data.run).toMatchObject({ status: "done", changed: 1, failed: 1, failures: [{ id: "v_s002", code: "price_changed" }] });
    expect(new Map(prices().map((row) => [row.id, row.price])).get("v_s001")).toBe(95_000);
    // A set amount off the increment is refused before anything starts.
    expect((await call("POST", "/resources/variants/bulk-set-prices", { body: { variants: [{ id: "v_s001" }], change: { mode: "set", amountMinor: 99_950 } } })).status).toBe(400);
  });
});

describe("bulk set stock", () => {
  it("sets counted quantities with ledger-v2 movements, refusing what would go below reservations", async () => {
    sqlite.exec(`UPDATE product_variants SET reserved_stock = 4 WHERE id = 'v_s002'`);
    const versions = new Map((sqlite.prepare("SELECT id, stock_version AS v FROM product_variants WHERE id IN ('v_s001','v_s002','v_s003')").all() as Array<{ id: string; v: number }>).map((row) => [row.id, row.v]));
    const items = [{ variantId: "v_s001", quantity: 25 }, { variantId: "v_s002", quantity: 2 }, { variantId: "v_s003", quantity: 10 }, { variantId: "v_missing", quantity: 1 }];
    const preview = await call("POST", "/resources/variants/bulk-set-stock", { body: { items, dryRun: true } });
    expect(preview.body.data.run).toMatchObject({ changed: 1, unchanged: 1, failed: 2 });
    expect(count("inventory_movements")).toBe(0);

    const run = await call("POST", "/resources/variants/bulk-set-stock", { body: { items }, headers: { "Idempotency-Key": "stocktake-2026-10-19" } });
    expect(run.body.data.run).toMatchObject({ status: "done", changed: 1, unchanged: 1, failed: 2 });
    expect(run.body.data.run.failures).toEqual(expect.arrayContaining([{ id: "v_s002", code: "below_reserved" }, { id: "v_missing", code: "not_found" }]));
    expect(sqlite.prepare("SELECT stock, stock_version AS v FROM product_variants WHERE id = 'v_s001'").get()).toEqual({ stock: 25, v: versions.get("v_s001")! + 1 });
    const movement = sqlite.prepare("SELECT type, stock_delta AS delta, ledger_version AS ledger, location_id AS location FROM inventory_movements WHERE variant_id = 'v_s001'").get() as { type: string; delta: number; ledger: number; location: string | null };
    expect(movement).toMatchObject({ type: "adjusted", delta: 15, ledger: 2 });
    expect(movement.location).not.toBeNull();
    expect((sqlite.prepare("SELECT sum(on_hand) AS n FROM inventory_levels WHERE variant_id = 'v_s001'").get() as { n: number }).n).toBe(25);
    expect(sqlite.prepare("SELECT stock FROM product_variants WHERE id = 'v_s002'").get()).toEqual({ stock: 10 });
  });
});

describe("bulk tags, status and publishing", () => {
  it("tags customers by order count", async () => {
    sqlite.exec(`
      INSERT INTO customers (id, name, phone, total_orders, origin) VALUES
        ('cus_a', 'A', '+8801711111111', 5, 'merchant'), ('cus_b', 'B', '+8801722222222', 3, 'merchant'), ('cus_c', 'C', '+8801733333333', 4, 'merchant');
    `);
    const body = { filter: { minOrders: 4 }, add: ["VIP"] };
    expect((await call("POST", "/resources/customers/bulk-tag", { body: { ...body, dryRun: true } })).body.data.run).toMatchObject({ total: 2, changed: 2 });
    expect(count("customer_tag_links")).toBe(0);
    const run = await call("POST", "/resources/customers/bulk-tag", { body });
    expect(run.body.data.run).toMatchObject({ status: "done", changed: 2 });
    expect(sqlite.prepare("SELECT customer_id AS id, tag FROM customer_tag_links ORDER BY customer_id").all()).toEqual([{ id: "cus_a", tag: "vip" }, { id: "cus_c", tag: "vip" }]);
  });

  it("drafts products by filter and publishes them by id", async () => {
    const drafted = await call("POST", "/resources/products/bulk-set-status", { body: { filter: { category: "cat_bags" }, status: "draft" } });
    expect(drafted.body.data.run).toMatchObject({ status: "done", changed: 1 });
    expect(sqlite.prepare("SELECT is_active AS active FROM products WHERE id = 'p_bag'").get()).toEqual({ active: 0 });
    const unpublished = await call("POST", "/resources/products/bulk-publish", { body: { productIds: ["p_bag"], channelIds: ["sc_google"], action: "unpublish" } });
    expect(unpublished.body.data.run).toMatchObject({ status: "done", changed: 1 });
    const runs = await call("GET", "/resources/bulk-runs");
    expect(runs.body.data.runs).toHaveLength(2);
    expect(runs.body.data.nextCursor).toBeNull();
    const read = await call("GET", `/resources/bulk-runs/${drafted.body.data.run.id as string}`);
    expect(read.body.data.run).toMatchObject({ id: drafted.body.data.run.id, kind: "products.set_status", status: "done" });
  });

  it("leaves a product changed since its expectedRevision alone", async () => {
    const { revision } = sqlite.prepare("SELECT aggregate_revision AS revision FROM products WHERE id = 'p_bag'").get() as { revision: number };
    const stale = await call("POST", "/resources/products/bulk-set-status", { body: { products: [{ id: "p_bag", expectedRevision: revision + 1 }], status: "draft" } });
    expect(stale.body.data.run).toMatchObject({ status: "done", changed: 0, failed: 1, failures: [{ id: "p_bag", code: "revision_changed" }] });
    expect(sqlite.prepare("SELECT is_active AS active FROM products WHERE id = 'p_bag'").get()).toEqual({ active: 1 });
    const current = await call("POST", "/resources/products/bulk-set-status", { body: { products: [{ id: "p_bag", expectedRevision: revision }], status: "draft" } });
    expect(current.body.data.run).toMatchObject({ status: "done", changed: 1, failed: 0 });
  });
});
