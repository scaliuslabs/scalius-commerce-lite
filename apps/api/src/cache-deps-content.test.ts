// Strict dependency coverage of the public content and settings reads
// (CACHE-DESIGN.md section 9, slice S3b): the layout (with the theme's brand
// images), the homepage (from the theme alone), CMS pages, the cart shell
// (checkout config, checkout copy, shipping, locations), SEO and navigation. Each route renders in-process on the
// migrated schema inside a strict dependency scope, so a table read without a
// precise declared key fails here instead of falling back to `t:<table>`.
// The same harness checks that those payloads are deterministic and carry no
// editor revisions or untracked update times. CMS/article timestamps are
// public lastmod values covered by the page dependency and truthful saves.
import "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import { updatePage } from "@scalius/core/modules/pages";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import { withDependencyScope, type CacheDependencies } from "@scalius/core/cache-deps";
import {
  createNavigationMenu,
  createNavigationMenuItem,
  publishNavigationMenu,
  saveNavigationPlacement,
} from "@scalius/core/modules/navigation";
import { CACHE_DEP_ENTRY_KEY_BUDGET } from "@scalius/shared/cache-deps";
import { storefrontTemplateTheme, type StorefrontSection } from "@scalius/shared/storefront-theme";
import { fetchRuntimeApiApp } from "./runtime/fetch-runtime-app";

const FUTURE_PUBLISH_AT = Math.floor(Date.now() / 1000) + 86_400;

const document = (category: string, value: unknown) =>
  `INSERT INTO settings (id, key, category, value, type, revision) VALUES ('set_${category}', 'document', '${category}', '${JSON.stringify(value).replace(/'/g, "''")}', 'json', 1);`;

const SEED = `
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_draft', 'Draft', 'draft-cat', 'draft');
  INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES
    ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 'cat_panjabi', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
    VALUES ('v_linen', 'p_linen', 'LIN-1', 250000, 5, 0, 1, 1);
  INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, variant_width) VALUES
    ('media_hero', 'hero.jpg', 'image', 'media/hero.jpg', 1, 'image/jpeg', 'ready', 1600, 600, 1600),
    ('media_banner', 'banner.jpg', 'image', 'media/banner.jpg', 1, 'image/jpeg', 'ready', 1200, 400, NULL),
    ('media_logo', 'logo.png', 'image', 'media/logo.png', 1, 'image/png', 'ready', 400, 400, 400);
  INSERT INTO pages (id, title, slug, content, is_published) VALUES ('pg_about', 'About', 'about', '<p>x</p>', 1);
  INSERT INTO pages (id, title, slug, content, is_published) VALUES ('pg_refund', 'Refunds', 'refunds', '<p>r</p>', 1);
  INSERT INTO pages (id, title, slug, content, is_published, published_at) VALUES
    ('pg_soon', 'Soon', 'soon', '<p>s</p>', 1, ${FUTURE_PUBLISH_AT});
  INSERT INTO pages (id, content_type, title, slug, content, is_published) VALUES ('pg_post', 'article', 'Post', 'post', '<p>x</p>', 1);
  INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
    VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1),
           ('area_1', 'Banani', 'BD', 3, 'zone_1', '{}', '{}', 1);
  INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_ship', 'Standard', 6000, 'delivery', 'dz_bd');
  INSERT INTO analytics (id, name, type, is_active, use_partytown, config, location)
    VALUES ('an_1', 'Tag', 'custom', 1, 0, '<script>window.x=1</script>', 'head');
  INSERT INTO checkout_languages (id, name, code, language_data, field_visibility, is_active, is_default)
    VALUES ('cl_bn', 'Bangla', 'bn', '{}', '{}', 1, 1);
  ${document("business", {
    companyName: "Shop",
    socialLinks: [{ id: "fb", label: "Facebook", url: "https://facebook.com/shop" }, { id: "ig", label: "Instagram", url: "https://instagram.com/shop" }],
  })}
  ${document("policies", { refund: "pg_refund", privacy: "pg_soon" })}
  ${document("platform", {
    storefrontUrl: "https://shop.test",
    apiUrl: "https://api.shop.test",
    mediaUrl: "https://media.shop.test",
  })}
`;

/**
 * The published theme: the logo, an announcement, footer words, a hero slide,
 * category tiles (one draft category among them) and a product homepage.
 */
function seededTheme(): string {
  const theme = storefrontTemplateTheme("department-mall");
  theme.brand = { ...theme.brand, logo: "media_logo" };
  theme.blocks.topBar = { variant: "announcement", settings: { text: "Eid sale", link: "/collections/eid" } };
  theme.pages.homeMode = { kind: "product", productId: "p_linen" };
  theme.pages.home = theme.pages.home.map((section): StorefrontSection => {
    if (section.type === "hero") {
      return { ...section, settings: { ...section.settings, slides: [{ image: "media_hero", focalPoint: { x: 50, y: 50 }, alt: "Eid", link: "/" }] } };
    }
    if (section.type === "category-tiles") {
      return { ...section, settings: { ...section.settings, categoryIds: ["cat_panjabi", "cat_draft"] } };
    }
    return section;
  });
  return JSON.stringify(theme).replace(/'/g, "''");
}

/** Every public content and settings read of this slice. */
const ROUTES = [
  "/api/v1/storefront/layout",
  "/api/v1/storefront/homepage",
  "/api/v1/storefront/pages/slug/about",
  "/api/v1/storefront/pages/slug/soon",
  "/api/v1/checkout/config",
  "/api/v1/checkout-languages/active",
  "/api/v1/shipping-methods",
  "/api/v1/shipping-methods?cityId=city_1&zoneId=zone_1&areaId=area_1",
  "/api/v1/locations/cities",
  "/api/v1/locations/cities/summaries",
  "/api/v1/locations/zones?cityId=city_1",
  "/api/v1/locations/areas?zoneId=zone_1",
  "/api/v1/pages",
  "/api/v1/pages/slug/about",
  "/api/v1/pages/slug/missing",
  "/api/v1/pages/pg_about",
  "/api/v1/articles",
  "/api/v1/articles/slug/post",
  "/api/v1/seo",
  "/api/v1/navigation",
  "/api/v1/analytics/configurations",
  "/api/v1/platform",
];

/** Payloads buyers get that must carry no row revision or update time. */
const NO_INTERNAL_FIELD_ROUTES = [
  "/api/v1/checkout-languages/active",
  "/api/v1/shipping-methods",
];

/** CMS/article updatedAt is a tracked sitemap/dateModified value, never an editor revision. */
const NO_REVISION_ROUTES = [
  "/api/v1/pages",
  "/api/v1/pages/pg_about",
  "/api/v1/pages/slug/about",
  "/api/v1/storefront/pages/slug/about",
  "/api/v1/articles",
  "/api/v1/articles/slug/post",
];

let sqlite: DatabaseSync;
let db: Database;
let env: Env;
let menuIds: { header: string; footer: string };
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

async function seedNavigation(): Promise<{ header: string; footer: string }> {
  const header = await createNavigationMenu(db, { name: "Main menu" });
  await createNavigationMenuItem(db, header.id, {
    expectedRevision: 1,
    label: "Panjabi",
    labelMode: "resource",
    target: { type: "resource", resourceType: "category", resourceId: "cat_panjabi" },
  });
  await createNavigationMenuItem(db, header.id, {
    expectedRevision: 2,
    label: "Linen",
    labelMode: "resource",
    target: { type: "resource", resourceType: "product", resourceId: "p_linen" },
  });
  await publishNavigationMenu(db, header.id, { expectedRevision: 3 });
  await saveNavigationPlacement(db, {
    id: "placement_header",
    expectedRevision: 0,
    surface: "header",
    slot: "primary",
    position: 0,
    menuId: header.id,
  });
  const footer = await createNavigationMenu(db, { name: "Help" });
  await createNavigationMenuItem(db, footer.id, {
    expectedRevision: 1,
    label: "About",
    labelMode: "resource",
    target: { type: "resource", resourceType: "page", resourceId: "pg_about" },
  });
  await publishNavigationMenu(db, footer.id, { expectedRevision: 2 });
  await saveNavigationPlacement(db, {
    id: "placement_footer",
    expectedRevision: 0,
    surface: "footer",
    slot: "column",
    position: 0,
    menuId: footer.id,
  });
  return { header: header.id, footer: footer.id };
}

beforeAll(async () => {
  const harness = createSqliteD1Database();
  sqlite = harness.sqlite;
  db = harness.db;
  sqlite.exec(SEED);
  sqlite.exec(`INSERT INTO theme_settings (id, colors, revision) VALUES ('default', '${seededTheme()}', 1)`);
  await rebuildCatalogProjections(db);
  menuIds = await seedNavigation();
  env = {
    DB: harness.binding,
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    JWT_SECRET: "cache-deps-content-secret-0123456789abcdef",
    CREDENTIAL_ENCRYPTION_KEY: "cache-deps-content-credential-key-0123456789",
    // Deliberately different from the stored Platform document: a scoped
    // render must use the tracked row, never this entry-time value.
    STOREFRONT_URL: "https://stale-kv.test",
    R2_PUBLIC_URL: "https://stale-media.test",
    PLATFORM_CONFIG: { storefrontUrl: "https://stale-kv.test", apiUrl: "", dashboardUrl: "", mediaUrl: "https://stale-media.test" },
  } as unknown as Env;
});

afterAll(() => {
  sqlite?.close();
});

async function render(path: string, strict = true): Promise<{ status: number; body: string; dependencies: CacheDependencies }> {
  const { value, dependencies } = await withDependencyScope(async () => {
    const response = await fetchRuntimeApiApp(new Request(`https://api.internal${path}`), env, ctx);
    return { status: response.status, body: await response.text() };
  }, { strict, label: path.split("?")[0] });
  return { ...value, dependencies };
}

function internalFieldPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => internalFieldPaths(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === "revision" || key === "updatedAt" ? [`${path}.${key}`] : []),
    ...internalFieldPaths(child, `${path}.${key}`),
  ]);
}

describe("strict dependency coverage of public content and settings reads", () => {
  it("covers every table with precise keys, within the key budget and cacheable", async () => {
    const report: Record<string, number> = {};
    for (const route of ROUTES) {
      const { status, body, dependencies } = await render(route);
      expect([200, 404], `${route}: ${body.slice(0, 200)}`).toContain(status);
      expect(dependencies.coarseTables, route).toEqual([]);
      expect(dependencies.collapsedKinds, route).toEqual([]);
      expect(dependencies.uncacheable, route).toEqual([]);
      // The layout's store shape declares `t:product_content_blocks` on purpose
      // (storefront-theme.md, Store shape: block edits are rare merchant writes).
      expect(dependencies.keys.filter((key) => key.startsWith("t:") && key !== "t:product_content_blocks"), route).toEqual([]);
      expect(dependencies.keys.length, route).toBeLessThanOrEqual(CACHE_DEP_ENTRY_KEY_BUDGET);
      report[route] = dependencies.keys.length;
    }
    console.info("[CacheDeps] S3b key counts", JSON.stringify(report));
  }, 120_000);

  it("declares the layout's settings documents, content rows, brand images and the tracked Platform row", async () => {
    const { body, dependencies } = await render("/api/v1/storefront/layout");
    expect(dependencies.keys).toEqual(expect.arrayContaining([
      "set:business:document",
      "set:policies:document",
      "m:media_logo",
      "set:platform:document",
      "an",
      "theme",
      "lang",
      "lm:shape",
      "c:*",
      "col:*",
      "ship",
      "nav:*",
      "pg:pg_refund",
      "pg:pg_soon",
      "pg:pg_about",
      "c:cat_panjabi",
      "p:p_linen",
    ]));
    // The scheduled privacy page switches the policy list at its publish time.
    expect(dependencies.validUntil).toBe(FUTURE_PUBLISH_AT * 1000);
    expect(dependencies.keys).not.toContain("set:header:document");
    const layout = JSON.parse(body).data;
    expect(layout.platform.storefrontUrl).toBe("https://shop.test");
    expect(layout.policies.map((policy: { kind: string }) => policy.kind)).toEqual(["refund"]);
    expect(layout).not.toHaveProperty("header");
    expect(layout).not.toHaveProperty("footer");
    expect(layout.brand.logo).toMatchObject({ id: "media_logo", url: "https://media.shop.test/media/logo.png/400.webp" });
    expect(layout.brand.favicon).toBeNull();
    expect(layout.business.socialLinks.map((link: { id: string }) => link.id)).toEqual(["fb", "ig"]);
    expect(layout.theme.blocks.topBar.settings.text).toBe("Eid sale");
  });

  it("keeps the layout precise when the theme names no brand image", async () => {
    const stored = (sqlite.prepare("SELECT colors FROM theme_settings WHERE id = 'default'").get() as { colors: string }).colors;
    try {
      const theme = JSON.parse(stored);
      theme.brand.logo = null;
      sqlite.prepare("UPDATE theme_settings SET colors = ? WHERE id = 'default'").run(JSON.stringify(theme));
      const { body, dependencies } = await render("/api/v1/storefront/layout");
      expect(dependencies.coarseTables).toEqual([]);
      expect(dependencies.keys).toContain("m:none");
      expect(dependencies.keys).not.toContain("m:media_logo");
      expect(JSON.parse(body).data.brand.logo).toBeNull();
    } finally {
      sqlite.prepare("UPDATE theme_settings SET colors = ? WHERE id = 'default'").run(stored);
    }
  });

  it("reads the Platform settings from the tracked row only inside a scope", async () => {
    const scoped = await render("/api/v1/platform");
    expect(scoped.dependencies.keys).toContain("set:platform:document");
    expect(scoped.body).toContain("https://shop.test");
    expect(scoped.body).not.toContain("stale-kv.test");
    // Outside a scope (today's generation-keyed path) the entry-time env stands.
    const unscoped = await fetchRuntimeApiApp(new Request("https://api.internal/api/v1/storefront/layout"), env, ctx);
    expect((await unscoped.json() as { data: { platform: { storefrontUrl: string } } }).data.platform.storefrontUrl)
      .toBe("https://stale-kv.test");
  });

  it("declares the homepage's slide images, tile categories and home product from the theme alone", async () => {
    const { body, dependencies } = await render("/api/v1/storefront/homepage");
    expect(dependencies.keys).toEqual(expect.arrayContaining([
      "set:seo:document",
      "theme",
      "col:*",
      "c:cat_panjabi",
      "c:cat_draft",
      "p:p_linen",
      "m:media_hero",
    ]));
    expect(dependencies.keys.some((key) => key.startsWith("set:homepage") || key === "hero")).toBe(false);
    const home = JSON.parse(body).data;
    expect(home).not.toHaveProperty("hero");
    expect(home).not.toHaveProperty("presentation");
    expect(home.sections.homeProduct).toEqual({ id: "p_linen", slug: "linen-panjabi" });
    // Only the published category of the tiles shows; the draft one is a dependency.
    expect(home.sections.categories.map((category: { id: string }) => category.id)).toEqual(["cat_panjabi"]);
    // The slide's image is the published rendition of its media row.
    expect(home.sections.media.find((asset: { id: string }) => asset.id === "media_hero").url)
      .toBe("https://media.shop.test/media/hero.jpg/1600.webp");
  });

  it("advances the published theme's key, not a slide image's, when a published slide is edited", async () => {
    const seq = (dep: string) => (sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(dep) as { seq: number } | undefined)?.seq ?? 0;
    const before = { theme: seq("theme"), hero: seq("m:media_hero"), banner: seq("m:media_banner") };
    const stored = (sqlite.prepare("SELECT colors FROM theme_settings WHERE id = 'default'").get() as { colors: string }).colors;
    const theme = JSON.parse(stored);
    const hero = theme.pages.home.find((section: { type: string }) => section.type === "hero");
    hero.settings.slides[0] = { ...hero.settings.slides[0], image: "media_banner", heading: "Now 30% off" };
    sqlite.prepare("UPDATE theme_settings SET colors = ?, revision = revision + 1 WHERE id = 'default'").run(JSON.stringify(theme));
    expect(seq("theme")).toBeGreaterThan(before.theme);
    expect(seq("m:media_hero")).toBe(before.hero);
    expect(seq("m:media_banner")).toBe(before.banner);
    const { body, dependencies } = await render("/api/v1/storefront/homepage");
    expect(dependencies.keys).toContain("m:media_banner");
    expect(dependencies.keys).not.toContain("m:media_hero");
    expect(JSON.parse(body).data.sections.media.map((asset: { id: string }) => asset.id)).toContain("media_banner");
    // A change of the image itself advances its own key, which the homepage now declares.
    sqlite.exec("UPDATE media SET alt_text = 'Sale' WHERE id = 'media_banner'");
    expect(seq("m:media_banner")).toBeGreaterThan(before.banner);
    sqlite.prepare("UPDATE theme_settings SET colors = ? WHERE id = 'default'").run(stored);
  });

  it("bounds a missing CMS page by its scheduled publication and any page change", async () => {
    const soon = await render("/api/v1/storefront/pages/slug/soon");
    expect(soon.status).toBe(404);
    expect(soon.dependencies.keys).toContain("pg:*");
    expect(soon.dependencies.validUntil).toBe(FUTURE_PUBLISH_AT * 1000);
    const about = await render("/api/v1/storefront/pages/slug/about");
    expect(about.dependencies.keys).toContain("pg:pg_about");
    expect(about.dependencies.keys).not.toContain("pg:*");
  });

  it("declares the published menu of a menu read", async () => {
    const { status, dependencies } = await render(`/api/v1/navigation/${menuIds.header}`);
    expect(status).toBe(200);
    expect(dependencies.coarseTables).toEqual([]);
    expect(dependencies.keys).toContain(`nav:${menuIds.header}`);
  });
});

describe("public content payloads", () => {
  it("render byte-identical twice from the same data", async () => {
    for (const route of ["/api/v1/storefront/layout", "/api/v1/storefront/homepage"]) {
      const first = await render(route);
      const second = await render(route);
      expect(second.body, route).toBe(first.body);
    }
  });

  it("omit editor revisions and permit only tracked public update times", async () => {
    for (const route of NO_INTERNAL_FIELD_ROUTES) {
      const { status, body } = await render(route);
      expect(status, route).toBe(200);
      expect(internalFieldPaths(JSON.parse(body)), route).toEqual([]);
    }
    for (const route of NO_REVISION_ROUTES) {
      const { status, body } = await render(route);
      expect(status, route).toBe(200);
      expect(internalFieldPaths(JSON.parse(body)).filter((path) => path.endsWith(".revision")), route).toEqual([]);
      expect(internalFieldPaths(JSON.parse(body)).some((path) => path.endsWith(".updatedAt")), route).toBe(true);
    }
  });

  it("keeps CMS lastmod and its dependency unchanged on a no-op, then advances both for a published edit", async () => {
    const publishedAt = 1_700_000_000;
    sqlite.exec(`INSERT INTO pages (id, title, slug, content, is_published, revision, published_at, updated_at)
      VALUES ('pg_lastmod', 'Lastmod', 'lastmod', '<p>Before</p>', 1, 1, ${publishedAt}, ${publishedAt})`);
    const route = "/api/v1/pages/slug/lastmod";
    const seq = () => (sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = 'pg:pg_lastmod'").get() as { seq: number }).seq;
    const before = await render(route);
    const beforeSeq = seq();
    expect(before.status).toBe(200);
    expect(before.dependencies.keys).toContain("pg:pg_lastmod");
    expect(JSON.parse(before.body).data.page.updatedAt).toBe(new Date(publishedAt * 1000).toISOString());

    await updatePage(db, "pg_lastmod", { expectedRevision: 1, content: "<p>Before</p>" } as never);
    expect((await render(route)).body).toBe(before.body);
    expect(seq()).toBe(beforeSeq);

    await updatePage(db, "pg_lastmod", { expectedRevision: 2, content: "<p>After</p>" } as never);
    const after = await render(route);
    const page = JSON.parse(after.body).data.page;
    const saved = sqlite.prepare("SELECT updated_at FROM pages WHERE id = 'pg_lastmod'").get() as { updated_at: number };
    expect(page.publishedAt).toBe(new Date(publishedAt * 1000).toISOString());
    expect(page.updatedAt).toBe(new Date(saved.updated_at * 1000).toISOString());
    expect(saved.updated_at).toBeGreaterThan(publishedAt);
    expect(seq()).toBeGreaterThan(beforeSeq);
    expect(after.dependencies.keys).toContain("pg:pg_lastmod");
    expect(page).not.toHaveProperty("revision");
  });

});
