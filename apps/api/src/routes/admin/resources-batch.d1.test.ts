// Batch creates of the stable app API (resources-batch.ts): products,
// categories and brands in one bounded call, each item replayed by its own
// key (its id derives from the key), a refusal failing only its item, and one maximum-size Free
// call staying inside Workers Free's 50 D1 calls per invocation.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PLAN_LIMITS } from "@scalius/shared/plan-limits";
import { errorResponseFromError } from "../../utils/api-response";
import { adminBrandRoutes } from "./brands";
import { adminCategoryRoutes } from "./categories";
import { idempotentReplay } from "./idempotency";
import { adminResourceProductRoutes } from "./resources-products";

let sqlite: DatabaseSync;
let db: Database;
/** D1 round trips: a statement outside a batch is one, a whole batch is one. */
let queries = 0;
let batchStatements = 0;
let batches = 0;
const d1Calls = () => queries - batchStatements + batches;

type Principal = { pluginId: string; permissions: Set<string> } | null;
const ACME: Principal = { pluginId: "acme.importer", permissions: new Set() };
const OTHER: Principal = { pluginId: "other.importer", permissions: new Set() };

beforeEach(() => {
  queries = 0;
  batchStatements = 0;
  batches = 0;
  ({ sqlite, db } = createSqliteD1Database({
    onQuery: () => { queries += 1; },
    beforeBatch: (_sqlite, statements) => { batches += 1; batchStatements += statements.length; },
  }));
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);`);
  // A store that prices to the cent (BDT's default increment is a whole taka).
  sqlite.exec(`UPDATE markets SET price_increment_minor = 1 WHERE id = 'mkt_backup';`);
  queries = 0;
  batchStatements = 0;
  batches = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});

type Wire = { status: number; replayed: string | null; body: { success: boolean; data: any; error: { code: string; message: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.

async function post(path: string, body: unknown, options: { principal?: Principal; idempotencyKey?: string } = {}): Promise<Wire> {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  const principal = options.principal === undefined ? ACME : options.principal;
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
    if (principal) c.set("pluginPrincipal" as never, principal as never);
    await next();
  });
  app.use("*", idempotentReplay);
  app.route("/resources", adminResourceProductRoutes);
  app.route("/categories", adminCategoryRoutes);
  app.route("/brands", adminBrandRoutes);
  app.onError((error, c) => { const { body: errorBody, status } = errorResponseFromError(error); return c.json(errorBody, status); });
  const response = await app.request(`/api/v1/admin${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}) },
    body: JSON.stringify(body),
  }, {} as never);
  return { status: response.status, replayed: response.headers.get("idempotent-replayed"), body: await response.json() as Wire["body"] };
}

const PRODUCTS = "/resources/products/batch";
const product = (key: string, extra: Record<string, unknown> = {}, priceMinor = 1999) => ({
  key,
  name: `Tea ${key}`,
  condition: "new",
  status: "active",
  variants: [{ sku: `SKU-${key}`, priceMinor }],
  ...extra,
});
const category = (key: string, extra: Record<string, unknown> = {}) => ({ key, name: `Shelf ${key}`, description: null, metaTitle: null, metaDescription: null, canonicalPath: null, ...extra });
const brand = (key: string, extra: Record<string, unknown> = {}) => ({ key, name: `Maker ${key}`, ...extra });
const count = (table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const outcomes = (wire: Wire) => wire.body.data.items.map((item: { key: string; outcome: string }) => [item.key, item.outcome]);

describe("products.batch_create", () => {
  it("creates some items and fails others in one call, in minor units", async () => {
    const wire = await post(PRODUCTS, { items: [
      product("one"),
      product("zero-price", {}, 0),
      product("two", { slug: "tea-one" }),
      product("three", { categoryId: "cat_missing" }),
    ] });
    expect(wire.status).toBe(200);
    expect(outcomes(wire)).toEqual([["one", "created"], ["zero-price", "failed"], ["two", "failed"], ["three", "failed"]]);
    const items = wire.body.data.items;
    expect(items[0].product).toMatchObject({ id: expect.stringMatching(/^prod_/), slug: "tea-one", revision: 1 });
    expect(items[0].error).toBeNull();
    for (const index of [1, 2, 3]) {
      expect(items[index].product).toBeNull();
      expect(items[index].error.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(items[index].error.message.length).toBeGreaterThan(0);
    }
    expect(items[1].error.code).toBe("validation_error");
    expect(items[2].error.code).toBe("conflict");
    expect(items[3].error.code).toBe("validation_error");
    // 1999 minor units on a two-decimal store read back as 1999.
    const row = sqlite.prepare("SELECT price_minor FROM products WHERE id = ?").get(items[0].product.id) as { price_minor: number };
    expect(row.price_minor).toBe(1999);
    const variant = sqlite.prepare("SELECT price_minor, stock FROM product_variants WHERE product_id = ?").get(items[0].product.id) as { price_minor: number; stock: number };
    expect(variant).toEqual({ price_minor: 1999, stock: 0 });
    expect(count("products")).toBe(1);
    // A later item still works after a failed one.
    const next = await post(PRODUCTS, { items: [product("four", { status: "draft", slug: "tea-four" }, 1250), product("five", { variants: [{ sku: "SKU-one", priceMinor: 500 }] })] });
    expect(outcomes(next)).toEqual([["four", "created"], ["five", "failed"]]);
    expect(next.body.data.items[1].error.code).toBe("sku_taken");
    expect(count("products")).toBe(2);
  });

  it("replays a key from another call, whatever its Idempotency-Key, without a second row", async () => {
    const first = await post(PRODUCTS, { items: [product("a"), product("b")] }, { idempotencyKey: "retry-key-one" });
    expect(outcomes(first)).toEqual([["a", "created"], ["b", "created"]]);
    const second = await post(PRODUCTS, { items: [product("b"), product("c"), product("a")] }, { idempotencyKey: "retry-key-two" });
    expect(second.replayed).toBeNull();
    expect(outcomes(second)).toEqual([["b", "replayed"], ["c", "created"], ["a", "replayed"]]);
    expect(second.body.data.items[0].product).toEqual(first.body.data.items[1].product);
    expect(second.body.data.items[2].product).toEqual(first.body.data.items[0].product);
    expect(count("products")).toBe(3);
    // No header at all replays the same way.
    const third = await post(PRODUCTS, { items: [product("a")] });
    expect(outcomes(third)).toEqual([["a", "replayed"]]);
    expect(count("products")).toBe(3);
  });

  it("scopes a key to the caller, and reports a trashed product as not_found", async () => {
    const mine = await post(PRODUCTS, { items: [product("a")] });
    const theirs = await post(PRODUCTS, { items: [product("a", { name: "Other tea", variants: [{ sku: "OTHER-1", priceMinor: 100 }] })] }, { principal: OTHER });
    expect(outcomes(theirs)).toEqual([["a", "created"]]);
    expect(theirs.body.data.items[0].product.id).not.toBe(mine.body.data.items[0].product.id);
    sqlite.prepare("UPDATE products SET deleted_at = unixepoch() WHERE id = ?").run(mine.body.data.items[0].product.id);
    const again = await post(PRODUCTS, { items: [product("a")] });
    expect(outcomes(again)).toEqual([["a", "failed"]]);
    expect(again.body.data.items[0].error.code).toBe("not_found");
    expect(count("products")).toBe(2);
  });

  it("refuses a malformed request whole, and creates nothing", async () => {
    const duplicate = await post(PRODUCTS, { items: [product("a"), product("a", { name: "Tea again" })] });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe("validation_error");
    expect((await post(PRODUCTS, { items: [] })).status).toBe(400);
    expect((await post(PRODUCTS, { items: [{ ...product("a"), key: "x".repeat(65) }] })).status).toBe(400);
    expect((await post(PRODUCTS, { items: [{ ...product("a"), key: "café" }] })).status).toBe(400);
    expect((await post(PRODUCTS, { items: [{ ...product("a"), surprise: true }] })).status).toBe(400);
    expect((await post(PRODUCTS, { items: [{ ...product("a"), key: undefined }] })).status).toBe(400);
    expect((await post(PRODUCTS, { items: [product("a")], extra: 1 })).status).toBe(400);
    expect(count("products")).toBe(0);
  });

  it("refuses more items than the plan's bound, naming it", async () => {
    const free = PLAN_LIMITS.free.batchCreates.products;
    const over = await post(PRODUCTS, { items: Array.from({ length: free + 1 }, (_, index) => product(`k${index}`)) });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("validation_error");
    expect(over.body.error.message).toContain(String(free));
    expect(count("products")).toBe(0);
    // Paid takes up to its own bound.
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    const paid = PLAN_LIMITS.paid.batchCreates.products;
    const ok = await post(PRODUCTS, { items: Array.from({ length: paid }, (_, index) => product(`k${index}`)) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.items.every((item: { outcome: string }) => item.outcome === "created")).toBe(true);
    expect((await post(PRODUCTS, { items: Array.from({ length: paid + 1 }, (_, index) => product(`m${index}`)) })).status).toBe(400);
  });

});

describe("categories.batch_create", () => {
  const CATEGORIES = "/categories/batch";

  it("creates a parent and its child in order, fails a taken slug, and replays by key", async () => {
    const first = await post(CATEGORIES, { items: [category("root", { slug: "tea-shelf" })] });
    const rootId = first.body.data.items[0].category.id as string;
    const wire = await post(CATEGORIES, { items: [
      category("root", { slug: "tea-shelf" }),
      category("child", { parentId: rootId }),
      category("clash", { slug: "tea-shelf" }),
      category("orphan", { parentId: "cat_missing" }),
    ] }, { idempotencyKey: "retry-key-cats" });
    expect(wire.status).toBe(200);
    expect(outcomes(wire)).toEqual([["root", "replayed"], ["child", "created"], ["clash", "failed"], ["orphan", "failed"]]);
    expect(wire.body.data.items[0].category).toEqual({ id: rootId, slug: "tea-shelf", revision: 1 });
    expect(wire.body.data.items[1].category).toMatchObject({ id: expect.stringMatching(/^cat_/), slug: "shelf-child", revision: 1 });
    expect(wire.body.data.items[2].error.code).toBe("conflict");
    expect(wire.body.data.items[3].error.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(count("categories")).toBe(2);
    const parent = sqlite.prepare("SELECT parent_id FROM categories WHERE id = ?").get(wire.body.data.items[1].category.id) as { parent_id: string };
    expect(parent.parent_id).toBe(rootId);
  });

  it("refuses a duplicate key and an over-bound request", async () => {
    expect((await post(CATEGORIES, { items: [category("a"), category("a", { name: "Shelf again" })] })).status).toBe(400);
    const free = PLAN_LIMITS.free.batchCreates.categories;
    const over = await post(CATEGORIES, { items: Array.from({ length: free + 1 }, (_, index) => category(`k${index}`)) });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain(String(free));
    expect(count("categories")).toBe(0);
  });

});

describe("brands.batch_create", () => {
  const BRANDS = "/brands/batch";

  it("creates, fails a taken slug, and replays by key", async () => {
    const first = await post(BRANDS, { items: [brand("one", { slug: "maker-one" })] });
    expect(first.body.data.items[0].brand).toEqual({ id: expect.stringMatching(/^brd_/), slug: "maker-one", revision: 1 });
    const wire = await post(BRANDS, { items: [brand("one", { slug: "maker-one" }), brand("two"), brand("three", { slug: "maker-one" })] });
    expect(outcomes(wire)).toEqual([["one", "replayed"], ["two", "created"], ["three", "failed"]]);
    expect(wire.body.data.items[0].brand).toEqual(first.body.data.items[0].brand);
    expect(wire.body.data.items[2].error.code).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(count("brands")).toBe(2);
  });

  it("refuses a duplicate key and an over-bound request", async () => {
    expect((await post(BRANDS, { items: [brand("a"), brand("a", { name: "Maker again" })] })).status).toBe(400);
    const free = PLAN_LIMITS.free.batchCreates.brands;
    const over = await post(BRANDS, { items: Array.from({ length: free + 1 }, (_, index) => brand(`k${index}`)) });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain(String(free));
    expect(count("brands")).toBe(0);
  });

});

// The cost behind the Free bounds (`planLimits().batchCreates`), measured on
// the test D1 (one D1 call is a statement, or a whole batch):
//
//   brands               2 per call + 3 per item
//   categories           2 per call + 3 per item (+1 under a parent)
//   products             6 per call + 5 per item, + 2 per item for the first 5
//                        (the recommendation refresh after the write, capped by
//                        `background.recommendationProductsAfterWrite`), + 3
//                        per item naming a category and a brand
//
// A call by an app adds PLATFORM_CALLS more. The Free bound is the most items
// that keep the maximum-size call at least SAFETY_MARGIN under Free's 50, for
// the heaviest item shape tested here; Paid (1,000 per invocation) takes its
// larger bound with room to spare.
const SAFETY_MARGIN = 4;

async function d1CallsOf(path: string, items: unknown[]): Promise<number> {
  queries = 0; batchStatements = 0; batches = 0;
  const wire = await post(path, { items });
  expect(wire.status).toBe(200);
  expect(wire.body.data.items.every((item: { outcome: string }) => item.outcome === "created")).toBe(true);
  return d1Calls();
}

type Shape = {
  name: string;
  path: string;
  bound: () => number;
  /** Whether this is the heaviest shape of its operation, which the bound must fit tightly. */
  tight?: true;
  /** Creates what the items refer to, and returns the item builder. */
  setup: () => Promise<(key: string) => unknown>;
};

const SHAPES: Shape[] = [
  { name: "simple products", path: PRODUCTS, bound: () => PLAN_LIMITS.free.batchCreates.products, setup: async () => (key) => product(key) },
  {
    name: "products with four SKUs",
    path: PRODUCTS,
    bound: () => PLAN_LIMITS.free.batchCreates.products,
    setup: async () => (key) => product(key, {
      options: [{ name: "Size", values: ["S", "M"] }, { name: "Color", values: ["Red", "Blue"] }],
      variants: ["S", "M"].flatMap((size) => ["Red", "Blue"].map((color) => ({ sku: `SKU-${key}-${size}-${color}`, priceMinor: 1999, optionValues: { Size: size, Color: color } }))),
    }),
  },
  {
    name: "products in a category with a brand",
    path: PRODUCTS,
    tight: true,
    bound: () => PLAN_LIMITS.free.batchCreates.products,
    setup: async () => {
      const categoryId = (await post("/categories/batch", { items: [category("shelf")] })).body.data.items[0].category.id as string;
      const brandId = (await post("/brands/batch", { items: [brand("maker")] })).body.data.items[0].brand.id as string;
      return (key) => product(key, { categoryId, brandId });
    },
  },
  { name: "categories", path: "/categories/batch", bound: () => PLAN_LIMITS.free.batchCreates.categories, setup: async () => (key) => category(key) },
  {
    name: "categories under a parent",
    path: "/categories/batch",
    tight: true,
    bound: () => PLAN_LIMITS.free.batchCreates.categories,
    setup: async () => {
      const parentId = (await post("/categories/batch", { items: [category("parent")] })).body.data.items[0].category.id as string;
      return (key) => category(key, { parentId });
    },
  },
  { name: "brands", path: "/brands/batch", tight: true, bound: () => PLAN_LIMITS.free.batchCreates.brands, setup: async () => (key) => brand(key) },
];

describe.each(SHAPES)("the Free plan's D1 budget for $name", ({ name, path, bound, setup, tight }) => {
  it("keeps one maximum-size call under 50 D1 calls with the platform's own, and the bound is tight", async () => {
    const build = await setup();
    const free = bound();
    const almost = await d1CallsOf(path, Array.from({ length: free - 1 }, (_, index) => build(`a${index}`)));
    const maximum = await d1CallsOf(path, Array.from({ length: free }, (_, index) => build(`k${index}`)));
    const marginal = maximum - almost;
    console.info(`${name}: ${free} items = ${maximum} D1 calls (the last one ${marginal}), +${PLATFORM_CALLS} platform`);
    expect(maximum + PLATFORM_CALLS + SAFETY_MARGIN).toBeLessThanOrEqual(FREE_D1_CALLS);
    // As high as that budget allows for the heaviest shape: one more item would not fit.
    if (tight) expect(maximum + marginal + PLATFORM_CALLS + SAFETY_MARGIN).toBeGreaterThan(FREE_D1_CALLS);
  });
});

/** Workers Free: D1 queries per invocation. */
const FREE_D1_CALLS = 50;
/** What a call by an app adds beyond the route: the Idempotency-Key middleware (claim, keep) and the plugin dispatch (principal, audit). */
const PLATFORM_CALLS = 6;
