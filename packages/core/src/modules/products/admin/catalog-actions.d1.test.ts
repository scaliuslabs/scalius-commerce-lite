import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { MAX_PRODUCT_PRICE } from "@scalius/shared/product-options";
import { bulkUpdateProducts } from "./lifecycle";
import { createProduct, duplicateProduct, updateProduct } from "./write";
import { getProductsByIds, listProducts } from "./read";
import { saveProductOptionMatrix } from "../option-matrix";
import { updateVariantSchema } from "../types";
import { createProductSchema, updateProductSchema } from "../validation";
import { deleteVariant, SkuTakenError, updateVariant } from "../variants";
import { ValidationError } from "../../../errors";

vi.mock("../../inventory/alerts", () => ({ checkAndAlertLowStock: vi.fn() }));

const base = {
  description: null,
  price: 250,
  categoryId: "cat_1",
  isActive: false,
  discountType: "percentage" as const,
  discountPercentage: 0,
  discountAmount: 0,
  freeDelivery: false,
  metaTitle: null,
  metaDescription: null,
  canonicalPath: null,
  noIndex: false,
  excludeFromSitemap: false,
  excludeFromProductFeed: false,
  productCondition: "new" as const,
  media: [],
  attributes: [],
  additionalInfo: [],
};

function variant(id: string, valueId: string, sku: string, price = 250) {
  return {
    id, selectedOptionValueIds: [valueId], imageId: null, sku, price, stock: 3, trackInventory: true,
    weight: 400, barcode: null, barcodeType: null, discountType: "percentage" as const,
    discountPercentage: null, discountAmount: null,
  };
}

describe("catalog actions on D1 storage", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec("INSERT INTO categories (id, name, slug) VALUES ('cat_1', 'Tees', 'tees'), ('cat_2', 'Panjabi', 'panjabi');");
  });
  afterEach(() => sqlite.close());

  const create = (input: Record<string, unknown>) => createProduct(db, createProductSchema.parse({ ...base, ...input }));

  it("rejects prices above the supported maximum and active products without a price", () => {
    expect(createProductSchema.safeParse({ ...base, name: "Too dear", slug: "too-dear", price: 99_999_999_999 }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, name: "Top price", slug: "top-price", price: MAX_PRODUCT_PRICE }).success).toBe(true);
    const free = createProductSchema.safeParse({ ...base, name: "Free tee", slug: "free-tee", price: 0, isActive: true });
    expect(free.success).toBe(false);
    expect(free.error?.issues[0]?.path).toEqual(["price"]);
    expect(createProductSchema.safeParse({ ...base, name: "Draft tee", slug: "draft-tee", price: 0 }).success).toBe(true);
  });

  it("names the product that already owns a SKU, case- and space-insensitively", async () => {
    await create({ name: "Cotton tee", slug: "cotton-tee", defaultSku: { sku: "TEE-01", trackInventory: true, stock: 2 } });
    const error = await create({
      name: "Other tee", slug: "other-tee", defaultSku: { sku: " tee-01 ", trackInventory: false, stock: 0 },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SkuTakenError);
    expect((error as SkuTakenError).details).toMatchObject({ field: "defaultSku.sku", productName: "Cotton tee" });
  });

  it("generates readable simple SKUs from the title and numbers repeats", async () => {
    const first = await create({ name: "Cotton tee", slug: "cotton-tee" });
    const second = await create({ name: "Cotton  tee!", slug: "cotton-tee-2" });
    const skus = sqlite.prepare("SELECT product_id, sku FROM product_variants").all();
    expect(skus).toEqual(expect.arrayContaining([
      { product_id: first.id, sku: "COTTON-TEE" },
      { product_id: second.id, sku: "COTTON-TEE-2" },
    ]));
  });

  it("requires variant prices above 0 when an active product's options are saved", async () => {
    const product = await create({
      name: "Panjabi", slug: "panjabi", isActive: true,
      optionMatrix: {
        options: [{ id: "o", name: "Size", standardMapping: "size", values: [{ id: "m", value: "M" }] }],
        variants: [variant("s", "m", "PANJABI-M")],
      },
    });
    const saved = sqlite.prepare("SELECT id FROM product_variants WHERE product_id = ?").get(product.id) as { id: string };
    const option = sqlite.prepare("SELECT d.id AS optionId, v.id AS valueId FROM product_option_definitions d JOIN product_option_values v ON v.option_definition_id = d.id WHERE d.product_id = ?").get(product.id) as { optionId: string; valueId: string };
    await expect(saveProductOptionMatrix(db, product.id, {
      options: [{ id: option.optionId, name: "Size", standardMapping: "size", values: [{ id: option.valueId, value: "M" }] }],
      variants: [{ ...variant(saved.id, option.valueId, "PANJABI-M", 0), stock: undefined }],
      expectedAggregateRevision: product.aggregateRevision,
    })).rejects.toMatchObject({ status: 400, details: { field: "variants.0.price" } });
  });

  it("sets status and category on many products at once, skipping and naming unpriced ones", async () => {
    const tee = await create({ name: "Cotton tee", slug: "cotton-tee" });
    const mug = await create({ name: "Mug", slug: "mug" });
    const free = await create({ name: "Free sample", slug: "free-sample", price: 0 });

    const first = await bulkUpdateProducts(db, [
      { id: tee.id, expectedAggregateRevision: 1 },
      { id: mug.id, expectedAggregateRevision: 1 },
    ], { isActive: true, categoryId: "cat_2" });
    expect(first).toEqual({
      products: [{ id: tee.id, aggregateRevision: 2 }, { id: mug.id, aggregateRevision: 2 }],
      skipped: [],
    });
    expect(sqlite.prepare("SELECT is_active, category_id FROM products WHERE id IN (?, ?)").all(tee.id, mug.id))
      .toEqual([{ is_active: 1, category_id: "cat_2" }, { is_active: 1, category_id: "cat_2" }]);

    // The priced product still changes; the unpriced one is left as it was and named.
    const mixed = await bulkUpdateProducts(db, [
      { id: mug.id, expectedAggregateRevision: 2 },
      { id: free.id, expectedAggregateRevision: 1 },
    ], { isActive: true, categoryId: "cat_1" });
    expect(mixed).toEqual({
      products: [{ id: mug.id, aggregateRevision: 3 }],
      skipped: [{ id: free.id, name: "Free sample", reason: "needs_price" }],
    });
    expect(sqlite.prepare("SELECT is_active, category_id FROM products WHERE id = ?").get(free.id))
      .toEqual({ is_active: 0, category_id: "cat_1" });
    // A stale claim rolls every applied change back.
    await expect(bulkUpdateProducts(db, [
      { id: tee.id, expectedAggregateRevision: 2 },
      { id: mug.id, expectedAggregateRevision: 1 },
    ], { isActive: false })).rejects.toMatchObject({ code: "PRODUCT_REVISION_CONFLICT" });
    expect(sqlite.prepare("SELECT is_active FROM products WHERE id = ?").get(tee.id)).toEqual({ is_active: 1 });
  });

  it("duplicates a product with options as a draft with new SKUs and no stock", async () => {
    const source = await create({
      name: "Panjabi", slug: "panjabi", isActive: true,
      optionMatrix: {
        options: [{ id: "o", name: "Size", standardMapping: "size", values: [{ id: "m", value: "M" }, { id: "l", value: "L" }] }],
        variants: [variant("s1", "m", "PANJABI-M"), variant("s2", "l", "PANJABI-L", 300)],
      },
    });
    const copy = await duplicateProduct(db, source.id, "Copy of Panjabi");
    const again = await duplicateProduct(db, source.id, "Copy of Panjabi");

    expect(sqlite.prepare("SELECT name, slug, is_active FROM products WHERE id = ?").get(copy.id))
      .toEqual({ name: "Copy of Panjabi", slug: "panjabi-copy", is_active: 0 });
    expect(sqlite.prepare("SELECT slug FROM products WHERE id = ?").get(again.id)).toEqual({ slug: "panjabi-copy-2" });
    expect(sqlite.prepare("SELECT sku, stock, weight FROM product_variants WHERE product_id = ? AND deleted_at IS NULL ORDER BY sku").all(copy.id))
      .toEqual([
        { sku: "PANJABI-L-COPY", stock: 0, weight: 400 },
        { sku: "PANJABI-M-COPY", stock: 0, weight: 400 },
      ]);
    expect(sqlite.prepare("SELECT sku FROM product_variants WHERE product_id = ? ORDER BY sku").all(again.id))
      .toEqual([{ sku: "PANJABI-L-COPY-2" }, { sku: "PANJABI-M-COPY-2" }]);
  });

  it("copies only the option values a live SKU sells, and refuses an uncopyable product with a 400", async () => {
    const source = await create({
      name: "Panjabi", slug: "panjabi", isActive: true,
      optionMatrix: {
        options: [{ id: "o", name: "Size", standardMapping: "size", values: [{ id: "m", value: "M" }, { id: "l", value: "L" }] }],
        variants: [variant("s1", "m", "PANJABI-M"), variant("s2", "l", "PANJABI-L", 300)],
      },
    });
    // Removing the L SKU leaves the L value on the product, sold by nothing.
    const large = sqlite.prepare("SELECT id FROM product_variants WHERE sku = 'PANJABI-L'").get() as { id: string };
    await deleteVariant(db, source.id, large.id, 1);

    const copy = await duplicateProduct(db, source.id, "Copy of Panjabi");
    expect(sqlite.prepare(`
      SELECT value.value FROM product_option_values value
      JOIN product_option_definitions axis ON axis.id = value.option_definition_id
      WHERE axis.product_id = ? AND value.deleted_at IS NULL
    `).all(copy.id)).toEqual([{ value: "M" }]);
    expect(sqlite.prepare("SELECT sku FROM product_variants WHERE product_id = ? AND deleted_at IS NULL").all(copy.id))
      .toEqual([{ sku: "PANJABI-M-COPY" }]);

    // A copy the product form could not save is a 400, not a 500.
    const refused = await duplicateProduct(db, source.id, "ab").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ValidationError);
    expect(refused).toMatchObject({ status: 400, details: { field: "name" } });
  });

  it("keeps an optioned product's price at its lowest live variant price, whatever writes", async () => {
    const product = await create({
      name: "Panjabi", slug: "panjabi", price: 999,
      optionMatrix: {
        options: [{ id: "o", name: "Size", standardMapping: "size", values: [{ id: "m", value: "M" }, { id: "l", value: "L" }] }],
        variants: [variant("s1", "m", "PANJABI-M", 2500), variant("s2", "l", "PANJABI-L", 2400)],
      },
    });
    const price = () => (sqlite.prepare("SELECT price_minor FROM products WHERE id = ?").get(product.id) as { price_minor: number }).price_minor;
    const sku = (code: string) => sqlite.prepare("SELECT id FROM product_variants WHERE sku = ?").get(code) as { id: string };
    expect(price()).toBe(240_000);

    // A product-level price from an old editor or an API client is not stored.
    const saved = await updateProduct(db, product.id, updateProductSchema.parse({
      ...base, id: product.id, name: "Panjabi", slug: "panjabi", price: 2600, expectedAggregateRevision: 1,
    }));
    expect(price()).toBe(240_000);

    // Changing, then retiring, the cheapest variant moves it.
    const values = sqlite.prepare("SELECT v.id, v.value FROM product_option_values v JOIN product_option_definitions d ON d.id = v.option_definition_id WHERE d.product_id = ? ORDER BY v.position").all(product.id) as Array<{ id: string; value: string }>;
    const { stock: _stock, ...large } = variant("s2", values[1]!.id, "PANJABI-L", 2700);
    const changed = await updateVariant(db, product.id, sku("PANJABI-L").id, updateVariantSchema.parse({
      ...large, expectedAggregateRevision: saved.aggregateRevision,
    }));
    expect(price()).toBe(250_000);
    const option = sqlite.prepare("SELECT id FROM product_option_definitions WHERE product_id = ?").get(product.id) as { id: string };
    await saveProductOptionMatrix(db, product.id, {
      expectedAggregateRevision: changed.aggregateRevision,
      options: [{ id: option.id, name: "Size", standardMapping: "size", values: values.filter((value) => value.value === "L") }],
      variants: [{ ...variant(sku("PANJABI-L").id, values[1]!.id, "PANJABI-L", 2700), stock: undefined }],
    });
    expect(price()).toBe(270_000);
  });

  it("lists and looks up the price range buyers see, not the product price", async () => {
    const product = await create({
      name: "Panjabi", slug: "panjabi", isActive: true,
      optionMatrix: {
        options: [{ id: "o", name: "Size", standardMapping: "size", values: [{ id: "m", value: "M" }, { id: "l", value: "L" }] }],
        variants: [variant("s1", "m", "PANJABI-M", 2400), variant("s2", "l", "PANJABI-L", 2600)],
      },
    });
    const mug = await create({ name: "Mug", slug: "mug", price: 500, discountPercentage: 10 });

    const { products } = await listProducts(db, { sort: "name", order: "asc" });
    expect(products.map((row) => [row.name, row.priceRange])).toEqual([
      ["Mug", { from: 450, to: 450, compareAt: 500 }],
      ["Panjabi", { from: 2400, to: 2600, compareAt: null }],
    ]);
    expect((await getProductsByIds(db, [product.id, mug.id])).map((row) => row.priceRange?.to)).toEqual([2600, 450]);
  });

  it("reports tracked stock, SKU discounts and trash stock history in the list", async () => {
    await create({ name: "Cotton tee", slug: "cotton-tee", defaultSku: { trackInventory: true, stock: 7 } });
    await create({ name: "Mug", slug: "mug" });
    const { products } = await listProducts(db, { sort: "name", order: "asc" });
    expect(products.map((product) => [product.name, product.onHand, product.hasVariantDiscount, product.hasStockHistory]))
      .toEqual([["Cotton tee", 7, false, false], ["Mug", null, false, false]]);
  });
});
