// Registry completeness for the dependency-validated cache (CACHE-DESIGN.md
// §7.3): every table that a cached public read touches is either registered
// in `@scalius/shared/cache-deps` (so the 0100 triggers advance a key when it
// changes) or explicitly exempt with a reason. The reads are the real API
// routes of `PUBLIC_API_CACHE_ROUTES`, rendered in-process on the migrated
// schema; the tables are taken from every executed statement.
import "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import { refreshProductRecommendations, refreshProductSalesStats } from "@scalius/core/modules/catalog";
import { cacheDepExemptReason, cacheDepKindsForTable } from "@scalius/shared/cache-deps";
import { PUBLIC_API_CACHE_ROUTES, isPublicApiCacheRoute } from "@scalius/shared/public-api-cache-routes";
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
    ('media_linen', 'linen.jpg', 'image', 'media/linen.jpg', 1, 'image/jpeg', 'ready', 1600, 1600, 1600);
  INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_linen', 'p_linen', 'media_linen', 1, 0);
  INSERT INTO product_rich_content (id, product_id, title, content, sort_order) VALUES ('prc_care', 'p_linen', 'Care', '<p>Hand wash.</p>', 0);
  INSERT INTO product_bundles (id, product_id, quantity, discount_type, discount_bps) VALUES ('pbd_linen_pair', 'p_linen', 2, 'percentage', 1000);
  INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
    ('col_grid', 'Best sellers', 'grid', '{"source":"manual","productIds":["p_linen","p_cotton"],"showOnHomepage":true,"maxProducts":8}', 0),
    ('col_rail', 'Panjabi', 'carousel', '{"source":"dynamic","categoryIds":["cat_panjabi"],"showOnHomepage":true,"maxProducts":12}', 1);
  INSERT INTO hero_sliders (id, type, images) VALUES ('hero_desktop', 'desktop', '[]');
  INSERT INTO pages (id, title, slug, content, is_published) VALUES ('pg_about', 'About', 'about', '<p>x</p>', 1);
  INSERT INTO pages (id, content_type, title, slug, content, is_published) VALUES ('pg_post', 'article', 'Post', 'post', '<p>x</p>', 1);
  INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
    VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1),
           ('area_1', 'Banani', 'area', 'zone_1', '{}', '{}', 1);
  INSERT INTO shipping_methods (id, name, fee_minor, kind) VALUES ('m_ship', 'Standard', 6000, 'delivery');
  INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at) VALUES
    ('o_1', 'A', '01700000001', 'Road', 'city', 'zone', 'delivered', unixepoch(), unixepoch());
  INSERT INTO order_items (id, order_id, product_id, quantity) VALUES ('oi_1', 'o_1', 'p_linen', 1);
`;

/** Representative reads of every cached public route family. */
const URLS = [
  "/api/v1/products?page=1&limit=20",
  "/api/v1/products?page=1&limit=20&sort=price-asc&material=linen",
  "/api/v1/products?page=1&limit=20&sort=name-asc",
  "/api/v1/products?search=linen",
  "/api/v1/products/search?q=linen",
  "/api/v1/products/feed?limit=10",
  "/api/v1/products/sitemap",
  "/api/v1/products/recommendations?productId=p_linen",
  "/api/v1/products/recommendations",
  "/api/v1/products/compare?ids=p_linen,p_cotton",
  "/api/v1/products/linen-panjabi",
  "/api/v1/products/linen-panjabi/sections/summary",
  "/api/v1/products/linen-panjabi/sections/media",
  "/api/v1/products/linen-panjabi/sections/variants",
  "/api/v1/categories",
  "/api/v1/categories/summaries",
  "/api/v1/categories/tree",
  "/api/v1/categories/panjabi",
  "/api/v1/categories/panjabi/children",
  "/api/v1/categories/eid/breadcrumb",
  "/api/v1/categories/panjabi/products",
  "/api/v1/categories/panjabi/products?sort=price-desc",
  "/api/v1/categories/panjabi/product-summaries",
  "/api/v1/categories/panjabi/sections/summary",
  "/api/v1/brands",
  "/api/v1/brands/sitemap",
  "/api/v1/brands/walton",
  "/api/v1/brands/walton/products",
  "/api/v1/collections",
  "/api/v1/collections/col_grid",
  "/api/v1/collections/col_rail",
  "/api/v1/storefront/homepage",
  "/api/v1/storefront/layout",
  "/api/v1/storefront/pages/slug/about",
  "/api/v1/checkout/config",
  "/api/v1/checkout-languages/active",
  "/api/v1/shipping-methods",
  "/api/v1/locations/cities",
  "/api/v1/locations/zones?cityId=city_1",
  "/api/v1/locations/areas?zoneId=zone_1",
  "/api/v1/attributes/search-filters",
  "/api/v1/attributes/category-slug/panjabi",
  "/api/v1/attributes/category/cat_panjabi",
  "/api/v1/pages",
  "/api/v1/pages/slug/about",
  "/api/v1/articles",
  "/api/v1/articles/slug/post",
  "/api/v1/hero/sliders?type=desktop",
  "/api/v1/hero/sliders/hero_desktop",
  "/api/v1/seo",
  "/api/v1/header",
  "/api/v1/navigation",
  "/api/v1/navigation/placements",
  "/api/v1/footer",
];

const TABLE_REFERENCE = /\b(?:from|join|into|update)\s+[`"]?([a-z0-9_]+)[`"]?/gi;

describe("cache dependency registry coverage of public reads", () => {
  it("names a key kind or an exemption for every table a cached public read touches", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(SEED);
    await rebuildCatalogProjections(db);
    await refreshProductSalesStats(db);
    await refreshProductRecommendations(db, ["p_linen", "p_cotton"]);
    const knownTables = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name));

    const touched = new Map<string, Set<string>>();
    let route = "";
    const { binding } = createSqliteD1Database({
      sqlite,
      onQuery: (query) => {
        for (const match of query.matchAll(TABLE_REFERENCE)) {
          const table = match[1]!.toLowerCase();
          if (!knownTables.has(table)) continue;
          if (!touched.has(table)) touched.set(table, new Set());
          touched.get(table)!.add(route);
        }
      },
    });
    const env = {
      DB: binding,
      CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
      JWT_SECRET: "cache-deps-coverage-secret-0123456789abcdef",
      CREDENTIAL_ENCRYPTION_KEY: "cache-deps-coverage-credential-key-0123456789",
      STOREFRONT_URL: "https://shop.test",
    } as unknown as Env;
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

    const statuses: Record<string, number> = {};
    for (const url of URLS) {
      route = url;
      expect(isPublicApiCacheRoute(new URL(url, "https://api.internal")), url).toBe(true);
      const response = await fetchRuntimeApiApp(new Request(`https://api.internal${url}`), env, ctx);
      statuses[url] = response.status;
    }
    // Every cached route family is exercised, and every read succeeds.
    for (const cached of PUBLIC_API_CACHE_ROUTES) {
      expect(URLS.some((url) => url === cached.path || url.startsWith(`${cached.path}/`) || url.startsWith(`${cached.path}?`)), cached.path)
        .toBe(true);
    }
    expect(Object.entries(statuses).filter(([, status]) => status !== 200)).toEqual([]);

    const uncovered = [...touched.keys()].sort()
      .filter((table) => cacheDepKindsForTable(table) === null && cacheDepExemptReason(table) === null)
      .map((table) => `${table} (read by ${[...touched.get(table)!].slice(0, 3).join(", ")})`);
    expect(uncovered).toEqual([]);
    // The reads really reach the catalogue, content and settings tables.
    for (const table of ["products", "product_buyer_state", "product_facet_values", "product_variants", "categories", "category_closure", "settings", "navigation_placements", "pages"]) {
      expect(touched.has(table), table).toBe(true);
    }
  }, 120_000);
});
