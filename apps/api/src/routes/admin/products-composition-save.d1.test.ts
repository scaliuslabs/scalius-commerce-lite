// One product Save is one write: the details, options, SKUs, content blocks,
// quantity bundles, page template, EMI line and costs per item the editor
// changed go in a single PUT /products/{id} and one guarded batch, so a save
// the server refuses (stock allocation, a taken SKU, a stale revision, a
// section's own rule, a cost or file that changed meanwhile) leaves the
// product exactly as it was.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { DIGITAL_STOCK_IS_KEYS_MESSAGE, DIGITAL_STOCK_IS_KEYS_REASON } from "@scalius/core/modules/products";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

import { errorResponseFromError } from "../../utils/api-response";
import { adminProductsRoutes } from "./products";

let sqlite: DatabaseSync;
let db: Database;
/** Runs against the database just before the next batch (a change that lands meanwhile). */
let raceNextBatch: ((sqlite: DatabaseSync) => void) | undefined;

beforeEach(() => {
  permissions = EDITOR;
  ({ sqlite, db } = createSqliteD1Database({
    beforeBatch(sqlite) {
      const race = raceNextBatch;
      raceNextBatch = undefined;
      race?.(sqlite);
    },
  }));
  sqlite.exec(`
    INSERT INTO products (id, name, price_minor, slug, is_active, aggregate_revision)
      VALUES ('prod_copy', 'Panjabi (copy)', 123400, 'panjabi-copy', 0, 3);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
      VALUES ('var_default', 'prod_copy', 'PANJABI-COPY', 123400, 0, 0, 1, 1);
    INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('prod_other', 'Kurta', 50000, 'kurta', 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
      VALUES ('var_other', 'prod_other', 'KURTA-RED', 50000, 4, 0, 1, 1);
    INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, alt_text, width, height)
      VALUES ('med_photo', 'panjabi.jpg', 'image', 'media/panjabi.jpg', 1, 'image/jpeg', 'ready', 'Panjabi', 800, 600);
    UPDATE product_variants SET cost_minor = 40000 WHERE id = 'var_default';
  `);
});
afterEach(() => sqlite.close());

/** The editor's staff member: edits products and sees their costs. */
const EDITOR = [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.PRODUCTS_ADJUST_STOCK, PERMISSIONS.PRODUCTS_VIEW_COSTS];
let permissions: readonly string[] = EDITOR;

function app() {
  const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  router.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("adminPermissions", new Set(permissions));
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
    product: sqlite.prepare("SELECT name, price_minor, aggregate_revision, page_template, emi_eligible FROM products WHERE id = 'prod_copy'").get(),
    variants: sqlite.prepare("SELECT id, sku, stock, cost_minor, deleted_at IS NOT NULL AS retired FROM product_variants WHERE product_id = 'prod_copy' ORDER BY sku").all(),
    options: sqlite.prepare("SELECT count(*) AS n FROM product_option_definitions WHERE product_id = 'prod_copy'").get(),
    movements: sqlite.prepare("SELECT count(*) AS n FROM inventory_movements").get(),
    blocks: sqlite.prepare("SELECT type, placement, settings FROM product_content_blocks WHERE product_id = 'prod_copy' ORDER BY placement, position").all(),
    bundles: sqlite.prepare("SELECT quantity, discount_bps FROM product_bundles WHERE product_id = 'prod_copy' ORDER BY quantity").all(),
  };
}

/** Everything else on the editor's page a merchant may change in the same Save. */
const sections = (overrides: Record<string, unknown> = {}) => ({
  contentBlocks: [
    { placement: "tabs", type: "faq", version: 1, settings: { heading: "", items: [{ question: "Cotton?", answer: "Yes" }] } },
    { placement: "after-buy-box", type: "image-with-text", version: 1, settings: { heading: "Woven", body: "", mediaId: "med_photo", imageSide: "start", cta: null } },
  ],
  bundles: [{ quantity: 2, discountType: "percentage", discountPercentage: 10, label: "Pair", isActive: true }],
  pageTemplate: null,
  emiEligible: false,
  ...overrides,
});

describe("PUT /products/{id} with the editor's variants", () => {
  it("saves the title, price, options and variant quantities of a product with no stock in one revision", async () => {
    // The variants carry the prices: the product shows the cheapest, whatever the price field says.
    const saved = await call("PUT", "/products/prod_copy", details({ price: 1000, optionMatrix: colours() }));

    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ aggregateRevision: 4 });
    const after = snapshot();
    expect(after.product).toMatchObject({ name: "Eid Panjabi", price_minor: 90000, aggregate_revision: 4 });
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
    expect(refused.body.error.code).toBe("sku_taken");
    expect(refused.body.error.details).toMatchObject({ field: "optionMatrix.variants.0.sku" });
    expect(snapshot()).toEqual(before);
  });

  it("changes nothing when the product changed since the editor loaded it", async () => {
    const before = snapshot();

    const stale = await call("PUT", "/products/prod_copy", details({ expectedAggregateRevision: 2, optionMatrix: colours() }));

    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("product_revision_conflict");
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

describe("PUT /products/{id} with the page's sections and costs", () => {
  it("saves details, variants, content blocks, bundles, EMI and costs (new rows by draft id) in one revision", async () => {
    const saved = await call("PUT", "/products/prod_copy", details({
      optionMatrix: colours(),
      ...sections(),
      skuCosts: [{ variantId: "draft_red", cost: 420.5, expectedCost: null }, { variantId: "draft_blue", cost: 430, expectedCost: null }],
    }));

    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ aggregateRevision: 4 });
    const after = snapshot();
    expect(after.product).toMatchObject({ name: "Eid Panjabi", price_minor: 90000, aggregate_revision: 4, emi_eligible: 0 });
    expect(after.variants).toEqual([
      expect.objectContaining({ sku: "EID-BLUE", stock: 2, cost_minor: 43000, retired: 0 }),
      expect.objectContaining({ sku: "EID-RED", stock: 1, cost_minor: 42050, retired: 0 }),
      expect.objectContaining({ id: "var_default", retired: 1 }),
    ]);
    expect(after.blocks.map((block) => (block as { type: string }).type)).toEqual(["image-with-text", "faq"]);
    expect(after.bundles).toEqual([{ quantity: 2, discount_bps: 1000 }]);
  });

  it("saves sections alone without rewriting unchanged details, still under the revision", async () => {
    const unchanged = details({ name: "Panjabi (copy)", price: 1234 });

    const saved = await call("PUT", "/products/prod_copy", { ...unchanged, bundles: sections().bundles, skuCosts: [{ variantId: "var_default", cost: 450, expectedCost: 400 }] });

    expect(saved.status).toBe(200);
    expect(snapshot()).toMatchObject({
      product: { name: "Panjabi (copy)", price_minor: 123400, aggregate_revision: 4 },
      variants: [{ id: "var_default", cost_minor: 45000 }],
      bundles: [{ quantity: 2, discount_bps: 1000 }],
    });
    // The hidden SKU's price was not rewritten (details unchanged); only its cost moved.
    expect(sqlite.prepare("SELECT price_minor FROM product_variants WHERE id = 'var_default'").get()).toEqual({ price_minor: 123400 });

    // The same Save again changes nothing at all: no revision bump.
    const again = await call("PUT", "/products/prod_copy", { ...unchanged, expectedAggregateRevision: 4 });
    expect(again.body.data).toEqual({ aggregateRevision: 4 });
  });

  it.each([
    ["a content block the section refuses", { contentBlocks: [{ placement: "tabs", type: "faq", version: 1, settings: { heading: "", items: [] } }] }, 400],
    ["a content block file that is unavailable", { contentBlocks: [{ placement: "after-buy-box", type: "image-with-text", version: 1, settings: { heading: "", body: "", mediaId: "med_gone", imageSide: "start", cta: null } }] }, 400],
    ["quantity bundles the section refuses", { bundles: [{ quantity: 2, discountType: "percentage", discountPercentage: 10, label: null, isActive: true }, { quantity: 2, discountType: "percentage", discountPercentage: 20, label: null, isActive: true }] }, 400],
    ["a cost for a SKU that is not this product's", { skuCosts: [{ variantId: "var_other", cost: 10, expectedCost: null }] }, 400],
    ["a cost that changed since the editor showed it", { skuCosts: [{ variantId: "var_default", cost: 450, expectedCost: 399 }] }, 409],
  ])("changes nothing when the Save carries %s", async (_label, part, status) => {
    const before = snapshot();

    const refused = await call("PUT", "/products/prod_copy", details({ ...sections(), ...part }));

    expect(refused.status).toBe(status);
    expect(snapshot()).toEqual(before);
  });

  it("changes nothing when a content block's file is trashed while the Save is on its way", async () => {
    const before = snapshot();
    raceNextBatch = (sqlite) => sqlite.exec("UPDATE media SET status = 'trashed', trashed_at = unixepoch() WHERE id = 'med_photo'");

    const refused = await call("PUT", "/products/prod_copy", details({ optionMatrix: colours(), ...sections() }));

    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toMatchObject({ field: "contentBlocks" });
    expect(snapshot()).toEqual({ ...before });
  });

  it("changes nothing when a receipt moves a cost while the Save is on its way", async () => {
    const before = snapshot();
    raceNextBatch = (sqlite) => sqlite.exec("UPDATE product_variants SET cost_minor = 41000 WHERE id = 'var_default'");

    const refused = await call("PUT", "/products/prod_copy", details({ ...sections(), skuCosts: [{ variantId: "var_default", cost: 450, expectedCost: 400 }] }));

    expect(refused.status).toBe(409);
    expect(snapshot()).toEqual({ ...before, variants: [expect.objectContaining({ id: "var_default", cost_minor: 41000 })] });
  });
});

describe("costs per item without View product costs", () => {
  beforeEach(() => {
    permissions = [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.PRODUCTS_ADJUST_STOCK];
  });

  it("leaves every SKU's cost out of the product and its variants", async () => {
    const product = await call("GET", "/products/prod_copy");
    expect(product.status).toBe(200);
    expect(product.body.data.variants[0]).toMatchObject({ id: "var_default", sku: "PANJABI-COPY" });
    expect(product.body.data.variants[0]).not.toHaveProperty("cost");
    const variants = await call("GET", "/products/prod_copy/variants");
    expect(variants.body.data.variants[0]).not.toHaveProperty("cost");

    permissions = EDITOR;
    expect((await call("GET", "/products/prod_copy")).body.data.variants[0]).toMatchObject({ cost: 400 });
  });

  it("refuses a Save that sets a cost and changes nothing; the same Save without costs is saved", async () => {
    const before = snapshot();
    const refused = await call("PUT", "/products/prod_copy", details({ skuCosts: [{ variantId: "var_default", cost: 450, expectedCost: 400 }] }));
    expect(refused.status).toBe(403);
    expect(snapshot()).toEqual(before);

    const saved = await call("PUT", "/products/prod_copy", details());
    expect(saved.status).toBe(200);
    expect(sqlite.prepare("SELECT cost_minor FROM product_variants WHERE id = 'var_default'").get()).toEqual({ cost_minor: 40000 });
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
    expect(refused.body.error.code).toBe("sku_taken");
    expect(snapshot()).toEqual(before);
  });

  it("changes nothing when the quantity was counted from an old stock version", async () => {
    const before = snapshot();

    const refused = await call("PUT", "/products/prod_copy", details({ defaultSku: simple({ stock: 6, expectedStockVersion: 7 }) }));

    expect(refused.status).toBe(409);
    expect(snapshot()).toEqual(before);
  });
});

describe("PUT /products/{id} with a digital SKU, whose stock is its licence keys", () => {
  const digitalRule = { code: "validation_error", message: DIGITAL_STOCK_IS_KEYS_MESSAGE, details: { reason: DIGITAL_STOCK_IS_KEYS_REASON } };

  it("refuses the hidden SKU's quantity inside a combined save and changes nothing", async () => {
    sqlite.exec("UPDATE product_variants SET fulfillment_kind = 'digital' WHERE id = 'var_default'");
    const before = snapshot();

    const refused = await call("PUT", "/products/prod_copy", details({
      ...sections(),
      defaultSku: { sku: "EID-KEYS", trackInventory: true, weight: null, barcode: null, barcodeType: null, stock: 5, expectedStockVersion: 1 },
      skuCosts: [{ variantId: "var_default", cost: 450, expectedCost: 400 }],
    }));

    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject(digitalRule);
    expect(snapshot()).toEqual(before);
  });

  it("refuses an option SKU's quantity inside a combined save and changes nothing", async () => {
    // Red and Blue licence-key SKUs, saved without a quantity.
    const digital = (row: ReturnType<typeof variant>) => ({ ...row, fulfillmentKind: "digital" });
    const matrix = colours({ stock: 0 }, { stock: 0 });
    const created = await call("PUT", "/products/prod_copy", details({
      optionMatrix: { ...matrix, variants: matrix.variants.map(digital) },
    }));
    expect(created.status).toBe(200);
    const option = sqlite.prepare("SELECT id, name, standard_mapping FROM product_option_definitions WHERE product_id = 'prod_copy' AND deleted_at IS NULL").get() as { id: string; name: string; standard_mapping: string };
    const values = sqlite.prepare("SELECT id, value FROM product_option_values WHERE option_definition_id = ? AND deleted_at IS NULL ORDER BY position").all(option.id) as Array<{ id: string; value: string }>;
    const skus = sqlite.prepare(`SELECT v.id, v.sku, v.stock_version, o.option_value_id FROM product_variants v
      JOIN product_variant_option_values o ON o.variant_id = v.id
      WHERE v.product_id = 'prod_copy' AND v.deleted_at IS NULL ORDER BY v.sku`).all() as Array<{ id: string; sku: string; stock_version: number; option_value_id: string }>;
    const revision = (sqlite.prepare("SELECT aggregate_revision FROM products WHERE id = 'prod_copy'").get() as { aggregate_revision: number }).aggregate_revision;
    const before = snapshot();

    // The same Save also renames the product, adds blocks and a bundle and sets a cost.
    const refused = await call("PUT", "/products/prod_copy", details({
      ...sections(),
      expectedAggregateRevision: revision,
      optionMatrix: {
        options: [{ id: option.id, name: option.name, standardMapping: option.standard_mapping, values: values.map(({ id, value }) => ({ id, value })) }],
        variants: skus.map((sku) => ({
          ...variant(sku.id, sku.option_value_id, sku.sku, sku.sku === "EID-RED" ? 4 : 0),
          expectedStockVersion: sku.stock_version,
        })),
      },
      skuCosts: [{ variantId: skus[0]!.id, cost: 450, expectedCost: null }],
    }));

    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject(digitalRule);
    expect(snapshot()).toEqual(before);
  });
});
