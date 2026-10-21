// PIM and ERP sync through the stable app API (resources-products.ts):
// `products.update` with its gallery and sales channels, `variants.create`,
// `variants.update` and `variants.restore` one SKU at a time under the
// product's revision, the ProductResource an app diffs against (options,
// option values, description, media, channels), and SKUs found by barcode.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { deleteVariant } from "@scalius/core/modules/product-admin";
import { errorResponseFromError } from "../../utils/api-response";
import { readProductRepresentations } from "../../events/representations";
import { idempotentReplay } from "./idempotency";
import { adminResourceProductRoutes } from "./resources-products";
import { adminResourceRoutes } from "./resources";

let sqlite: DatabaseSync;
let db: Database;
/** D1 round trips: a statement outside a batch is one, a whole batch is one. */
let queries = 0;
let batchStatements = 0;
let batches = 0;
const d1Calls = () => queries - batchStatements + batches;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database({
    onQuery: () => { queries += 1; },
    beforeBatch: (_sqlite, statements) => { batches += 1; batchStatements += statements.length; },
  }));
  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
    UPDATE markets SET price_increment_minor = 1 WHERE id = 'mkt_backup';
    INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
      ('media_front', 'front.jpg', 'image', 'media/front.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600),
      ('media_back', 'back.jpg', 'image', 'media/back.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600);
  `);
});
afterEach(() => sqlite.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
type Wire = { status: number; body: { data: any; error: { code: string; message: string } } };

async function call(method: string, path: string, body?: unknown): Promise<Wire> {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
    await next();
  });
  app.use("*", idempotentReplay);
  app.route("/resources", adminResourceProductRoutes);
  app.route("/resources", adminResourceRoutes);
  app.onError((error, c) => { const { body: errorBody, status } = errorResponseFromError(error); return c.json(errorBody, status); });
  const response = await app.request(`/api/v1/admin${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, {} as never);
  return { status: response.status, body: await response.json() as Wire["body"] };
}

/** A tee in sizes S and M, active, at 15.00. */
async function createTee(extra: Record<string, unknown> = {}) {
  const created = await call("POST", "/resources/products", {
    name: "Cotton tee",
    description: "<p>Soft cotton tee.</p>",
    condition: "new",
    status: "active",
    options: [{ name: "Size", values: ["S", "M"], standardMapping: "size" }],
    variants: [
      { sku: "TS-S", priceMinor: 1500, optionValues: { Size: "S" }, barcode: "4006381333931", barcodeType: "ean13" },
      { sku: "TS-M", priceMinor: 1500, optionValues: { Size: "M" } },
    ],
    mediaIds: ["media_front"],
    ...extra,
  });
  expect(created.status).toBe(201);
  return created.body.data.product;
}

async function createMug() {
  const created = await call("POST", "/resources/products", {
    name: "Mug", condition: "new", status: "active", variants: [{ sku: "MUG-1", priceMinor: 900, barcode: "5901234123457", barcodeType: "ean13" }],
  });
  expect(created.status).toBe(201);
  return created.body.data.product;
}

const variantBy = (product: { variants: Array<{ sku: string }> }, sku: string) => product.variants.find((variant) => variant.sku === sku);

describe("the product resource an app diffs against", () => {
  it("carries the description, options, option values, gallery and channels", async () => {
    const tee = await createTee();
    expect(tee).toMatchObject({
      description: "<p>Soft cotton tee.</p>",
      condition: "new",
      metaTitle: null,
      options: [{ name: "Size", standardMapping: "size", values: ["S", "M"] }],
      salesChannelIds: ["sc_agents", "sc_google", "sc_meta", "sc_online_store"],
    });
    expect(tee.media).toEqual([{ id: expect.stringMatching(/^pmed_/), mediaId: "media_front", kind: "image", url: expect.any(String), altText: null, featured: true }]);
    expect(variantBy(tee, "TS-S")).toMatchObject({ optionValues: { Size: "S" }, barcode: "4006381333931", barcodeType: "ean13", weightGrams: null, mediaId: null });

    const mug = await createMug();
    expect(mug.options).toEqual([]);
    expect(mug.variants).toEqual([expect.objectContaining({ sku: "MUG-1", isDefault: true, optionValues: {} })]);
  });

  it("reads a page of products in three D1 calls", async () => {
    const ids = [(await createTee()).id, (await createMug()).id];
    queries = 0; batchStatements = 0; batches = 0;
    const products = await readProductRepresentations(db, ids);
    expect(products.map((product) => product.id)).toEqual(ids);
    expect(d1Calls()).toBeLessThanOrEqual(3);
  });
});

describe("products.update", () => {
  it("replaces the gallery and the sales channels with the base fields in one write", async () => {
    const tee = await createTee();
    const front = tee.media[0];
    // A SKU shows the front image; replacing the gallery without it falls back to the featured one.
    const pointed = await call("PATCH", `/resources/products/${tee.id}/variants/${variantBy(tee, "TS-M")!.id}`, { expectedRevision: 1, mediaId: "media_front" });
    expect(pointed.status).toBe(200);
    expect(variantBy(pointed.body.data.product, "TS-M")).toMatchObject({ mediaId: "media_front" });

    const updated = await call("PATCH", `/resources/products/${tee.id}`, {
      expectedRevision: 2,
      name: "Organic cotton tee",
      mediaIds: ["media_back", "media_front"],
      salesChannelIds: ["sc_online_store", "sc_google"],
    });
    expect(updated.status).toBe(200);
    const product = updated.body.data.product;
    expect(product).toMatchObject({ name: "Organic cotton tee", revision: 3, salesChannelIds: ["sc_google", "sc_online_store"] });
    expect(product.media.map((item: { mediaId: string; featured: boolean }) => [item.mediaId, item.featured])).toEqual([["media_back", true], ["media_front", false]]);
    // The file it already showed keeps its use.
    expect(product.media[1].id).toBe(front.id);

    const dropped = await call("PATCH", `/resources/products/${tee.id}`, { expectedRevision: 3, mediaIds: ["media_back"] });
    expect(dropped.status).toBe(200);
    expect(dropped.body.data.product.revision).toBe(4);
    expect(variantBy(dropped.body.data.product, "TS-M")).toMatchObject({ mediaId: null });

    const stale = await call("PATCH", `/resources/products/${tee.id}`, { expectedRevision: 3, salesChannelIds: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("product_revision_conflict");
    const unknown = await call("PATCH", `/resources/products/${tee.id}`, { expectedRevision: 4, salesChannelIds: ["sc_nowhere"] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("validation_error");
    const unpublished = await call("PATCH", `/resources/products/${tee.id}`, { expectedRevision: 4, salesChannelIds: [] });
    expect(unpublished.body.data.product).toMatchObject({ revision: 5, salesChannelIds: [] });
  });
});

describe("variants.create", () => {
  it("adds a SKU for a new value under the revision, at 0 on hand", async () => {
    const tee = await createTee();
    const created = await call("POST", `/resources/products/${tee.id}/variants`, {
      expectedRevision: 1, sku: "TS-L", priceMinor: 1700, optionValues: { size: "L" }, weightGrams: 210,
    });
    expect(created.status).toBe(201);
    const product = created.body.data.product;
    expect(product.revision).toBe(2);
    expect(product.options).toEqual([expect.objectContaining({ name: "Size", values: ["S", "M", "L"] })]);
    expect(variantBy(product, "TS-L")).toMatchObject({ priceMinor: 1700, optionValues: { Size: "L" }, weightGrams: 210, isDefault: false, barcode: expect.any(String) });
    const row = sqlite.prepare("SELECT stock FROM product_variants WHERE sku = 'TS-L'").get() as { stock: number };
    expect(row.stock).toBe(0);
    // The product's price stays the lowest SKU price.
    expect(product.priceMinor).toBe(1500);

    const stale = await call("POST", `/resources/products/${tee.id}/variants`, { expectedRevision: 1, sku: "TS-XL", priceMinor: 1700, optionValues: { Size: "XL" } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("product_revision_conflict");
  });

  it("refuses a taken SKU or barcode, and a combination that is not one value of every option", async () => {
    const tee = await createTee();
    await createMug();
    const add = (body: Record<string, unknown>) => call("POST", `/resources/products/${tee.id}/variants`, { expectedRevision: 1, priceMinor: 1500, ...body });

    const takenSku = await add({ sku: "mug-1", optionValues: { Size: "L" } });
    expect(takenSku.status).toBe(409);
    expect(takenSku.body.error.code).toBe("sku_taken");
    const ownSku = await add({ sku: "ts-m", optionValues: { Size: "L" } });
    expect(ownSku.status).toBe(400);
    const takenBarcode = await add({ sku: "TS-L", optionValues: { Size: "L" }, barcode: "5901234123457", barcodeType: "ean13" });
    expect(takenBarcode.status).toBe(409);
    const ownBarcode = await add({ sku: "TS-L", optionValues: { Size: "L" }, barcode: "4006381333931", barcodeType: "ean13" });
    expect(ownBarcode.status).toBe(400);

    for (const optionValues of [{}, { Size: "L", Color: "Red" }, { Color: "Red" }]) {
      const refused = await add({ sku: "TS-L", optionValues });
      expect(refused.status, JSON.stringify(optionValues)).toBe(400);
      expect(refused.body.error.code).toBe("validation_error");
    }
    const duplicate = await add({ sku: "TS-M2", optionValues: { Size: "m" } });
    expect(duplicate.status).toBe(400);

    const mug = (await call("GET", "/resources/products?sku=MUG-1")).body.data.products[0];
    const simple = await call("POST", `/resources/products/${mug.id}/variants`, { expectedRevision: 1, sku: "MUG-2", priceMinor: 900, optionValues: { Size: "L" } });
    expect(simple.status).toBe(400);
    // Nothing above wrote anything.
    expect((await call("GET", `/resources/products/${tee.id}`)).body.data.product.revision).toBe(1);
  });
});

describe("variants.update", () => {
  it("changes a SKU's code, price, barcode and weight under the revision, stock untouched", async () => {
    const tee = await createTee();
    sqlite.exec("UPDATE product_variants SET stock = 7 WHERE sku = 'TS-M'");
    const medium = variantBy(tee, "TS-M")!;
    const updated = await call("PATCH", `/resources/products/${tee.id}/variants/${medium.id}`, {
      expectedRevision: 1, sku: "TEE-M", priceMinor: 1600, barcode: "036000291452", barcodeType: "upc", weightGrams: 180,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.product.revision).toBe(2);
    expect(variantBy(updated.body.data.product, "TEE-M")).toMatchObject({ id: medium.id, priceMinor: 1600, barcode: "036000291452", barcodeType: "upc", weightGrams: 180, optionValues: { Size: "M" } });
    expect((sqlite.prepare("SELECT stock FROM product_variants WHERE id = ?").get(medium.id) as { stock: number }).stock).toBe(7);

    const stale = await call("PATCH", `/resources/products/${tee.id}/variants/${medium.id}`, { expectedRevision: 1, priceMinor: 1700 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("product_revision_conflict");
    await createMug();
    const takenSku = await call("PATCH", `/resources/products/${tee.id}/variants/${medium.id}`, { expectedRevision: 2, sku: "MUG-1" });
    expect(takenSku.status).toBe(409);
    expect(takenSku.body.error.code).toBe("sku_taken");
    const takenBarcode = await call("PATCH", `/resources/products/${tee.id}/variants/${medium.id}`, { expectedRevision: 2, barcode: "4006381333931", barcodeType: "ean13" });
    expect(takenBarcode.status).toBe(409);
    const cleared = await call("PATCH", `/resources/products/${tee.id}/variants/${medium.id}`, { expectedRevision: 2, barcode: null });
    expect(variantBy(cleared.body.data.product, "TEE-M")).toMatchObject({ barcode: null, barcodeType: null });
  });

  it("moves a SKU to another value, and refuses a shape that is not one value of every option", async () => {
    const tee = await createTee();
    const medium = variantBy(tee, "TS-M")!;
    const moved = await call("PATCH", `/resources/products/${tee.id}/variants/${medium.id}`, { expectedRevision: 1, optionValues: { Size: "XL" } });
    expect(moved.status).toBe(200);
    // M has no SKU any more and leaves the option.
    expect(moved.body.data.product.options[0].values).toEqual(["S", "XL"]);
    expect(variantBy(moved.body.data.product, "TS-M")).toMatchObject({ id: medium.id, optionValues: { Size: "XL" } });
    for (const optionValues of [{}, { Size: "XL", Color: "Red" }]) {
      const refused = await call("PATCH", `/resources/products/${tee.id}/variants/${medium.id}`, { expectedRevision: 2, optionValues });
      expect(refused.status).toBe(400);
    }
    const clash = await call("PATCH", `/resources/products/${tee.id}/variants/${medium.id}`, { expectedRevision: 2, optionValues: { Size: "S" } });
    expect(clash.status).toBe(400);
  });

  it("prices the single SKU of a product without options through the product", async () => {
    const mug = await createMug();
    const sku = mug.variants[0];
    const updated = await call("PATCH", `/resources/products/${mug.id}/variants/${sku.id}`, { expectedRevision: 1, sku: "MUG-RED", priceMinor: 1100 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.product).toMatchObject({ revision: 2, priceMinor: 1100 });
    expect(updated.body.data.product.variants).toEqual([expect.objectContaining({ id: sku.id, sku: "MUG-RED", priceMinor: 1100, isDefault: true })]);
    expect((await call("PATCH", `/resources/products/${mug.id}/variants/${sku.id}`, { expectedRevision: 2, optionValues: { Size: "L" } })).status).toBe(400);
    expect((await call("PATCH", `/resources/products/${mug.id}/variants/${sku.id}`, { expectedRevision: 2, priceMinor: 0 })).status).toBe(400);
  });
});

describe("variants.restore", () => {
  it("brings a retired SKU back with its id, code and stock, under the revision", async () => {
    const tee = await createTee();
    const medium = variantBy(tee, "TS-M")!;
    sqlite.exec(`UPDATE product_variants SET stock = 3 WHERE id = '${medium.id}'`);
    const { aggregateRevision } = await deleteVariant(db, tee.id, medium.id, 1);
    expect(aggregateRevision).toBe(2);

    const lookup = await call("POST", "/resources/variants/lookup", { skus: ["ts-m"] });
    expect(lookup.body.data.variants).toEqual([expect.objectContaining({ id: medium.id, retiredAt: expect.any(String) })]);

    const stale = await call("POST", `/resources/products/${tee.id}/variants/${medium.id}/restore`, { expectedRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("product_revision_conflict");
    const restored = await call("POST", `/resources/products/${tee.id}/variants/${medium.id}/restore`, { expectedRevision: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.data.product.revision).toBe(3);
    expect(variantBy(restored.body.data.product, "TS-M")).toMatchObject({ id: medium.id, optionValues: { Size: "M" } });
    expect((sqlite.prepare("SELECT stock, deleted_at FROM product_variants WHERE id = ?").get(medium.id) as { stock: number; deleted_at: number | null }))
      .toEqual({ stock: 3, deleted_at: null });
    const again = await call("POST", `/resources/products/${tee.id}/variants/${medium.id}/restore`, { expectedRevision: 3 });
    expect(again.status).toBe(409);
  });

  it("comes back through variants.create too: a retired combination added again is its old SKU", async () => {
    const tee = await createTee();
    const medium = variantBy(tee, "TS-M")!;
    await deleteVariant(db, tee.id, medium.id, 1);
    const replaced = await call("POST", `/resources/products/${tee.id}/variants`, { expectedRevision: 2, sku: "TS-M-NEW", priceMinor: 1500, optionValues: { Size: "M" } });
    // The combination's retired SKU comes back under the new code.
    expect(replaced.status).toBe(201);
    expect(variantBy(replaced.body.data.product, "TS-M-NEW")).toMatchObject({ id: medium.id });
    const restore = await call("POST", `/resources/products/${tee.id}/variants/${medium.id}/restore`, { expectedRevision: 3 });
    expect(restore.status).toBe(409);
  });
});

describe("variants.lookup", () => {
  it("finds SKUs by barcode, any case, in the order asked", async () => {
    const tee = await createTee();
    const found = await call("POST", "/resources/variants/lookup", { barcodes: ["missing", " 4006381333931 "] });
    expect(found.status).toBe(200);
    expect(found.body.data.variants).toEqual([expect.objectContaining({ id: variantBy(tee, "TS-S")!.id, sku: "TS-S", barcode: "4006381333931", onHand: 0, retiredAt: null })]);
    expect((await call("POST", "/resources/variants/lookup", { skus: ["TS-S"], barcodes: ["4006381333931"] })).status).toBe(400);
    expect((await call("POST", "/resources/variants/lookup", {})).status).toBe(400);
  });
});
