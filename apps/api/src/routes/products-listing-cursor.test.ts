import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import { planLimits } from "@scalius/shared/plan-limits";

import { errorResponseFromError } from "../utils/api-response";
import { productRoutes } from "./products";

type ListBody = {
  success: true;
  data: {
    products: Array<{ id: string }>;
    pagination: { page: number; limit: number; total: number; totalPages: number; totalIsCapped: boolean };
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

async function createApp(count: number) {
  const { db, sqlite } = createSqliteD1Database();
  sqlite.exec(`
    WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < ${count - 1})
    INSERT INTO products (id, name, description, price_minor, slug, created_at, updated_at)
      SELECT 'p' || printf('%04d', n), 'Product ' || n, '', 1000 + (n % 4) * 500, 'product-' || n, 100 + n / 3, 100
      FROM seq;
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
      SELECT 'v' || id, id, 'SKU-' || id, price_minor, 5, 1, 1 FROM products;
  `);
  await rebuildCatalogProjections(db);
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/products", productRoutes);
  return async (query: Record<string, string>) => {
    const response = await app.request(`/api/v1/products?${new URLSearchParams(query)}`, {}, {} as Env);
    return { status: response.status, body: await response.json() as ListBody & { error?: { code: string } } };
  };
}

describe("GET /api/v1/products cursor contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the capped total and where the listing continues", async () => {
    const list = await createApp(25);
    const result = await list({ limit: "10", sort: "price-asc" });
    expect(result.status).toBe(200);
    expect(result.body.data.pagination).toEqual({ page: 1, limit: 10, total: 25, totalPages: 3, totalIsCapped: false });
    expect(result.body.data.pageInfo).toEqual({ hasNextPage: true, endCursor: expect.any(String) });
  });

  it("walks the catalogue with the cursor, each product once", async () => {
    const list = await createApp(25);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 6; guard += 1) {
      const result = await list({ limit: "10", sort: "newest", ...(cursor ? { cursor } : {}) });
      expect(result.status).toBe(200);
      seen.push(...result.body.data.products.map((product) => product.id));
      if (!result.body.data.pageInfo.hasNextPage) break;
      cursor = result.body.data.pageInfo.endCursor!;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it("answers a cursor it cannot use with a typed 400", async () => {
    const list = await createApp(12);
    const first = await list({ limit: "5", sort: "price-asc" });
    const cursor = first.body.data.pageInfo.endCursor!;
    const queries: Array<Record<string, string>> = [
      { cursor: "nope!" },
      { cursor, sort: "price-desc" },
      { cursor, sort: "name-asc" },
      { cursor, sort: "price-asc", page: "2" },
    ];
    for (const query of queries) {
      const result = await list({ limit: "5", ...query });
      expect(result.status, JSON.stringify(query)).toBe(400);
      expect(result.body.error?.code).toBe("invalid_cursor");
    }
  });

  it("answers a page past the plan's reach with an empty page, not an error, on both plans", async () => {
    for (const plan of ["free", "paid"] as const) {
      vi.stubGlobal("__SCALIUS_PLAN__", plan);
      const list = await createApp(8);
      const page = planLimits(plan).lists.maxOffset / 20 + 1;
      const result = await list({ limit: "20", page: String(page) });
      expect(result.status, plan).toBe(200);
      expect(result.body.data.products).toEqual([]);
      expect(result.body.data.pageInfo).toEqual({ hasNextPage: false, endCursor: null });
      expect(result.body.data.pagination.page).toBe(page);
      expect(result.body.data.pagination.page).toBeGreaterThan(result.body.data.pagination.totalPages);
      vi.unstubAllGlobals();
    }
  });
});
