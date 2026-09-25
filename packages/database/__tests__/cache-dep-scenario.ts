/**
 * Provider-neutral trigger scenario for migration 0100: plain SQL writes and
 * the keys each one must (and must not) advance. The D1, Turso (node:sqlite
 * and the real Turso engine) and PostgreSQL tests run the same steps.
 */
import { expect } from "vitest";

export interface CacheDepDriver {
  exec(sql: string): Promise<void>;
  rows(sql: string): Promise<Array<Record<string, unknown>>>;
}

export const CACHE_DEP_SEED = [
  "INSERT INTO categories (id, name, slug, status) VALUES ('cat_root', 'Root', 'root', 'published')",
  "INSERT INTO categories (id, name, slug, status, parent_id) VALUES ('cat_leaf', 'Leaf', 'leaf', 'published', 'cat_root')",
  "INSERT INTO categories (id, name, slug, status) VALUES ('cat_other', 'Other', 'other', 'published')",
  "INSERT INTO brands (id, name, slug, status) VALUES ('brd_xbrand01', 'X', 'x', 'published')",
  "INSERT INTO settings (id, key, value, type, category) VALUES ('set_inventory', 'document', '{\"defaultLowStockThreshold\":2}', 'json', 'inventory')",
  "INSERT INTO products (id, name, price_minor, slug, category_id, brand_id, is_active, created_at) VALUES ('p1', 'One', 100, 'one', 'cat_leaf', 'brd_xbrand01', 1, 1700000000)",
  "INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES ('v1', 'p1', 'CD-1', 100, 5, 0, 1, 1)",
  "INSERT INTO product_buyer_state (product_id, is_public, category_id, brand_id, product_created_at, sku_id, from_minor, to_minor, base_minor, availability_band, available_for_sale) VALUES ('p1', 1, 'cat_leaf', 'brd_xbrand01', 1700000000, 'v1', 100, 100, 100, 'in_stock', 1)",
  "INSERT INTO product_attributes (id, name, slug, filterable, value_type, facet_display) VALUES ('attr_mat', 'Material', 'material', 1, 'text', 'checkbox')",
  "INSERT INTO category_attribute_sets (category_id, attribute_id) VALUES ('cat_leaf', 'attr_mat')",
  "INSERT INTO navigation_menus (id, name, handle, revision, published_revision) VALUES ('menu_a', 'A', 'a', 1, 1), ('menu_b', 'B', 'b', 1, 1)",
  "INSERT INTO navigation_menu_publications (menu_id, revision, item_count, checksum) VALUES ('menu_a', 1, 1, 'a1'), ('menu_b', 1, 0, 'b1')",
  "INSERT INTO navigation_menu_publication_items (menu_id, revision, item_id, parent_id, position, label, label_mode, target_type, target_id, target_value, target_query, open_in_new_tab, is_enabled) VALUES ('menu_a', 1, 'item_1', NULL, 0, 'Sale', 'custom', 'internal_path', NULL, '/sale', NULL, 0, 1)",
];

async function clock(driver: CacheDepDriver): Promise<number> {
  const [row] = await driver.rows("SELECT seq FROM cache_clock WHERE id = 1");
  return Number(row!.seq);
}

/** The keys advanced by `write`, and the clock invariants around it. */
export async function bumped(driver: CacheDepDriver, write: string | string[]): Promise<string[]> {
  const before = await clock(driver);
  for (const statement of Array.isArray(write) ? write : [write]) await driver.exec(statement);
  const after = await clock(driver);
  const keys = await driver.rows(`SELECT dep, seq FROM cache_dep WHERE seq > ${before} ORDER BY dep`);
  const [max] = await driver.rows("SELECT max(seq) AS seq FROM cache_dep");
  // The clock is the newest key: a reader of `after` sees every key it covers.
  expect(Number(max!.seq ?? 0)).toBe(after);
  if (keys.length === 0) expect(after).toBe(before);
  for (const key of keys) expect(Number(key.seq)).toBeGreaterThan(before);
  return keys.map((key) => String(key.dep));
}

const p1Scopes = (facet: string) => [`${facet}:all`, `${facet}:brand:brd_xbrand01`, `${facet}:cat:cat_leaf`, `${facet}:cat:cat_root`];

/** Every step of the scenario; `postgres` skips the steps whose SQL differs. */
export async function runCacheDepScenario(driver: CacheDepDriver): Promise<void> {
  for (const statement of CACHE_DEP_SEED) await driver.exec(statement);
  expect(await clock(driver)).toBeGreaterThan(0);

  // Stock inside its band advances nothing (5 -> 4 -> 3: in stock, level 2).
  expect(await bumped(driver, "UPDATE product_variants SET stock = 4 WHERE id = 'v1'")).toEqual([]);
  expect(await bumped(driver, "UPDATE product_variants SET stock = 3, stock_version = stock_version + 1, version = version + 1 WHERE id = 'v1'")).toEqual([]);
  // Crossing into low stock (3 - 1 reserved = 2 <= 2) advances the product.
  expect(await bumped(driver, "UPDATE product_variants SET reserved_stock = 1 WHERE id = 'v1'"))
    .toEqual(["p:p1", "t:product_variants"]);
  // Still low: nothing. Sold out: the product again.
  expect(await bumped(driver, "UPDATE product_variants SET stock = 2 WHERE id = 'v1'")).toEqual([]);
  expect(await bumped(driver, "UPDATE product_variants SET reserved_stock = 2 WHERE id = 'v1'"))
    .toEqual(["p:p1", "t:product_variants"]);
  // A store default change moves the band of every SKU that uses it: the settings key.
  expect(await bumped(driver, "UPDATE settings SET value = '{\"defaultLowStockThreshold\":0}', revision = revision + 1 WHERE id = 'set_inventory'"))
    .toEqual(["set:inventory:document", "t:settings"]);
  // A visible SKU fact.
  expect(await bumped(driver, "UPDATE product_variants SET price_minor = 120 WHERE id = 'v1'"))
    .toEqual(["p:p1", "t:product_variants"]);

  // Buyer state: a rewrite with equal facts (the refresh upsert) advances nothing.
  expect(await bumped(driver, "UPDATE product_buyer_state SET refreshed_at = refreshed_at + 1 WHERE product_id = 'p1'")).toEqual([]);
  expect(await bumped(driver, "UPDATE product_buyer_state SET from_minor = 90, to_minor = 90, base_minor = 100, has_discount = 1, discount_depth_bps = 1000 WHERE product_id = 'p1'"))
    .toEqual([...p1Scopes("lo:disc"), ...p1Scopes("lo:price"), "p:p1", "t:product_buyer_state"].sort());
  expect(await bumped(driver, "UPDATE product_buyer_state SET availability_band = 'low_stock' WHERE product_id = 'p1'"))
    .toEqual([...p1Scopes("lo:band"), "p:p1", "t:product_buyer_state"].sort());

  // Product text: page, search and the name order of its public scopes.
  expect(await bumped(driver, "UPDATE products SET name = 'One renamed' WHERE id = 'p1'"))
    .toEqual([...p1Scopes("lo:name"), "p:p1", "srch", "t:products"].sort());
  // Search matches a product by its category's name too.
  expect(await bumped(driver, "UPDATE products SET category_id = 'cat_other' WHERE id = 'p1'"))
    .toEqual(["p:p1", "srch", "t:products"]);
  expect(await bumped(driver, "UPDATE products SET category_id = 'cat_leaf' WHERE id = 'p1'"))
    .toEqual(["p:p1", "srch", "t:products"]);
  // The editor revision is noise; updated_at is the sitemap lastmod and feed updatedAt.
  expect(await bumped(driver, "UPDATE products SET aggregate_revision = aggregate_revision + 1, tax_classification_version = tax_classification_version + 1 WHERE id = 'p1'")).toEqual([]);
  expect(await bumped(driver, "UPDATE products SET updated_at = updated_at + 1 WHERE id = 'p1'"))
    .toEqual(["lm:seo", "p:p1", "t:products"]);
  // Store shape (the layout's counts): product activity and SKU existence, nothing else.
  expect(await bumped(driver, "UPDATE products SET is_active = 0 WHERE id = 'p1'")).toEqual(["lm:shape", "p:p1", "t:products"]);
  expect(await bumped(driver, "UPDATE products SET is_active = 1 WHERE id = 'p1'")).toEqual(["lm:shape", "p:p1", "t:products"]);
  expect(await bumped(driver, "UPDATE product_variants SET deleted_at = 1700000000 WHERE id = 'v1'")).toEqual(["lm:shape", "p:p1", "t:product_variants"]);
  expect(await bumped(driver, "UPDATE product_variants SET deleted_at = NULL WHERE id = 'v1'")).toEqual(["lm:shape", "p:p1", "t:product_variants"]);
  // Stock writes set the SKU's updated_at with its counters: still inside the band, still nothing.
  expect(await bumped(driver, "UPDATE product_variants SET updated_at = updated_at + 1, stock_version = stock_version + 1 WHERE id = 'v1'")).toEqual([]);
  expect(await bumped(driver, "UPDATE products SET no_index = 1 WHERE id = 'p1'"))
    .toEqual(["lm:seo", "p:p1", "t:products"]);
  // The on-sale candidate window: a discount marker on or off, on the product or a live SKU.
  expect(await bumped(driver, "UPDATE products SET discount_type = 'percentage', discount_bps = 500 WHERE id = 'p1'"))
    .toEqual(["lo:sale:all", "p:p1", "t:products"]);
  expect(await bumped(driver, "UPDATE products SET discount_bps = 0 WHERE id = 'p1'"))
    .toEqual(["lo:sale:all", "p:p1", "t:products"]);
  expect(await bumped(driver, "UPDATE product_variants SET discount_type = 'flat', discount_amount_minor = 10 WHERE id = 'v1'"))
    .toEqual(["lo:sale:all", "p:p1", "t:product_variants"]);
  expect(await bumped(driver, "UPDATE product_variants SET discount_amount_minor = 0 WHERE id = 'v1'"))
    .toEqual(["lo:sale:all", "p:p1", "t:product_variants"]);

  // A row moved to another parent advances the one it left as well as the one it joined.
  expect(await bumped(driver, "UPDATE navigation_menu_publication_items SET menu_id = 'menu_b' WHERE item_id = 'item_1'"))
    .toEqual(["nav:*", "nav:menu_a", "nav:menu_b", "t:navigation_menu_publication_items"]);
  expect(await bumped(driver, "UPDATE category_attribute_sets SET category_id = 'cat_other' WHERE attribute_id = 'attr_mat'"))
    .toEqual(["c:cat_leaf", "c:cat_other", "t:category_attribute_sets"]);
  // A draft edit of a menu (its revision) is not public.
  expect(await bumped(driver, "UPDATE navigation_menus SET revision = revision + 1 WHERE id = 'menu_a'")).toEqual([]);

  // A category move is a membership change of both the old and the new subtree.
  expect(await bumped(driver, "UPDATE product_buyer_state SET category_id = 'cat_other' WHERE product_id = 'p1'"))
    .toEqual([...p1Scopes("lm"), "lm:cat:cat_other", "lm:shape", "p:p1", "t:product_buyer_state"].sort());
  // Unpublish: the old scopes only (and the layout's store shape).
  expect(await bumped(driver, "UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'p1'"))
    .toEqual(["lm:all", "lm:brand:brd_xbrand01", "lm:cat:cat_other", "lm:shape", "p:p1", "t:product_buyer_state"]);
  // Facts of a non-public product move no listing.
  expect(await bumped(driver, "UPDATE product_buyer_state SET from_minor = 80, to_minor = 80 WHERE product_id = 'p1'")).toEqual([]);

  // A tree move: every closure link of the moved subtree.
  const move = await bumped(driver, "UPDATE categories SET parent_id = 'cat_other' WHERE id = 'cat_leaf'");
  expect(move).toEqual(expect.arrayContaining(["c:cat_leaf", "c:cat_other", "c:cat_root", "c:*", "lm:cat:cat_other", "lm:cat:cat_root"]));

  // A closure gap cannot hide a change of the product's own category: its
  // scope comes straight from the row, next to the closure's ancestors.
  await driver.exec("DELETE FROM category_closure WHERE descendant_id = 'cat_other'");
  expect(await bumped(driver, "UPDATE product_buyer_state SET is_public = 1 WHERE product_id = 'p1'"))
    .toEqual(["lm:all", "lm:brand:brd_xbrand01", "lm:cat:cat_other", "lm:shape", "p:p1", "t:product_buyer_state"]);
  await driver.exec("UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'p1'");

  // Coarse (a rebuild batch): only `store`.
  expect(await bumped(driver, [
    "UPDATE cache_clock SET coarse = 1 WHERE id = 1",
    "UPDATE products SET name = 'Coarse' WHERE id = 'p1'",
    "UPDATE product_variants SET price_minor = 130 WHERE id = 'v1'",
    "UPDATE cache_clock SET coarse = 0 WHERE id = 1",
  ])).toEqual(["store"]);

  // Delete cascades advance the product and its parts.
  const removed = await bumped(driver, "DELETE FROM products WHERE id = 'p1'");
  expect(removed).toEqual(expect.arrayContaining(["p:p1", "srch", "t:products", "t:product_variants"]));
  expect(removed).not.toContain("t:product_buyer_state"); // it was no longer public
}
