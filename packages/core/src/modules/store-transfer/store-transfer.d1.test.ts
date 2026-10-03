// Store import/export on real migrated SQLite with D1's 100-parameter limit:
// Shopify and WooCommerce product files through the product services,
// idempotent re-runs, upsert and price modes, Option3, category trees,
// images, per-location inventory, customers with consent, the export
// round trip, and a 2,000-product import.
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { parseImportText } from "@scalius/shared/store-transfer/detect";
import { mapShopifyProducts } from "@scalius/shared/store-transfer/shopify-products";
import { mapWooCommerceProducts } from "@scalius/shared/store-transfer/woocommerce-products";
import { mapCustomers } from "@scalius/shared/store-transfer/customers";
import { mapInventory } from "@scalius/shared/store-transfer/inventory";
import {
  PRODUCT_IMPORT_BATCH_MAX,
  productImageJobs,
  productImportBatchSchema,
  type ProductImportItem,
  type ProductImportMode,
} from "@scalius/shared/store-transfer/products";
import type { ProductMappingOptions } from "@scalius/shared/store-transfer/product-mapping";
import { customerImportBatchSchema } from "@scalius/shared/store-transfer/customers";
import { inventoryImportBatchSchema } from "@scalius/shared/store-transfer/inventory";
import { withPublicMediaUrl } from "../../integrations/storage";
import { importProducts } from "./product-import";
import { importProductImages, importedMediaIdPrefix, type RemoteMediaImporter } from "./product-images";
import { importCustomers } from "./customer-import";
import { importInventory } from "./inventory-import";
import { buildProductCsvPage } from "./product-export";
import { buildInventoryCsvPage } from "./inventory-export";
import { ImportBudget } from "./budget";

let sqlite: DatabaseSync;
let db: Database;
let queries = 0;
let maxParams = 0;

const BDT = { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 };
const fixture = (name: string) => readFileSync(new URL(`../../../../shared/src/store-transfer/fixtures/${name}`, import.meta.url), "utf8");
const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number | null>) => sqlite.prepare(query).get(...params) as T;
const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number | null>) => sqlite.prepare(query).all(...params) as T[];
const count = (table: string) => one<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).n;

let roundTrips = 0;

function freshDatabase() {
  const created = createSqliteD1Database({
    onQuery: (_query, values) => {
      queries += 1;
      roundTrips += 1;
      maxParams = Math.max(maxParams, values.length);
    },
    // A batch is one round trip to D1, however many statements it holds.
    beforeBatch: (_sqlite, statements) => {
      roundTrips -= statements.length - 1;
    },
  });
  sqlite = created.sqlite;
  db = created.db;
}

beforeEach(() => {
  queries = 0;
  roundTrips = 0;
  maxParams = 0;
  freshDatabase();
});

function shopifyItems(options: Partial<ProductMappingOptions> = {}, text = fixture("shopify-products.csv")) {
  return mapShopifyProducts(parseImportText(text).table, { currency: BDT, ...options }).items;
}

/** Sends items the way the dashboard does: bounded batches, the remainder of a short batch again. */
async function runProducts(items: readonly ProductImportItem[], mode: ProductImportMode, options: { dryRun?: boolean; size?: number } = {}) {
  const results = [];
  let pending = [...items];
  while (pending.length > 0) {
    const batch = productImportBatchSchema.parse({ mode, dryRun: options.dryRun ?? false, items: pending.slice(0, options.size ?? 10) });
    const response = await importProducts(db, batch, { actorId: "user_import" });
    results.push(...response.results);
    pending = pending.slice(response.processed);
  }
  return results;
}

/** A fake remote download: stores a ready media row under the requested id. */
function fakeImporter(failing: readonly string[] = []): RemoteMediaImporter & { calls: string[] } {
  const calls: string[] = [];
  const importer = (async ({ sourceUrl, mediaId }) => {
    calls.push(sourceUrl);
    if (failing.includes(sourceUrl)) throw new Error("Remote media returned HTTP 404.");
    sqlite.prepare(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES (?, ?, 'image', ?, 1000, 'image/jpeg', 'ready')`)
      .run(mediaId, "imported.jpg", `media/${mediaId}.jpg`);
    return { id: mediaId, kind: "image" as const };
  }) as RemoteMediaImporter & { calls: string[] };
  importer.calls = calls;
  return importer;
}

async function attachImages(items: readonly ProductImportItem[], results: Array<{ ref: string; productId: string | null }>, importer: RemoteMediaImporter) {
  const byRef = new Map(results.map((result) => [result.ref, result.productId]));
  const jobs = items.flatMap((item) => {
    const productId = byRef.get(item.ref);
    const images = productImageJobs(item);
    return productId && images.length > 0 ? [{ productId, images }] : [];
  });
  return importProductImages(db, { items: jobs }, { importMedia: importer });
}

function levelsFold(): void {
  for (const variant of all<{ id: string; stock: number }>("SELECT id, stock FROM product_variants")) {
    const sum = one<{ total: number }>("SELECT COALESCE(SUM(on_hand), 0) AS total FROM inventory_levels WHERE variant_id = ?", variant.id).total;
    expect(sum, `sum(levels) of ${variant.id}`).toBe(variant.stock);
  }
}

describe("Shopify product import", () => {
  it("creates products, options, SKUs, prices, stock, categories and brands", async () => {
    const items = shopifyItems();
    const results = await runProducts(items, "create");
    expect(results.map((result) => [result.ref, result.status])).toEqual(items.map((item) => [item.ref, "created"]));

    const tee = one<{ id: string; name: string; is_active: number; brand_id: string; category_id: string; price_minor: number }>(
      "SELECT id, name, is_active, brand_id, category_id, price_minor FROM products WHERE slug = 'classic-cotton-tee'",
    );
    // An optioned product's price is its lowest SKU base price.
    expect(tee).toMatchObject({ name: "Classic Cotton Tee", is_active: 1, price_minor: 65000 });
    const navyM = one<{ price_minor: number; discount_type: string; discount_amount_minor: number; stock: number; weight: number; fulfillment_kind: string }>(
      "SELECT price_minor, discount_type, discount_amount_minor, stock, weight, fulfillment_kind FROM product_variants WHERE sku = 'DT-TEE-NAV-M'",
    );
    expect(navyM).toEqual({ price_minor: 80000, discount_type: "flat", discount_amount_minor: 15000, stock: 12, weight: 180, fulfillment_kind: "physical" });
    // Cost per item lands on each SKU in minor units; a row without one stays unset.
    expect(all("SELECT DISTINCT cost_minor FROM product_variants WHERE sku LIKE 'DT-TEE-%'")).toEqual([{ cost_minor: 31000 }]);
    expect(one("SELECT cost_minor FROM product_variants WHERE sku = 'MC-MUG-350'")).toEqual({ cost_minor: null });
    expect(all("SELECT name FROM product_option_definitions WHERE product_id = ? ORDER BY position", tee.id)).toEqual([{ name: "Color" }, { name: "Size" }]);

    // Category tree: Men > T-Shirts, published; brand published.
    const tShirts = one<{ name: string; parent_id: string; status: string }>("SELECT name, parent_id, status FROM categories WHERE id = ?", tee.category_id);
    expect(tShirts).toMatchObject({ name: "T-Shirts", status: "published" });
    expect(one<{ name: string; parent_id: string | null }>("SELECT name, parent_id FROM categories WHERE id = ?", tShirts.parent_id)).toEqual({ name: "Men", parent_id: null });
    expect(one<{ name: string; status: string }>("SELECT name, status FROM brands WHERE id = ?", tee.brand_id)).toEqual({ name: "Deshi Threads", status: "published" });
    expect(count("brands")).toBe(4);

    // Simple product: one default SKU with its barcode and stock at the default location.
    const mug = one<{ id: string; price_minor: number; discount_amount_minor: number }>("SELECT id, price_minor, discount_amount_minor FROM products WHERE slug = 'ceramic-mug'");
    expect(mug).toMatchObject({ price_minor: 50000, discount_amount_minor: 5000 });
    expect(one("SELECT sku, is_default, barcode, barcode_type, stock FROM product_variants WHERE product_id = ?", mug.id))
      .toEqual({ sku: "MC-MUG-350", is_default: 1, barcode: "4006381333931", barcode_type: "ean13", stock: 25 });
    expect(one("SELECT location_id, on_hand FROM inventory_levels WHERE variant_id = (SELECT id FROM product_variants WHERE sku = 'MC-MUG-350')"))
      .toEqual({ location_id: "loc_default", on_hand: 25 });

    // Bangla, gift card, archived → draft, three options kept.
    expect(one<{ name: string }>("SELECT name FROM products WHERE slug = 'nakshi-kantha-throw'").name).toBe("নকশী কাঁথা থ্রো");
    expect(all("SELECT fulfillment_kind, track_inventory FROM product_variants WHERE sku LIKE 'GC-%'")).toEqual(
      Array(3).fill({ fulfillment_kind: "digital", track_inventory: 0 }),
    );
    expect(one<{ is_active: number }>("SELECT is_active FROM products WHERE slug = 'old-straw-hat'").is_active).toBe(0);
    expect(count("product_option_definitions WHERE product_id = (SELECT id FROM products WHERE slug = 'jamdani-saree')")).toBe(3);
    levelsFold();
  });

  it("runs the same file again as a no-op, in create and in upsert mode", async () => {
    const items = shopifyItems();
    await runProducts(items, "create");
    const before = {
      products: count("products"),
      variants: count("product_variants"),
      movements: count("inventory_movements"),
      revisions: all("SELECT id, aggregate_revision FROM products ORDER BY id"),
      categories: count("categories"),
      brands: count("brands"),
    };
    const again = await runProducts(items, "create");
    expect(new Set(again.map((result) => result.status))).toEqual(new Set(["skipped"]));
    const upsert = await runProducts(items, "upsert");
    expect(upsert.map((result) => [result.ref, result.status, result.issues])).toEqual(items.map((item) => [item.ref, "unchanged", []]));
    expect({
      products: count("products"),
      variants: count("product_variants"),
      movements: count("inventory_movements"),
      revisions: all("SELECT id, aggregate_revision FROM products ORDER BY id"),
      categories: count("categories"),
      brands: count("brands"),
    }).toEqual(before);
  });

  it("upsert updates what the file changes and keeps what it leaves out", async () => {
    const items = shopifyItems();
    await runProducts(items, "create");
    const tee = items.find((item) => item.ref === "classic-cotton-tee")!;
    const teeId = one<{ id: string }>("SELECT id FROM products WHERE slug = 'classic-cotton-tee'").id;
    const revision = one<{ aggregate_revision: number }>("SELECT aggregate_revision FROM products WHERE id = ?", teeId).aggregate_revision;
    // The file drops Maroon/XL, raises Navy/L and adds a new size.
    const changed: ProductImportItem = {
      ...tee,
      title: "Classic Cotton Tee (2026)",
      options: [{ name: "Color", values: ["Navy", "Maroon"] }, { name: "Size", values: ["M", "L", "XL", "XXL"] }],
      variants: [
        ...tee.variants.filter((variant) => variant.sku !== "DT-TEE-MAR-XL").map((variant) => variant.sku === "DT-TEE-NAV-L" ? { ...variant, price: 700 } : variant),
        { ...tee.variants[0]!, optionValues: ["Navy", "XXL"], sku: "DT-TEE-NAV-XXL", stock: 3, compareAtPrice: null },
      ],
    };
    const [result] = await runProducts([changed], "upsert");
    expect(result).toMatchObject({ status: "updated", productId: teeId });
    expect(result!.aggregateRevision).toBeGreaterThan(revision);
    expect(one<{ name: string }>("SELECT name FROM products WHERE id = ?", teeId).name).toBe("Classic Cotton Tee (2026)");
    expect(one("SELECT price_minor, discount_amount_minor FROM product_variants WHERE sku = 'DT-TEE-NAV-L'")).toEqual({ price_minor: 70000, discount_amount_minor: 0 });
    // Not in the file: kept, live and unchanged.
    expect(one("SELECT deleted_at, stock FROM product_variants WHERE sku = 'DT-TEE-MAR-XL'")).toEqual({ deleted_at: null, stock: 0 });
    expect(one("SELECT stock FROM product_variants WHERE sku = 'DT-TEE-NAV-XXL'")).toEqual({ stock: 3 });
    expect(count(`product_variants WHERE product_id = '${teeId}' AND deleted_at IS NULL`)).toBe(7);
    levelsFold();

    // The same file again changes nothing.
    const [rerun] = await runProducts([changed], "upsert");
    expect(rerun!.status).toBe("unchanged");
  });

  it("refuses a write when the product changed after the dry run", async () => {
    const items = shopifyItems();
    await runProducts(items, "create");
    const mug = items.find((item) => item.ref === "ceramic-mug")!;
    const [preview] = await runProducts([mug], "upsert", { dryRun: true });
    expect(preview).toMatchObject({ status: "would_update" });
    sqlite.prepare("UPDATE products SET aggregate_revision = aggregate_revision + 1 WHERE id = ?").run(preview!.productId);
    const [write] = await runProducts([{ ...mug, title: "Ceramic Mug XL", expected: { productId: preview!.productId!, aggregateRevision: preview!.aggregateRevision! } }], "upsert");
    expect(write).toMatchObject({ status: "failed", issues: [expect.objectContaining({ code: "changed_since_preview" })] });
  });

  it("price mode changes only prices of SKUs it finds", async () => {
    await runProducts(shopifyItems(), "create");
    const text = "Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Compare At Price\n"
      + "ceramic-mug,Renamed Mug,Title,Default Title,MC-MUG-350,480,\n"
      + "classic-cotton-tee,Tee,Color,Navy,DT-TEE-NAV-M,600,900\n"
      + "unknown-thing,Unknown,Title,Default Title,NOPE-1,10,\n";
    const items = mapShopifyProducts(parseImportText(text).table, { currency: BDT }).items;
    const results = await runProducts(items, "price");
    expect(results.map((result) => [result.ref, result.status])).toEqual([
      ["ceramic-mug", "updated"],
      ["classic-cotton-tee", "updated"],
      ["unknown-thing", "skipped"],
    ]);
    expect(one("SELECT name, price_minor, discount_amount_minor FROM products WHERE slug = 'ceramic-mug'")).toEqual({ name: "Ceramic Coffee Mug", price_minor: 48000, discount_amount_minor: 0 });
    expect(one("SELECT price_minor, discount_amount_minor FROM product_variants WHERE sku = 'DT-TEE-NAV-M'")).toEqual({ price_minor: 90000, discount_amount_minor: 30000 });
    expect(one("SELECT price_minor FROM product_variants WHERE sku = 'DT-TEE-NAV-L'")).toEqual({ price_minor: 65000 });
  });

  it("Option3: skip and fold create two-option products", async () => {
    const folded = shopifyItems({ extraOptions: "fold" }).filter((item) => item.ref.startsWith("jamdani"));
    const results = await runProducts(folded, "create");
    expect(results.map((result) => result.status)).toEqual(["created", "created"]);
    expect(all("SELECT slug, name FROM products ORDER BY slug")).toEqual([
      { slug: "jamdani-saree-cotton", name: "Jamdani Saree - Cotton" },
      { slug: "jamdani-saree-silk", name: "Jamdani Saree - Silk" },
    ]);
    expect(count("product_option_definitions")).toBe(4);
  });

  it("matches by SKU when the handle is new, and refuses a SKU that belongs to another product", async () => {
    await runProducts(shopifyItems(), "create");
    const renamed = "Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price\nnew-mug,New Mug,Title,Default Title,MC-MUG-350,500\n";
    const [bySku] = await runProducts(mapShopifyProducts(parseImportText(renamed).table, { currency: BDT }).items, "upsert");
    // The SKU identifies the mug; its web address stays as it is.
    expect(bySku).toMatchObject({ status: "updated", slug: "ceramic-mug" });
    expect(one("SELECT name, slug FROM products WHERE slug = 'ceramic-mug'")).toEqual({ name: "New Mug", slug: "ceramic-mug" });
    expect(count("products WHERE slug = 'new-mug'")).toBe(0);

    const stolen = "Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price\nold-straw-hat,Straw Hat,Title,Default Title,MC-MUG-350,300\n";
    const [conflict] = await runProducts(mapShopifyProducts(parseImportText(stolen).table, { currency: BDT }).items, "upsert");
    expect(conflict).toMatchObject({ status: "failed", issues: [expect.objectContaining({ code: "sku_taken", variantIndex: 0 })] });
    expect(one("SELECT name FROM products WHERE slug = 'old-straw-hat'")).toEqual({ name: "Straw Hat (2023)" });
  });
});

describe("WooCommerce product import", () => {
  it("creates the variable product with its axes, specs and category tree", async () => {
    const mapped = mapWooCommerceProducts(parseImportText(fixture("woocommerce-products.csv")).table, { currency: BDT });
    const results = await runProducts(mapped.items, "create");
    expect(results.map((result) => result.status)).toEqual(["created", "created", "created", "created"]);
    const panjabi = one<{ id: string; slug: string; category_id: string }>("SELECT id, slug, category_id FROM products WHERE name = 'Eid Cotton Panjabi'");
    expect(panjabi.slug).toBe("eid-cotton-panjabi");
    expect(all("SELECT name FROM product_option_definitions WHERE product_id = ? ORDER BY position", panjabi.id)).toEqual([{ name: "Color" }, { name: "Size" }]);
    expect(all(`SELECT a.name, v.value FROM product_attribute_values v JOIN product_attributes a ON a.id = v.attribute_id WHERE v.product_id = ?`, panjabi.id))
      .toEqual([{ name: "Material", value: "Cotton" }]);
    const path: string[] = [];
    let categoryId: string | null = panjabi.category_id;
    while (categoryId) {
      const row: { name: string; parent_id: string | null } = one("SELECT name, parent_id FROM categories WHERE id = ?", categoryId);
      path.unshift(row.name);
      categoryId = row.parent_id;
    }
    expect(path).toEqual(["Clothing", "Men", "Panjabi"]);
    expect(one("SELECT fulfillment_kind, track_inventory FROM product_variants WHERE sku = 'CONSULT-30'")).toEqual({ fulfillment_kind: "service", track_inventory: 0 });

    // No handle in the file: a re-run matches by SKU and name, never duplicating.
    const again = await runProducts(mapped.items, "create");
    expect(again.map((result) => result.status)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    expect(count("products")).toBe(4);
  });
});

describe("product images", () => {
  it("downloads each URL once, attaches in order, maps variant images and reports failures", async () => {
    const items = shopifyItems();
    const results = await runProducts(items, "create");
    const broken = "https://cdn.shopify.com/s/files/1/0000/0001/products/tee-detail.jpg";
    const importer = fakeImporter([broken]);
    const response = await attachImages(items, results, importer);
    const tee = response.results.find((result) => result.productId === results.find((entry) => entry.ref === "classic-cotton-tee")!.productId)!;
    expect(tee.images.map((image) => image.status)).toEqual(["attached", "attached", "failed"]);
    expect(tee.images[2]!.message).toBe("Remote media returned HTTP 404.");
    const teeId = tee.productId;
    const media = all<{ media_id: string; is_primary: number; sort_order: number }>("SELECT media_id, is_primary, sort_order FROM product_media WHERE product_id = ? ORDER BY sort_order", teeId);
    expect(media.map((row) => row.is_primary)).toEqual([1, 0]);
    expect(media[0]!.media_id.startsWith(await importedMediaIdPrefix("https://cdn.shopify.com/s/files/1/0000/0001/products/tee-navy.jpg"))).toBe(true);
    // Variant images: Navy SKUs show the navy image, Maroon SKUs the maroon one.
    const variantImages = all<{ sku: string; media_id: string }>(`SELECT v.sku, pm.media_id FROM product_variants v JOIN product_media pm ON pm.id = v.image_id WHERE v.product_id = ? ORDER BY v.sku`, teeId);
    expect(variantImages).toHaveLength(6);
    expect(new Set(variantImages.filter((row) => row.sku.includes("NAV")).map((row) => row.media_id))).toEqual(new Set([media[0]!.media_id]));

    // Again: nothing re-downloaded, the failed one retried.
    const retry = await attachImages(items, results, fakeImporter());
    const teeRetry = retry.results.find((result) => result.productId === teeId)!;
    expect(teeRetry.images.map((image) => image.status)).toEqual(["already_attached", "already_attached", "attached"]);
    expect(count(`product_media WHERE product_id = '${teeId}'`)).toBe(3);
  });

  it("stops when its time budget is spent and leaves the rest pending", async () => {
    const items = shopifyItems();
    const results = await runProducts(items, "create");
    const tee = items.find((item) => item.ref === "classic-cotton-tee")!;
    const productId = results.find((result) => result.ref === tee.ref)!.productId!;
    const response = await importProductImages(db, { items: [{ productId, images: productImageJobs(tee) }] }, { importMedia: fakeImporter(), budget: new ImportBudget(0) });
    expect(response.stoppedEarly).toBe(true);
    expect(response.results[0]!.images.every((image) => image.status === "pending")).toBe(true);
  });
});

describe("inventory import", () => {
  it("sets on-hand per location through ledger v2; levels keep summing to stock", async () => {
    await runProducts(shopifyItems(), "create");
    sqlite.prepare("INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position) VALUES ('loc_shop', 'Dhanmondi shop', 'DHK-1', 'store', 0, 'active', 1)").run();
    const text = "SKU,Location code,On hand\nMC-MUG-350,,20\nMC-MUG-350,DHK-1,7\nDT-TEE-NAV-M,DHK-1,4\nDT-TEE-NAV-M,Dhanmondi shop,5\nNO-SUCH,,1\nMC-MUG-350,NOWHERE,1\n";
    const mapped = mapInventory(parseImportText(text).table);
    expect(mapped.issues).toEqual([]);
    const batch = inventoryImportBatchSchema.parse({ runId: "run_test_0001", items: mapped.items });
    const preview = await importInventory(db, { ...batch, dryRun: true });
    expect(preview.results.map((result) => [result.ref, result.status, result.previousOnHand])).toEqual([
      ["MC-MUG-350", "would_update", 25],
      ["MC-MUG-350 @ DHK-1", "would_update", 0],
      ["DT-TEE-NAV-M @ DHK-1", "would_update", 0],
      ["DT-TEE-NAV-M @ Dhanmondi shop", "failed", null],
      ["NO-SUCH", "failed", null],
      ["MC-MUG-350 @ NOWHERE", "failed", null],
    ]);
    const written = await importInventory(db, { ...batch, items: batch.items.map((item, index) => ({ ...item, expectedOnHand: preview.results[index]!.previousOnHand })) });
    expect(written.results.map((result) => result.status)).toEqual(["updated", "updated", "updated", "failed", "failed", "failed"]);
    // The same location by code and by name is one count; the second is refused.
    expect(written.results[3]!.issues[0]!.code).toBe("duplicate_count");
    expect(one("SELECT stock FROM product_variants WHERE sku = 'MC-MUG-350'")).toEqual({ stock: 27 });
    expect(all("SELECT location_id, on_hand FROM inventory_levels WHERE variant_id = (SELECT id FROM product_variants WHERE sku = 'MC-MUG-350') ORDER BY location_id"))
      .toEqual([{ location_id: "loc_default", on_hand: 20 }, { location_id: "loc_shop", on_hand: 7 }]);
    expect(all("SELECT notes FROM inventory_movements WHERE notes LIKE 'Stocktake (import)%' ORDER BY notes").length).toBe(3);
    levelsFold();

    // The same counts again: nothing to write.
    const rerun = await importInventory(db, { ...batch, runId: "run_test_0002", items: batch.items.slice(0, 3) });
    expect(rerun.results.map((result) => result.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });

  it("exports per-location counts that import back unchanged", async () => {
    await runProducts(shopifyItems(), "create");
    const page = await buildInventoryCsvPage(db, {});
    const mapped = mapInventory(parseImportText(page.body).table);
    expect(mapped.items.length).toBe(page.rowCount);
    const result = await importInventory(db, inventoryImportBatchSchema.parse({ runId: "run_roundtrip", items: mapped.items.slice(0, 100) }));
    expect(new Set(result.results.map((entry) => entry.status))).toEqual(new Set(["unchanged"]));
  });
});

describe("customer import", () => {
  it("creates customers with tags and imported consent, then skips them on a re-run", async () => {
    const mapped = mapCustomers(parseImportText(fixture("shopify-customers.csv")).table, "shopify_customers");
    const batch = customerImportBatchSchema.parse({ mode: "create", items: mapped.items });
    const response = await importCustomers(db, batch, { actorId: "user_import", env: {} });
    expect(response.results.map((result) => [result.status, result.subscribed])).toEqual([
      ["created", ["email", "sms"]],
      ["created", []],
      ["created", []],
    ]);
    const rahim = one<{ id: string; name: string; origin: string }>("SELECT id, name, origin FROM customers WHERE phone = '+8801712345678'");
    expect(rahim).toMatchObject({ name: "রহিম উদ্দিন", origin: "merchant" });
    expect(all("SELECT tag FROM customer_tag_links WHERE customer_id = ? ORDER BY tag", rahim.id)).toEqual([{ tag: "dhaka" }, { tag: "vip" }]);
    expect(all("SELECT channel, state, contact, source, actor, actor_id, note FROM customer_marketing_consents WHERE customer_id = ? ORDER BY channel", rahim.id)).toEqual([
      { channel: "email", state: "subscribed", contact: "rahim@example.com", source: "import", actor: "staff", actor_id: "user_import", note: "Shopify customer export: Accepts Email Marketing = yes; Accepts SMS Marketing = yes" },
      { channel: "sms", state: "subscribed", contact: "+8801712345678", source: "import", actor: "staff", actor_id: "user_import", note: "Shopify customer export: Accepts Email Marketing = yes; Accepts SMS Marketing = yes" },
    ]);
    // Audit rows from the consent triggers, never fabricated consent for "no".
    expect(count(`customer_marketing_consent_events WHERE customer_id = '${rahim.id}'`)).toBe(2);
    expect(count("customer_marketing_consents")).toBe(2);

    const again = await importCustomers(db, batch, { actorId: "user_import", env: {} });
    expect(again.results.map((result) => result.status)).toEqual(["skipped", "skipped", "skipped"]);
    const upsert = await importCustomers(db, { ...batch, mode: "upsert" }, { actorId: "user_import", env: {} });
    expect(upsert.results.map((result) => result.status)).toEqual(["updated", "unchanged", "updated"]);
    expect(count("customers")).toBe(3);
    expect(count("customer_marketing_consent_events")).toBe(2);
  });

  it("fills only what an existing customer lacks and refuses an email owned by another phone", async () => {
    sqlite.prepare("INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_a', '+8801812345678', '+8801812345678', NULL, 'order')").run();
    sqlite.prepare("INSERT INTO customers (id, name, phone, email, origin) VALUES ('cust_b', 'Other', '+8801555000111', 'shared@example.com', 'merchant')").run();
    const items = [
      { ref: "karim", phone: "+8801812345678", name: "Karim Ahmed", email: "karim@example.com", address: "Agrabad", tags: ["chattogram"], marketing: { email: true, sms: false, whatsapp: false }, consentEvidence: "Accepts Email Marketing = yes" },
      { ref: "stranger", phone: "+8801999000111", name: "Stranger", email: "shared@example.com", address: null, tags: [], marketing: { email: false, sms: false, whatsapp: false }, consentEvidence: null },
    ];
    const response = await importCustomers(db, customerImportBatchSchema.parse({ mode: "upsert", items }), { actorId: "user_import", env: {} });
    expect(response.results.map((result) => result.status)).toEqual(["updated", "skipped"]);
    expect(response.results[1]!.issues[0]!.code).toBe("email_belongs_to_other_phone");
    expect(one("SELECT name, email, address FROM customers WHERE id = 'cust_a'")).toEqual({ name: "Karim Ahmed", email: "karim@example.com", address: "Agrabad" });
    expect(one("SELECT state, source FROM customer_marketing_consents WHERE customer_id = 'cust_a'")).toEqual({ state: "subscribed", source: "import" });
    expect(count("customers")).toBe(2);
  });
});

describe("cost per item", () => {
  const costOf = (sku: string) => one<{ cost_minor: number | null }>("SELECT cost_minor FROM product_variants WHERE sku = ?", sku).cost_minor;
  const exportedCosts = async () => {
    const page = await withPublicMediaUrl("https://media.example.com", () => buildProductCsvPage(db, { limit: 50 }));
    const { table } = parseImportText(page.body);
    const sku = table.headers.indexOf("Variant SKU");
    const cost = table.headers.indexOf("Cost per item");
    return new Map(table.rows.filter((row) => row.cells[sku]).map((row) => [row.cells[sku]!, row.cells[cost]!]));
  };

  it("exports each SKU's cost in major units, and an upsert sets the file's cost", async () => {
    await runProducts(shopifyItems(), "create");
    // A cost with paisa: costs keep the currency's minor units.
    sqlite.prepare("UPDATE product_variants SET cost_minor = 12345 WHERE sku = 'MC-MUG-350'").run();

    const costs = await exportedCosts();
    expect(costs.get("MC-MUG-350")).toBe("123.45");
    expect(costs.get("DT-TEE-NAV-M")).toBe("310");
    expect(costs.get("GC-500")).toBe("");

    const text = "Handle,Title,Option1 Name,Option1 Value,Variant SKU,Variant Price,Variant Compare At Price,Variant Inventory Tracker,Cost per item\n"
      + "ceramic-mug,Ceramic Coffee Mug,Title,Default Title,MC-MUG-350,450,500,shopify,130.5\n";
    const mug = mapShopifyProducts(parseImportText(text).table, { currency: BDT }).items;
    const [updated] = await runProducts(mug, "upsert");
    expect(updated).toMatchObject({ status: "updated", issues: [] });
    expect(costOf("MC-MUG-350")).toBe(13050);
    const [again] = await runProducts(mug, "upsert");
    expect(again!.status).toBe("unchanged");

    // Price mode changes prices only.
    const cheaper = mapShopifyProducts(parseImportText(text.replace("130.5", "99")).table, { currency: BDT }).items;
    await runProducts(cheaper, "price");
    expect(costOf("MC-MUG-350")).toBe(13050);
  });
});

describe("export round trip", () => {
  it("exports a Shopify CSV that imports into an empty store and exports identically", async () => {
    const items = shopifyItems();
    const results = await runProducts(items, "create");
    await attachImages(items, results, fakeImporter());
    const exportAll = async () => {
      let csv = "";
      let cursor: string | null = null;
      let first = true;
      do {
        const page = await withPublicMediaUrl("https://media.example.com", () => buildProductCsvPage(db, { after: cursor, limit: 3, includeHeader: first }));
        csv += page.body;
        cursor = page.nextCursor;
        first = false;
      } while (cursor);
      return csv;
    };
    const exported = await exportAll();
    const reimported = mapShopifyProducts(parseImportText(exported).table, { currency: BDT });
    expect(reimported.issues.filter((issue) => issue.severity === "error")).toEqual([]);

    freshDatabase();
    const secondResults = await runProducts(reimported.items, "create");
    expect(secondResults.every((result) => result.status === "created")).toBe(true);
    await attachImages(reimported.items, secondResults, fakeImporter());
    const second = await exportAll();
    // Media ids differ between stores; everything else is the same.
    const normalize = (csv: string) => csv.replace(/https:\/\/media\.example\.com\/media\/[A-Za-z0-9_-]+\.jpg/g, "IMAGE");
    const sortRows = (csv: string) => {
      const [header, ...rows] = normalize(csv).trim().split("\r\n");
      return [header, ...rows.sort()];
    };
    expect(sortRows(second)).toEqual(sortRows(exported));
    expect(exported.split("\r\n").length).toBeGreaterThan(20);
  });
});

describe("a 2,000-product import", () => {
  it("stays within D1's parameter limit and reports its throughput", async () => {
    const items: ProductImportItem[] = Array.from({ length: 2000 }, (_, index) => {
      const optioned = index % 2 === 0;
      return {
        ref: `bulk-${index}`,
        lines: [index + 2],
        handle: `bulk-product-${index}`,
        handleIsIdentity: true,
        title: `Bulk product ${index}`,
        descriptionHtml: "<p>Imported in bulk for a load test.</p>",
        brand: `Brand ${index % 20}`,
        categoryPath: [`Department ${index % 5}`, `Aisle ${index % 25}`],
        status: "active",
        seoTitle: null,
        seoDescription: null,
        isGiftCard: false,
        condition: null,
        options: optioned ? [{ name: "Size", values: ["S", "M", "L"] }] : [],
        variants: (optioned ? ["S", "M", "L"] : [null]).map((size) => ({
          optionValues: size ? [size] : [],
          sku: `BULK-${index}${size ? `-${size}` : ""}`,
          price: 500 + (index % 7) * 10,
          compareAtPrice: index % 3 === 0 ? 900 : null,
          cost: null,
          stock: 5,
          trackInventory: true,
          weightGrams: 250,
          barcode: null,
          requiresShipping: true,
          imageUrl: null,
        })),
        images: [],
        attributes: [],
      };
    });
    const started = performance.now();
    const results = await runProducts(items, "create", { size: PRODUCT_IMPORT_BATCH_MAX });
    const seconds = (performance.now() - started) / 1000;
    expect(results.filter((result) => result.status !== "created")).toEqual([]);
    expect(count("products")).toBe(2000);
    expect(count("product_variants")).toBe(4000);
    expect(maxParams).toBeLessThanOrEqual(100);
    levelsFold();
    process.stdout.write(`\n[store-transfer] 2,000 products (4,000 SKUs) in ${seconds.toFixed(1)} s: ${(2000 / seconds).toFixed(0)} products/s, ${(queries / 2000).toFixed(1)} statements and ${(roundTrips / 2000).toFixed(1)} D1 round trips per product, largest statement ${maxParams} bound parameters\n`);
  }, 600_000);
});
