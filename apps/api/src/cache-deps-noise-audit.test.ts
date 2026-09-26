// Noise-column audit for the cache dependency registry (opt-in). A column in
// a table's `noise` list advances no key, so a change of it alone must never
// change a cached public read. This renders every cached public route on a
// copy of a real local store, changes each noise column of each registered
// table on real rows, and reports every public JSON path that moved.
//
//   CACHE_DEP_NOISE_AUDIT_DB=/tmp/copy-of-local-d1.sqlite pnpm vitest run src/cache-deps-noise-audit.test.ts
//
// The file is opened in place: point it at a disposable copy.
import "@hono/zod-openapi";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { CACHE_DEP_TABLES, type CacheDepTableSpec } from "@scalius/shared/cache-deps";
import { storefrontTemplateTheme } from "@scalius/shared/storefront-theme";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";

const databasePath = process.env.CACHE_DEP_NOISE_AUDIT_DB?.trim();

/**
 * One row for each registered table a small local store often lacks, so
 * every table's noise columns are exercised. Each insert runs only when the
 * table is empty; ids are fixed and constraint-valid (foreign keys are off).
 */
const AUDIT_FILL_ROWS: ReadonlyArray<{ table: string; sql: string; present?: string }> = [
  { table: "brands", sql: "INSERT INTO brands (id, name, slug, status) VALUES ('brd_noiseaudit', 'Noise Audit', 'noise-audit', 'published')" },
  { table: "attribute_groups", sql: "INSERT INTO attribute_groups (id, name) VALUES ('atg_noiseaudit', 'Noise audit')" },
  { table: "analytics", sql: "INSERT INTO analytics (id, name, type, is_active, use_partytown, config, location) VALUES ('analytics_noiseaudit', 'Noise audit', 'custom', 1, 0, '<script>window.noiseAudit=1</script>', 'head')" },
  {
    // Articles share the pages table; their payload keeps updatedAt.
    table: "pages",
    present: "SELECT 1 FROM pages WHERE content_type = 'article' AND is_published = 1 AND deleted_at IS NULL LIMIT 1",
    sql: "INSERT INTO pages (id, content_type, title, slug, content, is_published) VALUES ('article_noiseaudit', 'article', 'Noise audit', 'noise-audit-article', '<p>x</p>', 1)",
  },
  { table: "delivery_zones", sql: "INSERT INTO delivery_zones (id, name) VALUES ('dz_noiseaudit', 'Noise audit zone')" },
  {
    table: "product_content_blocks",
    sql: "INSERT INTO product_content_blocks (id, product_id, placement, type, settings) SELECT 'pcb_noiseaudit', id, 'after-description', 'rich-text', '{\"title\":\"Care\",\"html\":\"<p>Hand wash.</p>\"}' FROM products WHERE is_active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1",
  },
  {
    table: "product_bundles",
    sql: "INSERT INTO product_bundles (id, product_id, quantity, discount_type, discount_bps) SELECT 'pbd_noiseaudit', id, 2, 'percentage', 1000 FROM products WHERE is_active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1",
  },
];

const STATIC_URLS = [
  "/api/v1/products?page=1&limit=50",
  "/api/v1/products?page=1&limit=50&sort=price-asc",
  "/api/v1/products/feed?limit=100",
  "/api/v1/products/sitemap",
  "/api/v1/categories",
  "/api/v1/categories/tree",
  "/api/v1/brands",
  "/api/v1/brands/sitemap",
  "/api/v1/collections",
  "/api/v1/storefront/homepage",
  "/api/v1/storefront/layout",
  "/api/v1/checkout/config",
  "/api/v1/checkout-languages/active",
  "/api/v1/shipping-methods",
  "/api/v1/locations/cities",
  "/api/v1/attributes/search-filters",
  "/api/v1/pages",
  "/api/v1/articles",
  "/api/v1/hero/sliders?type=desktop",
  "/api/v1/hero/sliders?type=mobile",
  "/api/v1/analytics/configurations",
  "/api/v1/seo",
  "/api/v1/header",
  "/api/v1/navigation",
  "/api/v1/navigation/placements",
  "/api/v1/footer",
];

function changedPaths(before: unknown, after: unknown, path = "$", out: string[] = []): string[] {
  if (out.length > 20) return out;
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  if (before && after && typeof before === "object" && typeof after === "object") {
    const keys = new Set([...Object.keys(before as object), ...Object.keys(after as object)]);
    for (const key of keys) {
      changedPaths((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], `${path}.${key}`, out);
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(before)?.slice(0, 40)} -> ${JSON.stringify(after)?.slice(0, 40)}`);
  return out;
}

describe.runIf(databasePath)("cache dependency noise-column audit", () => {
  it("no noise column changes a cached public read", async () => {
    const sqlite = new DatabaseSync(databasePath!);
    sqlite.exec("PRAGMA foreign_keys = OFF");
    if (!sqlite.prepare("SELECT 1 FROM theme_settings").get()) {
      sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)")
        .run(JSON.stringify(storefrontTemplateTheme("department-mall")));
    }
    for (const fill of AUDIT_FILL_ROWS) {
      if (!sqlite.prepare(fill.present ?? `SELECT 1 FROM "${fill.table}" LIMIT 1`).get()) sqlite.exec(fill.sql);
    }
    const { binding } = createSqliteD1Database({ sqlite });
    const env = {
      DB: binding,
      CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
      JWT_SECRET: "cache-deps-noise-secret-0123456789abcdef",
      CREDENTIAL_ENCRYPTION_KEY: "cache-deps-noise-credential-key-0123456789",
      STOREFRONT_URL: "https://shop.test",
    } as unknown as Env;
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const pick = (sql: string) => (sqlite.prepare(sql).all() as Array<{ v: string }>).map((row) => row.v);
    const urls = [
      ...STATIC_URLS,
      ...pick("SELECT slug AS v FROM products WHERE is_active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 3")
        .flatMap((slug) => [`/api/v1/products/${slug}`, `/api/v1/products/${slug}/sections/variants`]),
      ...pick("SELECT slug AS v FROM categories WHERE status = 'published' AND deleted_at IS NULL ORDER BY id LIMIT 2")
        .flatMap((slug) => [`/api/v1/categories/${slug}`, `/api/v1/categories/${slug}/products`]),
      ...pick("SELECT slug AS v FROM brands WHERE deleted_at IS NULL ORDER BY id LIMIT 1")
        .flatMap((slug) => [`/api/v1/brands/${slug}`, `/api/v1/brands/${slug}/products`]),
      ...pick("SELECT id AS v FROM collections WHERE deleted_at IS NULL ORDER BY id LIMIT 2").map((id) => `/api/v1/collections/${id}`),
      ...pick("SELECT slug AS v FROM pages WHERE is_published = 1 AND deleted_at IS NULL AND content_type = 'page' ORDER BY id LIMIT 1")
        .flatMap((slug) => [`/api/v1/pages/slug/${slug}`, `/api/v1/storefront/pages/slug/${slug}`]),
      ...pick("SELECT slug AS v FROM pages WHERE is_published = 1 AND deleted_at IS NULL AND content_type = 'article' ORDER BY id LIMIT 1")
        .map((slug) => `/api/v1/articles/slug/${slug}`),
    ];
    const render = async () => {
      const bodies = new Map<string, unknown>();
      for (const url of urls) {
        const response = await fetchRuntimeApiApp(new Request(`https://api.internal${url}`), env, ctx);
        bodies.set(url, response.status === 200 ? await response.json() : { status: response.status });
      }
      return bodies;
    };
    const baseline = await render();
    // The renders are deterministic.
    const again = await render();
    const unstable = urls.filter((url) => JSON.stringify(baseline.get(url)) !== JSON.stringify(again.get(url)));
    expect(unstable).toEqual([]);

    const findings: string[] = [];
    for (const [table, spec] of Object.entries(CACHE_DEP_TABLES as Record<string, CacheDepTableSpec>)) {
      for (const column of spec.noise) {
        // A noise column that a dedicated rule watches (the sitemap lastmod) advances keys of its own.
        if (spec.rules.some((rule) => Array.isArray(rule.changed) && rule.changed.includes(column))) continue;
        // Raw stock is noise only inside its band: move it where the band cannot change.
        const inBand = table === "product_variants" && (column === "stock" || column === "reserved_stock")
          ? " WHERE track_inventory = 0 OR (stock - reserved_stock BETWEEN 30 AND 100000 AND COALESCE(low_stock_threshold, 0) < 20)"
          : "";
        const rows = sqlite.prepare(`SELECT rowid AS r, "${column}" AS v FROM "${table}"${inBand} ORDER BY rowid LIMIT 40`).all() as Array<{ r: number; v: unknown }>;
        if (rows.length === 0) {
          findings.push(`${table}.${column}: no rows to test`);
          continue;
        }
        const set = (row: { r: number }, value: unknown) =>
          sqlite.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`).run(value as never, row.r);
        for (const row of rows) set(row, typeof row.v === "number" ? row.v + 7 : row.v === null ? 7 : `${row.v}-x`);
        let after: Map<string, unknown>;
        try {
          after = await render();
        } finally {
          for (const row of rows) set(row, row.v);
        }
        for (const url of urls) {
          const paths = changedPaths(baseline.get(url), after.get(url));
          if (paths.length > 0) findings.push(`${table}.${column} changes ${url}: ${paths.slice(0, 4).join("; ")}`);
        }
      }
    }
    console.log(`[noise audit] ${urls.length} urls\n${findings.join("\n")}`);
    // Every public payload that output a noise column dropped it at the source.
    expect(findings.filter((finding) => !finding.endsWith("no rows to test"))).toEqual([]);
    sqlite.close();
  }, 900_000);
});
