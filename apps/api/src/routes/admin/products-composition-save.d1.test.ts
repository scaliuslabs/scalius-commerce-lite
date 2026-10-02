// One product Save is one write: the details, options and SKUs the editor
// changed go in a single PUT /products/{id} and one guarded batch, so a save
// the server refuses (stock allocation, a taken SKU, a stale revision) leaves
// the product exactly as it was.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../utils/api-response";
import { adminProductsRoutes } from "./products";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO products (id, name, price_minor, slug, is_active, aggregate_revision)
      VALUES ('prod_copy', 'Panjabi (copy)', 123400, 'panjabi-copy', 0, 3);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
      VALUES ('var_default', 'prod_copy', 'PANJABI-COPY', 123400, 0, 0, 1, 1);
    INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('prod_other', 'Kurta', 50000, 'kurta', 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
      VALUES ('var_other', 'prod_other', 'KURTA-RED', 50000, 4, 0, 1, 1);
  `);
});
afterEach(() => sqlite.close());

function app() {
  const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  router.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  router.route("/products", adminProductsRoutes);
  router.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  return router;
}

async function call(method: string, path: string, body?: unknown) {
  const response = await app().request(`/api/v1/admin${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }, {} as Env);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON body freely
  return { status: response.status, body: await response.json() as { data: any; error: { code: string; message: string; details?: any } } };
}

/** The editor's product fields after the merchant changed the title and price. */
const details = (overrides: Record<string, unknown> = {}) => ({
  id: "prod_copy",
  expectedAggregateRevision: 3,
  name: "Eid Panjabi",
  description: null,
  price: 900,
  categoryId: null,
  isActive: false,
  discountType: "percentage",
  discountPercentage: 0,
  discountAmount: 0,
  freeDelivery: false,
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  excludeFromProductFeed: false,
  productCondition: null,
  slug: "panjabi-copy",
  media: [],
  attributes: [],
  additionalInfo: [],
  ...overrides,
});

const variant = (id: string, valueId: string, sku: string, stock: number) => ({
  id, selectedOptionValueIds: [valueId], imageId: null, sku, price: 900, stock, trackInventory: true,
  weight: null, barcode: null, barcodeType: null, discountType: "percentage", discountPercentage: 0, discountAmount: null,
});

/** Red and Blue variants, the way the editor drafts them for a product that had no options. */
const colours = (red: { sku?: string; stock?: number } = {}, blue: { sku?: string; stock?: number } = {}) => ({
  options: [{
    id: "draft_option_colour",
    name: "Colour",
    standardMapping: "color",
    values: [{ id: "draft_value_red", value: "Red" }, { id: "draft_value_blue", value: "Blue" }],
  }],
  variants: [
    variant("draft_red", "draft_value_red", red.sku ?? "EID-RED", red.stock ?? 1),
    variant("draft_blue", "draft_value_blue", blue.sku ?? "EID-BLUE", blue.stock ?? 2),
  ],
});

function snapshot() {
  return {
    product: sqlite.prepare("SELECT name, price_minor, aggregate_revision FROM products WHERE id = 'prod_copy'").get(),
    variants: sqlite.prepare("SELECT id, sku, stock, deleted_at IS NOT NULL AS retired FROM product_variants WHERE product_id = 'prod_copy' ORDER BY sku").all(),
    options: sqlite.prepare("SELECT count(*) AS n FROM product_option_definitions WHERE product_id = 'prod_copy'").get(),
    movements: sqlite.prepare("SELECT count(*) AS n FROM inventory_movements").get(),
  };
}

describe("PUT /products/{id} with the editor's variants", () => {
  it("saves the title, price, options and variant quantities of a product with no stock in one revision", async () => {
    // The variants carry the prices: the product shows the cheapest, whatever the price field says.
    const saved = await call("PUT", "/products/prod_copy", details({ price: 1000, optionMatrix: colours() }));

    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ aggregateRevision: 4 });
    const after = snapshot();
    expect(after.product).toEqual({ name: "Eid Panjabi", price_minor: 90000, aggregate_revision: 4 });
    expect(after.variants).toEqual([
      expect.objectContaining({ sku: "EID-BLUE", stock: 2, retired: 0 }),
      expect.objectContaining({ sku: "EID-RED", stock: 1, retired: 0 }),
      expect.objectContaining({ id: "var_default", stock: 0, retired: 1 }),
    ]);
    expect(after.options).toEqual({ n: 1 });
  });

  it("changes nothing when the variants are refused (stock that must be allocated)", async () => {
    sqlite.exec("UPDATE product_variants SET stock = 5 WHERE id = 'var_default'");
    const before = snapshot();

    const refused = await call("PUT", "/products/prod_copy", details({ optionMatrix: colours() }));

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/Allocate exactly 5 on-hand units/);
    expect(snapshot()).toEqual(before);
  });

  it("changes nothing when a variant SKU is taken by another product", async () => {
    const before = snapshot();

    const refused = await call("PUT", "/products/prod_copy", details({ optionMatrix: colours({ sku: "kurta-red" }) }));

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SKU_TAKEN");
    expect(refused.body.error.details).toMatchObject({ field: "optionMatrix.variants.0.sku" });
    expect(snapshot()).toEqual(before);
  });

  it("changes nothing when the product changed since the editor loaded it", async () => {
    const before = snapshot();

    const stale = await call("PUT", "/products/prod_copy", details({ expectedAggregateRevision: 2, optionMatrix: colours() }));

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("PRODUCT_REVISION_CONFLICT");
    expect(snapshot()).toEqual(before);
  });

  it("refuses an active product's unpriced variant before writing anything", async () => {
    const before = snapshot();
    const matrix = colours();
    matrix.variants[1]!.price = 0;

    const refused = await call("PUT", "/products/prod_copy", details({ isActive: true, optionMatrix: matrix }));

    expect(refused.status).toBe(400);
    expect(snapshot()).toEqual(before);
  });
});

describe("PUT /products/{id} with the hidden SKU of a product without options", () => {
  const simple = (overrides: Record<string, unknown> = {}) => ({
    sku: "EID-PANJABI", trackInventory: true, weight: null, barcode: null, barcodeType: null, ...overrides,
  });

  it("saves the details and the SKU's code and quantity together", async () => {
    const saved = await call("PUT", "/products/prod_copy", details({ defaultSku: simple({ stock: 6, expectedStockVersion: 1 }) }));

    expect(saved.status).toBe(200);
    expect(snapshot()).toMatchObject({
      product: { name: "Eid Panjabi", price_minor: 90000, aggregate_revision: 4 },
      variants: [{ id: "var_default", sku: "EID-PANJABI", stock: 6, retired: 0 }],
      movements: { n: 1 },
    });
    expect(sqlite.prepare("SELECT price_minor FROM product_variants WHERE id = 'var_default'").get()).toEqual({ price_minor: 90000 });
  });

  it("changes nothing when the SKU code is taken", async () => {
    const before = snapshot();

    const refused = await call("PUT", "/products/prod_copy", details({ defaultSku: simple({ sku: "KURTA-RED" }) }));

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SKU_TAKEN");
    expect(snapshot()).toEqual(before);
  });

  it("changes nothing when the quantity was counted from an old stock version", async () => {
    const before = snapshot();

    const refused = await call("PUT", "/products/prod_copy", details({ defaultSku: simple({ stock: 6, expectedStockVersion: 7 }) }));

    expect(refused.status).toBe(409);
    expect(snapshot()).toEqual(before);
  });
});
