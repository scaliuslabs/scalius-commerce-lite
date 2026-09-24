import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../utils/api-response";
import { productRoutes } from "./products";

function createApp() {
  const { db, sqlite } = createSqliteD1Database();
  sqlite.exec(`
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_shirts', 'Shirts', 'shirts', 'published');
    INSERT INTO products (id, name, description, price_minor, category_id, slug, created_at, updated_at) VALUES
      ('shirt', 'Shirt', '', 100000, 'cat_shirts', 'shirt', 100, 100),
      ('polo', 'Polo', '', 110000, 'cat_shirts', 'polo', 200, 200),
      ('mug', 'Mug', '', 20000, NULL, 'mug', 300, 300);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES
      ('var_shirt', 'shirt', 'SHIRT', 100000, 5, 1, 1),
      ('var_polo', 'polo', 'POLO', 110000, 5, 1, 1),
      ('var_mug', 'mug', 'MUG', 20000, 5, 1, 1);
  `);
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
  return async (query: string) => {
    const response = await app.request(`/api/v1/products/recommendations${query}`, {}, {} as Env);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
}

describe("GET /api/v1/products/recommendations", () => {
  it("recommends for the given products and is not captured by the product slug route", async () => {
    const request = createApp();
    const result = await request("?productIds=shirt&limit=2");

    expect(result.status).toBe(200);
    expect(result.body.data.reason).toBe("similar");
    expect(result.body.data.products.map((product: { id: string }) => product.id)).toEqual(["polo", "mug"]);
    expect(result.body.data.products[0]).toMatchObject({
      slug: "polo",
      price: 1100,
      discountedPrice: 1100,
      priceVaries: false,
      availableForSale: true,
      imageUrl: null,
      secondaryImageUrl: null,
    });
  });

  it("returns the newest products without source ids and validates the limit", async () => {
    const request = createApp();
    const newest = await request("");
    expect(newest.body.data).toMatchObject({ reason: "new_arrivals" });
    expect(newest.body.data.products.map((product: { id: string }) => product.id)).toEqual(["mug", "polo", "shirt"]);

    expect((await request("?limit=13")).status).toBe(400);
  });
});
