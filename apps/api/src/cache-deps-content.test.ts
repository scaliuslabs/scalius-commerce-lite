// Strict dependency coverage of the public content and settings reads
// (CACHE-DESIGN.md section 9, slice S3b): the layout, homepage, CMS pages,
// the cart shell (checkout config, checkout copy, shipping, locations), hero,
// SEO, header, footer and navigation. Each route renders in-process on the
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
    ('media_banner', 'banner.jpg', 'image', 'media/banner.jpg', 1, 'image/jpeg', 'ready', 1200, 400, NULL);
  INSERT INTO hero_sliders (id, type, images) VALUES
    ('hero_desktop', 'desktop', '[{"id":"s1","url":"https://media.shop.test/media/hero.jpg","title":"Eid","link":"/"}]');
  INSERT INTO pages (id, title, slug, content, is_published) VALUES ('pg_about', 'About', 'about', '<p>x</p>', 1);
  INSERT INTO pages (id, title, slug, content, is_published) VALUES ('pg_refund', 'Refunds', 'refunds', '<p>r</p>', 1);
  INSERT INTO pages (id, title, slug, content, is_published, published_at) VALUES
    ('pg_soon', 'Soon', 'soon', '<p>s</p>', 1, ${FUTURE_PUBLISH_AT});
  INSERT INTO pages (id, content_type, title, slug, content, is_published) VALUES ('pg_post', 'article', 'Post', 'post', '<p>x</p>', 1);
  INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
    VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1),
           ('area_1', 'Banani', 'area', 'zone_1', '{}', '{}', 1);
  INSERT INTO shipping_methods (id, name, fee_minor, kind) VALUES ('m_ship', 'Standard', 6000, 'delivery');
  INSERT INTO analytics (id, name, type, is_active, use_partytown, config, location)
    VALUES ('an_1', 'Tag', 'custom', 1, 0, '<script>window.x=1</script>', 'head');
  INSERT INTO checkout_languages (id, name, code, language_data, field_visibility, is_active, is_default)
    VALUES ('cl_bn', 'Bangla', 'bn', '{}', '{}', 1, 1);
  ${document("header", {
    topBar: { text: "Eid sale", isEnabled: true },
    logo: { src: "https://media.shop.test/logo.png", alt: "Shop" },
    social: [{ platform: "facebook", url: "https://facebook.com/shop" }, { platform: "instagram", url: "https://instagram.com/shop" }],
  })}
  ${document("footer", {
    tagline: "Since 2001",
    social: [{ platform: "facebook", url: "https://facebook.com/shop" }],
  })}
  ${document("policies", { refund: "pg_refund", privacy: "pg_soon" })}
  ${document("homepage", {
    categoryRail: { enabled: true, title: "Shop by category", categoryIds: ["cat_panjabi", "cat_draft"] },
    homeMode: "landing",
    landingProductId: "p_linen",
  })}
  ${document("platform", {
    storefrontUrl: "https://shop.test",
    apiUrl: "https://api.shop.test",
    mediaUrl: "https://media.shop.test",
  })}
`;

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
  "/api/v1/hero/sliders?type=desktop",
  "/api/v1/hero/sliders/hero_desktop",
  "/api/v1/seo",
  "/api/v1/header",
  "/api/v1/footer",
  "/api/v1/navigation",
  "/api/v1/analytics/configurations",
  "/api/v1/platform",
];

/** Payloads buyers get that must carry no row revision or update time. */
const NO_INTERNAL_FIELD_ROUTES = [
  "/api/v1/hero/sliders?type=desktop",
  "/api/v1/hero/sliders/hero_desktop",
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
      expect(dependencies.keys.filter((key) => key.startsWith("t:")), route).toEqual([]);
      expect(dependencies.keys.length, route).toBeLessThanOrEqual(CACHE_DEP_ENTRY_KEY_BUDGET);
      report[route] = dependencies.keys.length;
    }
    console.info("[CacheDeps] S3b key counts", JSON.stringify(report));
  }, 120_000);

  it("declares the layout's settings documents, content rows and the tracked Platform row", async () => {
    const { body, dependencies } = await render("/api/v1/storefront/layout");
    expect(dependencies.keys).toEqual(expect.arrayContaining([
      "set:header:document",
      "set:footer:document",
      "set:policies:document",
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
    const layout = JSON.parse(body).data;
    expect(layout.platform.storefrontUrl).toBe("https://shop.test");
    expect(layout.policies.map((policy: { kind: string }) => policy.kind)).toEqual(["refund"]);
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

  it("declares the homepage's hero, rail categories, landing product and media", async () => {
    const { body, dependencies } = await render("/api/v1/storefront/homepage");
    expect(dependencies.keys).toEqual(expect.arrayContaining([
      "set:homepage:document",
      "set:seo:document",
      "hero",
      "theme",
      "col:*",
      "c:cat_panjabi",
      "c:cat_draft",
      "p:p_linen",
      "m:media_hero",
    ]));
    const home = JSON.parse(body).data;
    expect(home.presentation.homeMode).toBe("landing");
    expect(home.presentation.categoryRail.categories.map((category: { id: string }) => category.id)).toEqual(["cat_panjabi"]);
    // The hero slide points at the published rendition of its media row.
    expect(home.hero.desktop.images[0].url).toBe("https://media.shop.test/media/hero.jpg/1600.webp");
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
    for (const route of ["/api/v1/storefront/layout", "/api/v1/header", "/api/v1/footer", "/api/v1/storefront/homepage"]) {
      const first = await render(route);
      const second = await render(route);
      expect(second.body, route).toBe(first.body);
    }
    const header = JSON.parse((await render("/api/v1/header")).body).data;
    expect(header.header.social.map((link: { id: string }) => link.id)).toEqual([
      expect.stringMatching(/^social_0_[a-z0-9]+$/),
      expect.stringMatching(/^social_1_[a-z0-9]+$/),
    ]);
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
