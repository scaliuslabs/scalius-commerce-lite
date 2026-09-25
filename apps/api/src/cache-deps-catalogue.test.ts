// Catalogue dependency declarations of the dependency-validated cache
// (CACHE-DESIGN.md §6.5, slice S3a): every public catalogue read, rendered
// through the real API routes on the migrated schema, runs in a strict
// dependency scope. A table the render touches that no declared key covers
// fails the test, so a missing declaration cannot ship.
import "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { catalogProjectionRefreshStatements, rebuildCatalogProjections } from "@scalius/core/modules/products";
import { safeBatch } from "@scalius/database/client";
import { refreshProductRecommendations, refreshProductSalesStats } from "@scalius/core/modules/catalog";
import { withDependencyScope, type CacheDependencies } from "@scalius/core/cache-deps";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";

const SEED = `
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
  INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_eid', 'Eid', 'eid', 'published', 'cat_panjabi');
  INSERT INTO brands (id, name, slug, status) VALUES ('brd_walton01', 'Walton', 'walton', 'published');
  INSERT INTO product_attributes (id, name, slug, filterable, value_type, facet_display) VALUES ('attr_mat', 'Material', 'material', 1, 'text', 'checkbox');
  INSERT INTO category_attribute_sets (category_id, attribute_id, sort_order) VALUES ('cat_panjabi', 'attr_mat', 0);
  INSERT INTO products (id, name, price_minor, slug, category_id, brand_id, is_active, discount_type, discount_bps) VALUES
    ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 'cat_eid', 'brd_walton01', 1, 'percentage', 1000),
    ('p_cotton', 'Cotton Panjabi', 180000, 'cotton-panjabi', 'cat_panjabi', NULL, 1, 'percentage', 0);
  INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ('opt_size', 'p_linen', 'Size', 'size', 0);
  INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
    ('ov_m', 'opt_size', 'M', 'm', 0), ('ov_l', 'opt_size', 'L', 'l', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, option_combination_key) VALUES
    ('v_linen_m', 'p_linen', 'LIN-M', 250000, 5, 0, 0, 1, 'M'),
    ('v_linen_l', 'p_linen', 'LIN-L', 250000, 5, 0, 0, 1, 'L'),
    ('v_cotton', 'p_cotton', 'COT-1', 180000, 5, 0, 1, 1, NULL);
  INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
    ('v_linen_m', 'opt_size', 'ov_m'), ('v_linen_l', 'opt_size', 'ov_l');
  INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_1', 'p_linen', 'attr_mat', 'Linen');
  INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
    ('media_linen', 'linen.jpg', 'image', 'media/linen.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600),
    ('media_linen_2', 'linen-2.jpg', 'image', 'media/linen-2.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600),
    ('media_linen_3', 'linen-3.jpg', 'image', 'media/linen-3.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600),
    ('media_cotton', 'cotton.jpg', 'image', 'media/cotton.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600),
    ('media_logo', 'walton.png', 'image', 'media/walton.png', 1, 'image/png', 'ready', 400, 400, 400);
  UPDATE brands SET logo_media_id = 'media_logo' WHERE id = 'brd_walton01';
  INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES
    ('pmed_linen', 'p_linen', 'media_linen', 1, 0),
    ('pmed_linen_2', 'p_linen', 'media_linen_2', 0, 1),
    ('pmed_linen_3', 'p_linen', 'media_linen_3', 0, 2),
    ('pmed_cotton', 'p_cotton', 'media_cotton', 1, 0);
  INSERT INTO product_rich_content (id, product_id, title, content, sort_order) VALUES ('prc_care', 'p_linen', 'Care', '<p>Hand wash.</p>', 0);
  INSERT INTO product_bundles (id, product_id, quantity, discount_type, discount_bps) VALUES ('pbd_linen_pair', 'p_linen', 2, 'percentage', 1000);
  INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
    ('col_grid', 'Best sellers', 'grid', '{"source":"manual","productIds":["p_linen","p_cotton"],"showOnHomepage":true,"maxProducts":8}', 0),
    ('col_rail', 'Panjabi', 'carousel', '{"source":"dynamic","categoryIds":["cat_panjabi"],"showOnHomepage":true,"maxProducts":12}', 1);
  INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at) VALUES
    ('o_1', 'A', '01700000001', 'Road', 'city', 'zone', 'delivered', unixepoch(), unixepoch());
  INSERT INTO order_items (id, order_id, product_id, quantity) VALUES ('oi_1', 'o_1', 'p_linen', 1);
`;

/** Every public catalogue read (catalog, products, categories, brands, collections, attributes). */
const CATALOGUE_URLS = [
  "/api/v1/products?page=1&limit=20",
  "/api/v1/products?page=1&limit=20&sort=price-asc&material=linen",
  "/api/v1/products?page=1&limit=20&sort=name-asc&hasDiscount=true",
  "/api/v1/products?page=1&limit=20&sort=discount&minPrice=100&maxPrice=5000&freeDelivery=false",
  "/api/v1/products?page=1&limit=20&category=panjabi&brand=walton&option.size=m",
  "/api/v1/products?search=linen",
  "/api/v1/products?search=kurta",
  "/api/v1/products?ids=p_linen,p_cotton",
  "/api/v1/products/search?search=linen",
  "/api/v1/products/feed?limit=10",
  "/api/v1/products/feed?limit=10&search=linen&minPrice=1",
  "/api/v1/products/sitemap",
  "/api/v1/products/recommendations?productIds=p_linen",
  "/api/v1/products/recommendations?productIds=p_linen,p_cotton",
  "/api/v1/products/recommendations",
  "/api/v1/products/compare?ids=p_linen,p_cotton,p_missing",
  "/api/v1/products/linen-panjabi",
  "/api/v1/products/cotton-panjabi",
  "/api/v1/products/linen-panjabi/sections/summary",
  "/api/v1/products/linen-panjabi/sections/media",
  "/api/v1/products/linen-panjabi/sections/variants",
  "/api/v1/products/linen-panjabi/sections/attributes",
  "/api/v1/products/linen-panjabi/sections/options",
  "/api/v1/products/linen-panjabi/sections/related_products",
  "/api/v1/categories",
  "/api/v1/categories/summaries",
  "/api/v1/categories/sitemap",
  "/api/v1/categories/tree",
  "/api/v1/categories/panjabi",
  "/api/v1/categories/panjabi/children",
  "/api/v1/categories/eid/breadcrumb",
  "/api/v1/categories/panjabi/products",
  "/api/v1/categories/panjabi/products?sort=price-desc&material=linen",
  "/api/v1/categories/panjabi/products?includeSubcategories=true&sort=name-asc",
  "/api/v1/categories/panjabi/product-summaries",
  "/api/v1/categories/panjabi/sections/summary",
  "/api/v1/brands",
  "/api/v1/brands/sitemap",
  "/api/v1/brands/walton",
  "/api/v1/brands/walton/products",
  "/api/v1/brands/walton/products?sort=price-asc",
  "/api/v1/collections",
  "/api/v1/collections/sitemap",
  "/api/v1/collections/col_grid",
  "/api/v1/collections/col_grid?sort=price-asc&material=linen",
  "/api/v1/collections/col_rail",
  "/api/v1/collections/col_rail?sort=discount",
  "/api/v1/attributes/search-filters?q=linen",
  "/api/v1/attributes/category-slug/panjabi",
  "/api/v1/attributes/category/cat_panjabi",
] as const;

async function seededCatalogue() {
  const { sqlite, db, binding } = createSqliteD1Database();
  sqlite.exec(SEED);
  await rebuildCatalogProjections(db);
  await refreshProductSalesStats(db);
  await refreshProductRecommendations(db, ["p_linen", "p_cotton"]);
  const env = {
    DB: binding,
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    JWT_SECRET: "cache-deps-catalogue-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: "cache-deps-catalogue-credential-key-0123456789",
    STOREFRONT_URL: "https://shop.test",
  } as unknown as Env;
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  return { sqlite, db, env, ctx };
}

async function renderScoped(
  url: string,
  env: Env,
  ctx: ExecutionContext,
  strict: boolean,
): Promise<{ status: number; body: unknown; dependencies: CacheDependencies }> {
  const { value, dependencies } = await withDependencyScope(async () => {
    const response = await fetchRuntimeApiApp(new Request(`https://api.internal${url}`), env, ctx);
    return { status: response.status, body: await response.json() as unknown };
  }, { strict, label: url, log: () => undefined });
  return { ...value, dependencies };
}

type Seeded = Awaited<ReturnType<typeof seededCatalogue>>;

function clock(seeded: Seeded): number {
  return (seeded.sqlite.prepare("SELECT seq FROM cache_clock").get() as { seq: number }).seq;
}

/** Keys of `keys` a committed change advanced after `s0`. */
function advancedSince(seeded: Seeded, s0: number, keys: readonly string[]): string[] {
  return (seeded.sqlite.prepare(
    "SELECT dep FROM cache_dep WHERE seq > ? AND dep IN (SELECT value FROM json_each(?)) ORDER BY dep",
  ).all(s0, JSON.stringify(keys)) as Array<{ dep: string }>).map((row) => row.dep);
}

async function refreshProjections(seeded: Seeded, productIds: string[]): Promise<void> {
  await safeBatch(seeded.db, catalogProjectionRefreshStatements(seeded.db, productIds));
}

/**
 * Render, write, render again: when the response changed, a key the first
 * render declared must have advanced (the stored entry would be rejected).
 */
async function expectWriteInvalidates(
  seeded: Seeded,
  url: string,
  write: () => Promise<void> | void,
  options: { mustChange?: boolean } = {},
): Promise<{ advanced: string[]; changed: boolean }> {
  const s0 = clock(seeded);
  const before = await renderScoped(url, seeded.env, seeded.ctx, true);
  expect(before.status, url).toBe(200);
  await write();
  const after = await renderScoped(url, seeded.env, seeded.ctx, true);
  const changed = JSON.stringify(before.body) !== JSON.stringify(after.body);
  const advanced = advancedSince(seeded, s0, before.dependencies.keys);
  if (options.mustChange) expect(changed, `${url} changed`).toBe(true);
  if (changed) expect(advanced, `${url}: a changed response must advance a declared key`).not.toEqual([]);
  return { advanced, changed };
}

/** Field names that are row machinery, never buyer facts. */
const INTERNAL_FIELDS = new Set(["updatedAt", "revision", "version", "aggregateRevision", "stockVersion"]);

function internalFieldPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => internalFieldPaths(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(INTERNAL_FIELDS.has(key) ? [`${path}.${key}`] : []),
    ...internalFieldPaths(child, `${path}.${key}`),
  ]);
}

describe("catalogue dependency declarations", () => {
  it("covers every table each public catalogue read touches, strictly, with no coarse fallback", async () => {
    const seeded = await seededCatalogue();
    const report: Array<[string, number]> = [];
    for (const url of CATALOGUE_URLS) {
      const { status, dependencies } = await renderScoped(url, seeded.env, seeded.ctx, true);
      expect(status, url).toBe(200);
      expect(dependencies.coarseTables, url).toEqual([]);
      expect(dependencies.collapsedKinds, url).toEqual([]);
      // Only the legacy search, ordered by an untracked column, opts out.
      expect(dependencies.uncacheable, url).toEqual(url.startsWith("/api/v1/products/search") ? ["order-by-untracked-column"] : []);
      report.push([url, dependencies.keys.length]);
    }
    if (process.env.CACHE_DEPS_CATALOGUE_REPORT) console.log(JSON.stringify(report));
  }, 120_000);

  it("declares the registry's keys for each read shape", async () => {
    const seeded = await seededCatalogue();
    const keysOf = async (url: string) => (await renderScoped(url, seeded.env, seeded.ctx, true)).dependencies;

    // Listing: membership, price range, order, facets, cards and their images.
    const categoryListing = await keysOf("/api/v1/categories/panjabi/products?sort=name-asc");
    expect(categoryListing.keys).toEqual(expect.arrayContaining([
      "lm:cat:cat_panjabi", "lo:price:cat:cat_panjabi", "lo:name:cat:cat_panjabi", "lf:cat:cat_panjabi",
      "p:p_linen", "p:p_cotton", "m:media_linen", "m:media_linen_2", "m:media_cotton",
      "c:cat_panjabi", "c:cat_eid", "attr:*", "b:*", "set:currency:document",
    ]));
    // Card images: the primary and the hover photo, never the rest of the gallery.
    expect(categoryListing.keys).not.toContain("m:media_linen_3");

    const shopAll = await keysOf("/api/v1/products?page=1&limit=20&sort=discount&hasDiscount=true");
    expect(shopAll.keys).toEqual(expect.arrayContaining(["lm:all", "lo:price:all", "lo:disc:all"]));

    // Search: its text and the public set.
    const search = await keysOf("/api/v1/products?search=linen");
    expect(search.keys).toEqual(expect.arrayContaining(["srch", "lm:all"]));

    // Manual collection: its row and every configured member; dynamic: its categories.
    const manual = await keysOf("/api/v1/collections/col_grid");
    expect(manual.keys).toEqual(expect.arrayContaining(["col:col_grid", "p:p_linen", "p:p_cotton"]));
    expect(manual.keys.some((key) => key.startsWith("lm:"))).toBe(false);
    const dynamic = await keysOf("/api/v1/collections/col_rail?sort=discount");
    expect(dynamic.keys).toEqual(expect.arrayContaining([
      "col:col_rail", "lm:cat:cat_panjabi", "lo:disc:cat:cat_panjabi", "lo:price:cat:cat_panjabi", "c:cat_panjabi",
    ]));

    // Sitemap and feed: the public set, the discovery flags, each row.
    const sitemap = await keysOf("/api/v1/products/sitemap");
    expect(sitemap.keys).toEqual(expect.arrayContaining(["lm:all", "lm:seo", "p:p_linen", "p:p_cotton"]));
    const feed = await keysOf("/api/v1/products/feed?limit=10");
    expect(feed.keys).toEqual(expect.arrayContaining([
      "lm:all", "lm:seo", "p:p_linen", "p:p_cotton", "set:inventory:document",
      "t:product_variants", "t:product_media", "t:media",
    ]));

    // Band-showing reads depend on the store's low-stock level.
    for (const url of ["/api/v1/products/linen-panjabi", "/api/v1/products/compare?ids=p_linen,p_cotton"]) {
      expect((await keysOf(url)).keys, url).toContain("set:inventory:document");
    }

    // Product page: its product, category, brand, gallery, promotions, EMI and
    // recommendations (soft order, hard cards).
    const page = await keysOf("/api/v1/products/linen-panjabi");
    expect(page.keys).toEqual(expect.arrayContaining([
      "p:p_linen", "c:cat_eid", "b:brd_walton01", "m:media_linen", "m:media_linen_2", "m:media_linen_3",
      "promo:*", "set:emi:document", "set:currency:document", "attr:*",
    ]));
    expect(page.softMaxAgeSeconds).toBe(600);

    // Soft ordering: recommendations lag by at most the soft bound.
    expect((await keysOf("/api/v1/products/recommendations?productIds=p_linen,p_cotton")).softMaxAgeSeconds).toBe(600);

    // Brand page and wall: the brand, its logo file.
    expect((await keysOf("/api/v1/brands/walton")).keys).toEqual(expect.arrayContaining(["b:brd_walton01", "m:media_logo"]));
    expect((await keysOf("/api/v1/brands")).keys).toEqual(expect.arrayContaining(["b:*", "m:media_logo"]));
  }, 120_000);

  it("rejects a stored listing whose facet counts change when a product leaves the category", async () => {
    const seeded = await seededCatalogue();
    seeded.sqlite.exec("INSERT INTO categories (id, name, slug, status) VALUES ('cat_other', 'Other', 'other', 'published')");
    for (const url of [
      "/api/v1/categories/panjabi/products?includeSubcategories=true",
      "/api/v1/attributes/category/cat_panjabi",
    ]) {
      // p_linen (the only Linen product) moves out of the Panjabi subtree.
      const { advanced } = await expectWriteInvalidates(seeded, url, async () => {
        seeded.sqlite.prepare("UPDATE products SET category_id = 'cat_other' WHERE id = 'p_linen'").run();
        await refreshProjections(seeded, ["p_linen"]);
      }, { mustChange: true });
      // Both the membership and the facet keys of the scope advance.
      expect(advanced, url).toEqual(expect.arrayContaining(["lm:cat:cat_panjabi"]));
      seeded.sqlite.prepare("UPDATE products SET category_id = 'cat_eid' WHERE id = 'p_linen'").run();
      await refreshProjections(seeded, ["p_linen"]);
    }
  }, 120_000);

  it("rejects stored reads on the writes that change them, and keeps them on writes that do not", async () => {
    const seeded = await seededCatalogue();
    // A card's image file changes (rendition, alt text).
    await expectWriteInvalidates(seeded, "/api/v1/categories/panjabi/products?includeSubcategories=true", () => {
      seeded.sqlite.prepare("UPDATE media SET alt_text = 'Linen front' WHERE id = 'media_linen'").run();
    }, { mustChange: true });
    // The brand is unpublished: the product page drops it.
    await expectWriteInvalidates(seeded, "/api/v1/products/linen-panjabi", () => {
      seeded.sqlite.prepare("UPDATE brands SET status = 'draft' WHERE id = 'brd_walton01'").run();
    }, { mustChange: true });
    // An ancestor's attribute set changes a sub-category's facets.
    seeded.sqlite.prepare("INSERT INTO product_attributes (id, name, slug, filterable, value_type, facet_display) VALUES ('attr_fit', 'Fit', 'fit', 1, 'text', 'checkbox')").run();
    seeded.sqlite.prepare("INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_fit', 'p_linen', 'attr_fit', 'Slim')").run();
    await refreshProjections(seeded, ["p_linen"]);
    await expectWriteInvalidates(seeded, "/api/v1/categories/eid/products", () => {
      seeded.sqlite.prepare("INSERT INTO category_attribute_sets (category_id, attribute_id, sort_order) VALUES ('cat_panjabi', 'attr_fit', 1)").run();
    }, { mustChange: true });
    // Stock inside its band: nothing the page shows changes, no key advances.
    const s0 = clock(seeded);
    const before = await renderScoped("/api/v1/products/linen-panjabi", seeded.env, seeded.ctx, true);
    seeded.sqlite.prepare("UPDATE product_variants SET stock = stock + 7 WHERE id = 'v_linen_m'").run();
    const after = await renderScoped("/api/v1/products/linen-panjabi", seeded.env, seeded.ctx, true);
    expect(after.body).toEqual(before.body);
    expect(advancedSince(seeded, s0, before.dependencies.keys)).toEqual([]);
  }, 120_000);

  it("carries no internal row fields (updatedAt, revision, version) in buyer catalogue payloads", async () => {
    const seeded = await seededCatalogue();
    for (const url of [
      "/api/v1/products?page=1&limit=20",
      "/api/v1/products/linen-panjabi",
      "/api/v1/products/linen-panjabi/sections/summary",
      "/api/v1/products/linen-panjabi/sections/variants",
      "/api/v1/categories/panjabi/products",
      "/api/v1/categories/panjabi/products?includeSubcategories=true",
      "/api/v1/categories/panjabi/product-summaries",
      "/api/v1/categories/summaries",
      "/api/v1/collections/col_grid",
      "/api/v1/collections/col_rail",
    ]) {
      const { status, body } = await renderScoped(url, seeded.env, seeded.ctx, true);
      expect(status, url).toBe(200);
      expect(internalFieldPaths(body), url).toEqual([]);
    }
    // Sitemaps keep lastmod: a real public fact.
    for (const [url, list] of [
      ["/api/v1/products/sitemap", "products"],
      ["/api/v1/categories/sitemap", "categories"],
      ["/api/v1/collections/sitemap", "collections"],
    ] as const) {
      const { body } = await renderScoped(url, seeded.env, seeded.ctx, true);
      const rows = (body as { data: Record<string, Array<{ updatedAt: string | null }>> }).data[list]!;
      expect(rows.length, url).toBeGreaterThan(0);
      expect(rows.every((row) => typeof row.updatedAt === "string"), url).toBe(true);
    }
  }, 120_000);

  it("lists only indexable categories and collections in their sitemaps, filtered before the limit", async () => {
    const seeded = await seededCatalogue();
    seeded.sqlite.exec(`
      INSERT INTO categories (id, name, slug, status, no_index) VALUES ('cat_hidden', 'Hidden', 'hidden', 'published', 1);
      INSERT INTO categories (id, name, slug, status, exclude_from_sitemap) VALUES ('cat_excluded', 'Excluded', 'excluded', 'published', 1);
      INSERT INTO categories (id, name, slug, status) VALUES ('cat_draft', 'Draft', 'draft', 'draft');
      UPDATE categories SET canonical_path = '/categories/panjabi-wear' WHERE id = 'cat_panjabi';
      INSERT INTO collections (id, name, presentation, config, sort_order, no_index) VALUES ('col_hidden', 'Hidden', 'grid', '{"source":"manual","productIds":[]}', 2, 1);
      INSERT INTO collections (id, name, presentation, config, sort_order, is_active) VALUES ('col_off', 'Off', 'grid', '{"source":"manual","productIds":[]}', 3, 0);
    `);
    const categories = (await renderScoped("/api/v1/categories/sitemap", seeded.env, seeded.ctx, true)).body as {
      data: { categories: Array<{ slug: string; canonicalPath: string | null }> };
    };
    expect(categories.data.categories.map((row) => row.slug).sort()).toEqual(["eid", "panjabi"]);
    expect(categories.data.categories.find((row) => row.slug === "panjabi")?.canonicalPath).toBe("/categories/panjabi-wear");
    const collections = (await renderScoped("/api/v1/collections/sitemap", seeded.env, seeded.ctx, true)).body as {
      data: { collections: Array<{ id: string }> };
    };
    expect(collections.data.collections.map((row) => row.id)).toEqual(["col_grid", "col_rail"]);
  }, 120_000);
});
