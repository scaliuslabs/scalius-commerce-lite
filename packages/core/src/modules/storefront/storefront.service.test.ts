import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it, vi } from "vitest";
import {
  businessDocument,
  metaConversionsDocument,
  securityDocument,
  seoDocument,
} from "../settings/documents";
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  STORE_SHAPE_COUNT_CAP,
  STOREFRONT_SECTION_REGISTRY,
  homeSectionRequests,
  storefrontTemplateTheme,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getHomepageData, getLayoutData } from "./storefront.service";
import { readStoreShape } from "./store-shape";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { refreshProductSalesStats } from "../catalog/recommendation-refresh";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("storefront layout data", () => {
  it("enables Meta CAPI browser dispatch only after a strict credential read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = createSqliteD1Database();
    await metaConversionsDocument.write(db, {
      pixelId: "123456",
      accessToken: "token-value",
      isEnabled: true,
    }, { encryptionKey: KEY });

    expect((await getLayoutData(db, { credentialEncryptionKey: KEY })).metaCapi).toEqual({ browserEventsEnabled: true });
    expect((await getLayoutData(db, { credentialEncryptionKey: OTHER_KEY })).metaCapi).toEqual({ browserEventsEnabled: false });
    expect((await getLayoutData(db)).metaCapi).toEqual({ browserEventsEnabled: false });
  });

  it("reads no Meta access token while the pixel is off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db } = createSqliteD1Database();
    await metaConversionsDocument.write(db, {
      pixelId: "123456",
      accessToken: "token-value",
      isEnabled: false,
    }, { encryptionKey: KEY });
    warn.mockClear();

    // A key that cannot read the token: a disabled pixel never tries to.
    expect((await getLayoutData(db, { credentialEncryptionKey: OTHER_KEY })).metaCapi).toEqual({ browserEventsEnabled: false });
    expect(warn.mock.calls.filter(([message]) => String(message).includes("meta_conversions"))).toEqual([]);
    warn.mockRestore();
  });

  it("normalizes an unsupported saved currency to the platform default", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO settings (id, key, value, category, type)
      VALUES ('set_currency', 'document', '{"currencyCode":"ZZZ"}', 'currency', 'json')`);

    const layout = await getLayoutData(db);
    const fallback = await getLayoutData(createSqliteD1Database().db);
    expect(layout.currency.code).toBe(fallback.currency.code);
    expect(layout.currency.code).not.toBe("ZZZ");
  });

  // Regression: the payload had no decimalPlaces, so the storefront formatted
  // JPY with two decimals and UCP scaled its amounts by 100.
  it.each([
    ["JPY", "¥", 0],
    ["KWD", "KD", 3],
    ["BDT", "৳", 2],
  ])("carries the ISO 4217 decimal places of %s and the store's price increment", async (code, symbol, decimalPlaces) => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO settings (id, key, value, category, type)
      VALUES ('set_currency', 'document', '${JSON.stringify({ currencyCode: code, currencySymbol: symbol })}', 'currency', 'json')`);

    // A BDT store prices in whole taka by default; every other currency in its minor unit.
    const priceIncrementMinor = code === "BDT" ? 100 : 1;
    expect((await getLayoutData(db)).currency).toEqual({ code, symbol, decimalPlaces, priceIncrementMinor });
  });

  it("renders the published theme whole, or the default whole when the row is unreadable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const themeWarnings = () => warn.mock.calls.filter(([message]) => String(message).includes("theme"));
    const { sqlite, db } = createSqliteD1Database();
    expect((await getLayoutData(db)).theme).toEqual(DEFAULT_STOREFRONT_THEME);

    const boutique = storefrontTemplateTheme("boutique");
    sqlite.prepare(`INSERT INTO theme_settings (id, colors, revision, created_at, updated_at)
      VALUES ('default', ?, 1, 1, 1)`).run(JSON.stringify(boutique));
    expect((await getLayoutData(db)).theme).toEqual(boutique);
    expect(themeWarnings()).toHaveLength(0);

    const lowContrast = structuredClone(boutique);
    lowContrast.tokens.colors.foreground = lowContrast.tokens.colors.background;
    sqlite.prepare("UPDATE theme_settings SET colors = ?").run(JSON.stringify(lowContrast));
    expect((await getLayoutData(db)).theme).toEqual(DEFAULT_STOREFRONT_THEME);
    expect(themeWarnings()).toHaveLength(1);
    warn.mockRestore();
  });

  it("serves the store shape from the same batch, with counts capped and the same facts the dashboard reads", async () => {
    let batches = 0;
    const { sqlite, db } = createSqliteD1Database({ beforeBatch: () => { batches += 1; } });
    expect((await getLayoutData(db)).storeShape).toEqual(EMPTY_STORE_SHAPE);
    expect(batches).toBe(1);

    sqlite.exec(`
      INSERT INTO categories (id, name, slug, status) VALUES
        ('c_1', 'Sarees', 'sarees', 'published'), ('c_2', 'Panjabi', 'panjabi', 'published'), ('c_3', 'Draft', 'draft', 'draft');
      INSERT INTO products (id, name, price_minor, slug, is_active, category_id) VALUES
        ('p_1', 'One', 1000, 'one', 1, 'c_1'), ('p_2', 'Two', 1000, 'two', 1, 'c_2'), ('p_3', 'Three', 1000, 'three', 1, 'c_3'),
        ('p_off', 'Off', 1000, 'off', 0, 'c_1');
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
        ('v_1', 'p_1', 'ONE', 1000, 1, 0, 1, 1), ('v_2', 'p_2', 'TWO', 1000, 1, 0, 1, 1),
        ('v_off', 'p_off', 'OFF', 1000, 1, 0, 1, 1);
      INSERT INTO collections (id, name, presentation, config) VALUES ('col_1', 'Best', 'grid', '{}');
    `);
    await rebuildCatalogProjections(db);
    const shape = (await getLayoutData(db)).storeShape;
    expect(shape).toMatchObject({
      productCount: 3,
      skuCount: 2,
      topCategoryCount: 2,
      categoryDepth: 1,
      hasCollections: true,
      hasDeliveryMethods: false,
    });
    await expect(readStoreShape(db)).resolves.toEqual(shape);

    // A big catalogue costs no more than the cap.
    sqlite.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${STORE_SHAPE_COUNT_CAP + 5})
      INSERT INTO products (id, name, price_minor, slug) SELECT 'bulk_' || i, 'Bulk', 100, 'bulk-' || i FROM n;
    `);
    expect((await getLayoutData(db)).storeShape.productCount).toBe(STORE_SHAPE_COUNT_CAP);
  });
});

/** Publish a theme with these homepage sections (and home mode) as the stored row. */
function publishTheme(sqlite: DatabaseSync, home: StorefrontSection[], homeMode: StorefrontThemeDocument["pages"]["homeMode"] = { kind: "sections" }, edit?: (theme: StorefrontThemeDocument) => void) {
  const theme = storefrontTemplateTheme("boutique");
  theme.pages = { ...theme.pages, home, homeMode };
  edit?.(theme);
  sqlite.prepare("DELETE FROM theme_settings").run();
  sqlite.prepare(`INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)`)
    .run(JSON.stringify(theme));
  return theme;
}

const section = (value: object) => ({ version: 1, ...value }) as StorefrontSection;

describe("storefront homepage data", () => {
  it("reads the collections section's collections in its order: active ones with products", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`
      INSERT INTO products (id, name, price_minor, slug) VALUES ('p_1', 'Visible', 1000, 'visible');
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
        VALUES ('v_1', 'p_1', 'VIS-1', 1000, 0, 0, 1, 0);
      INSERT INTO collections (id, name, presentation, config, sort_order, is_active) VALUES
        ('col_a', 'A', 'grid', '{"source":"manual","productIds":["p_1"]}', 0, 1),
        ('col_b', 'B', 'grid', '{"source":"manual","productIds":["p_1"]}', 1, 1),
        ('col_off', 'Off', 'grid', '{"source":"manual","productIds":["p_1"]}', 2, 0),
        ('col_empty', 'Empty', 'grid', '{"source":"manual","productIds":[]}', 3, 1);
    `);
    await rebuildCatalogProjections(db);
    publishTheme(sqlite, [section({ id: "c", type: "collections", settings: { carousel: "large", collectionIds: ["col_b", "col_off", "col_empty", "col_a"] } })]);

    const homepage = await getHomepageData(db);
    expect(homepage.sections.collections.map((collection) => collection.id)).toEqual(["col_b", "col_a"]);
  });

  it("reads no collection products when no collections section names one", async () => {
    let batches = 0;
    const { sqlite, db } = createSqliteD1Database({ beforeBatch: () => { batches += 1; } });
    sqlite.exec(`
      INSERT INTO products (id, name, price_minor, slug) VALUES ('p_1', 'Visible', 1000, 'visible');
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
        VALUES ('v_1', 'p_1', 'VIS-1', 1000, 0, 0, 1, 0);
      INSERT INTO collections (id, name, presentation, config)
        VALUES ('col_home', 'Home', 'grid', '{"source":"manual","productIds":["p_1"]}');
    `);
    await rebuildCatalogProjections(db);
    publishTheme(sqlite, [section({ id: "text", type: "editorial", settings: { layout: "rich-text", heading: "Hi", body: "" } })]);
    batches = 0;

    expect((await getHomepageData(db)).sections.collections).toEqual([]);
    expect(batches).toBe(1);

    publishTheme(sqlite, [section({ id: "collections", type: "collections", settings: { ...STOREFRONT_SECTION_REGISTRY.collections.defaults, collectionIds: ["col_home"] } })]);
    batches = 0;
    expect((await getHomepageData(db)).sections.collections.map((collection) => collection.id)).toEqual(["col_home"]);
    expect(batches).toBe(2);
  });

  it("reads the category tiles' published categories in the section's order, and the SEO document", async () => {
    const { db, sqlite } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO categories (id, name, slug, status) VALUES
      ('cat_a', 'Tea', 'tea', 'published'),
      ('cat_b', 'Coffee', 'coffee', 'published'),
      ('cat_draft', 'Hidden', 'hidden', 'draft')`);
    publishTheme(sqlite, [section({ id: "tiles", type: "category-tiles", settings: { style: "round", title: "Shop", categoryIds: ["cat_b", "cat_draft", "cat_a"] } })]);

    const unsaved = await getHomepageData(db);
    expect(unsaved.seo).toEqual({
      homepageTitle: null,
      homepageMetaDescription: null,
    });
    expect(unsaved.sections.categories.map((category) => category.id)).toEqual(["cat_b", "cat_a"]);

    await seoDocument.write(db, { homepageTitle: "River & Loom" });
    expect((await getHomepageData(db)).seo).toEqual({
      homepageTitle: "River & Loom",
      homepageMetaDescription: null,
    });
  });

  it("reads a product homepage's product only while it is public, in the same second batch", async () => {
    let batches = 0;
    const { db, sqlite } = createSqliteD1Database({ beforeBatch: () => { batches += 1; } });
    sqlite.exec(`
      INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('p_honey', 'Honey', 90000, 'sundarbans-honey', 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
        VALUES ('v_honey', 'p_honey', 'HONEY', 90000, 5, 0, 1, 1);
    `);
    await rebuildCatalogProjections(db);
    const rail = section({ id: "new", type: "product-rail", settings: { title: "", source: { kind: "newest" }, limit: 4 } });
    publishTheme(sqlite, [rail]);
    batches = 0;
    expect((await getHomepageData(db)).sections.homeProduct).toBeNull();
    const sectionBatches = batches;

    publishTheme(sqlite, [rail], { kind: "product", productId: "p_honey" });
    batches = 0;
    expect((await getHomepageData(db)).sections.homeProduct).toEqual({ id: "p_honey", slug: "sundarbans-honey" });
    expect(batches).toBe(sectionBatches);

    // A product that stops being public leaves `/` on the sections.
    sqlite.exec("UPDATE products SET is_active = 0 WHERE id = 'p_honey'");
    await rebuildCatalogProjections(db);
    expect((await getHomepageData(db)).sections.homeProduct).toBeNull();
  });

  it("reads the published theme's section lists and images in two batches", async () => {
    let batches = 0;
    let statements = 0;
    const { db, sqlite } = createSqliteD1Database({ beforeBatch: () => { batches += 1; } , onQuery: () => { statements += 1; } });
    const now = Math.floor(Date.now() / 1000);
    sqlite.exec(`
      INSERT INTO categories (id, name, slug, status, canonical_path) VALUES
        ('cat_tea', 'Tea', 'tea', 'published', NULL), ('cat_draft', 'Draft', 'draft', 'draft', NULL);
      INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at, discount_type, discount_bps) VALUES
        ('p_old', 'Old tea', 1000, 'old-tea', 'cat_tea', 1, ${now - 300}, 'percentage', 1000),
        ('p_mid', 'Mid tea', 1000, 'mid-tea', 'cat_tea', 1, ${now - 200}, NULL, 0),
        ('p_new', 'New tea', 1000, 'new-tea', 'cat_draft', 1, ${now - 100}, NULL, 0),
        ('p_off', 'Hidden', 1000, 'hidden', 'cat_tea', 0, ${now}, NULL, 0);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
        ('v_old', 'p_old', 'OLD', 1000, 5, 0, 1, 1), ('v_mid', 'p_mid', 'MID', 1000, 5, 0, 1, 1),
        ('v_new', 'p_new', 'NEW', 1000, 5, 0, 1, 1), ('v_off', 'p_off', 'OFF', 1000, 5, 0, 1, 1);
      INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, width, height, alt_text) VALUES
        ('m_mid', 'mid.webp', 'image', 'media/mid.webp', 1, 'image/webp', 'ready', 800, 800, NULL),
        ('m_banner', 'banner.webp', 'image', 'media/banner.webp', 1, 'image/webp', 'ready', 1600, 600, 'Tea harvest'),
        ('m_gone', 'clip.mp4', 'video', 'media/clip.mp4', 1, 'video/mp4', 'ready', 10, 10, NULL);
      INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_mid01', 'p_mid', 'm_mid', 1, 0);
      INSERT INTO collections (id, name, presentation, config) VALUES
        ('col_teas', 'Teas', 'carousel', '{"source":"manual","productIds":["p_mid","p_old"],"title":"Our teas"}');
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at) VALUES
        ('o_1', 'A', '01700000001', 'x', 'city', 'zone', 'delivered', ${now - 60}, ${now - 60}),
        ('o_2', 'B', '01700000002', 'x', 'city', 'zone', 'pending', ${now - 60}, ${now - 60}),
        ('o_3', 'C', '01700000003', 'x', 'city', 'zone', 'cancelled', ${now - 60}, ${now - 60});
    `);
    publishTheme(sqlite, [
      section({ id: "new", type: "product-rail", settings: { title: "", source: { kind: "newest" }, limit: 4 } }),
      section({ id: "sale", type: "deal-block", settings: { title: "", source: { kind: "on-sale" } } }),
      section({ id: "cat", type: "product-grid", settings: { title: "", source: { kind: "category", categoryId: "cat_tea" }, columns: 2, rows: 1 } }),
      section({ id: "draft", type: "product-grid", settings: { title: "", source: { kind: "category", categoryId: "cat_draft" }, columns: 2, rows: 1 } }),
      section({ id: "col", type: "product-rail", settings: { title: "", source: { kind: "collection", collectionId: "col_teas" }, limit: 4 } }),
      section({ id: "pop", type: "product-rail", settings: { title: "", source: { kind: "popular" }, limit: 4 } }),
      section({ id: "banner", type: "banner", settings: { layout: "full", heading: "", text: "", mediaId: "m_banner", cta: null } }),
      section({ id: "gone", type: "banner", settings: { layout: "full", heading: "", text: "", mediaId: "m_gone", cta: null } }),
    ]);
    sqlite.exec(`
      INSERT INTO order_items (id, order_id, product_id, quantity) VALUES
        ('oi_1', 'o_1', 'p_old', 1), ('oi_2', 'o_2', 'p_old', 1), ('oi_3', 'o_3', 'p_mid', 1);
    `);
    // Seeded with raw SQL: fill the projections and sales stats as the release and nightly run do.
    await rebuildCatalogProjections(db);
    await refreshProductSalesStats(db);

    batches = 0;
    const homepage = await getHomepageData(db);
    expect(batches).toBe(2);
    const list = (key: string) => homepage.sections.lists.find((each) => each.key === key);
    const ids = (key: string) => list(key)?.products.map((product) => product.id);
    expect(ids("newest")).toEqual(["p_new", "p_mid", "p_old"]);
    expect(list("newest")?.products[1]).toMatchObject({ imageUrl: expect.stringContaining("media/mid.webp") });
    expect(ids("on-sale")).toEqual(["p_old"]);
    expect(ids("category:cat_tea")).toEqual(["p_mid", "p_old"]);
    expect(list("category:cat_tea")?.category).toMatchObject({ name: "Tea", slug: "tea" });
    // A draft category shows nothing (and says nothing about itself).
    expect(list("category:cat_draft")).toMatchObject({ products: [], category: null });
    expect(ids("collection:col_teas")).toEqual(["p_mid", "p_old"]);
    expect(list("collection:col_teas")?.collection).toEqual({ id: "col_teas", title: "Our teas" });
    // Two distinct buyers in real orders; the cancelled order does not count.
    expect(ids("popular")).toEqual(["p_old"]);
    expect(homepage.sections.media).toEqual([
      { id: "m_banner", url: expect.stringContaining("media/banner.webp"), alt: "Tea harvest", width: 1600, height: 600 },
    ]);

    // A preview names its own reads instead of the published theme's.
    const preview = await getHomepageData(db, {
      requests: {
        lists: [{ key: "newest", source: { kind: "newest" }, limit: 1 }],
        mediaIds: [],
        categoryIds: ["cat_tea"],
        collectionIds: [],
        brandLimit: 0,
        promotionIds: [],
        homeProductId: null,
      },
    });
    expect(preview.sections.lists.map((each) => [each.key, each.products.map((product) => product.id)]))
      .toEqual([["newest", ["p_new"]]]);
    expect(preview.sections.media).toEqual([]);
    expect(preview.sections.categories.map((category) => category.id)).toEqual(["cat_tea"]);
    expect(statements).toBeGreaterThan(0);
  });

  it("bounds explicit preview collection metadata to the requested IDs", async () => {
    const reads: Array<{ query: string; ids: readonly SQLInputValue[] }> = [];
    const { db, sqlite } = createSqliteD1Database({ onQuery: (query, ids) => { reads.push({ query, ids }); } });
    try {
      sqlite.exec(`INSERT INTO collections (id, name, presentation, config) VALUES
        ('col_wanted', 'Wanted', 'grid', '{}'), ('col_unrelated', 'Unrelated', 'grid', '{}')`);
      const requested = homeSectionRequests([section({ id: "c", type: "collections", settings: {
        ...STOREFRONT_SECTION_REGISTRY.collections.defaults, collectionIds: ["col_wanted"],
      } })]);
      reads.length = 0;
      await getHomepageData(db, { requests: requested });
      const metadata = reads.find(({ query }) => /from "collections"/i.test(query));
      expect(metadata).toBeDefined();
      expect(metadata!.query).toMatch(/"collections"\."id" in/i);
      expect(metadata!.ids).toContain("col_wanted");
      expect(metadata!.ids).not.toContain("col_unrelated");
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${metadata!.query}`).all(...metadata!.ids);
      expect(JSON.stringify(plan)).toMatch(/SEARCH collections USING INDEX .*\(id=\?\)/);
      reads.length = 0;
      await getHomepageData(db, { requests: homeSectionRequests([]) });
      expect(reads.find(({ query }) => /from "collections"/i.test(query))!.query).toMatch(/false/i);
    } finally { sqlite.close(); }
  });

  it("propagates preview app failures but keeps public-page graceful omission", async () => {
    const { db, sqlite } = createSqliteD1Database();
    const app = section({ id: "app", type: "app", settings: { app: "acme.reviews/latest", values: {} } });
    try {
      const renderApps = vi.fn(async () => { throw new Error("dependency failed"); });
      await expect(getHomepageData(db, { requests: homeSectionRequests([app]), renderApps }))
        .rejects.toThrow("Preview app render failed");
      publishTheme(sqlite, [app]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try { expect((await getHomepageData(db, { renderApps })).sections.apps).toEqual([]); }
      finally { warn.mockRestore(); }
    } finally { sqlite.close(); }
  });

  it("reads nothing in a second batch when no section needs data", async () => {
    let batches = 0;
    const { db, sqlite } = createSqliteD1Database({ beforeBatch: () => { batches += 1; } });
    publishTheme(sqlite, [section({ id: "text", type: "editorial", settings: { layout: "rich-text", heading: "Hi", body: "" } })]);
    const homepage = await getHomepageData(db);
    expect(batches).toBe(1);
    expect(homepage.sections).toEqual({ lists: [], media: [], brands: [], promotions: [], categories: [], collections: [], homeProduct: null, apps: [] });
  });

  it("reads hero slide images by media id, at their published rendition, phone images too", async () => {
    const { db, sqlite } = createSqliteD1Database();
    sqlite.exec(`
      INSERT INTO media (id, filename, kind, object_key, size, mime_type, variant_width) VALUES
        ('m_a', 'a.webp', 'image', 'media/hero_a.webp', 64000, 'image/webp', 1080),
        ('m_b', 'b.jpg', 'image', 'media/hero_b.jpg', 64000, 'image/jpeg', NULL),
        ('m_phone', 'p.webp', 'image', 'media/hero_p.webp', 64000, 'image/webp', 960);
    `);
    publishTheme(sqlite, [section({ id: "hero", type: "hero", settings: { layout: "full-bleed", slides: [
      { image: "m_a", phoneImage: "m_phone", focalPoint: { x: 50, y: 50 }, alt: "A", link: null },
      { image: "m_b", focalPoint: { x: 20, y: 80 }, alt: "B", link: "/sale" },
    ] } })]);

    const { sections } = await getHomepageData(db);
    expect(sections.media.map((asset) => [asset.id, asset.url])).toEqual([
      // Renditions exist: the storefront derives srcset and a small preload.
      ["m_a", expect.stringMatching(/media\/hero_a\.webp\/1080\.webp$/)],
      ["m_phone", expect.stringMatching(/media\/hero_p\.webp\/960\.webp$/)],
      // No renditions yet: the original stays.
      ["m_b", expect.stringMatching(/media\/hero_b\.jpg$/)],
    ]);
  });
});

describe("storefront layout settings projection", () => {
  it("serves identity from the business document and brand images from the published theme", async () => {
    const { db, sqlite } = createSqliteD1Database();
    const empty = await getLayoutData(db);
    expect(empty).not.toHaveProperty("header");
    expect(empty).not.toHaveProperty("footer");
    expect(empty.brand).toEqual({ logo: null, footerLogo: null, favicon: null });
    expect(empty.footerMenus).toEqual([]);

    sqlite.exec(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, variant_width, alt_text) VALUES
      ('m_logo', 'logo.png', 'image', 'media/logo.png', 1, 'image/png', 320, 'Shop logo')`);
    publishTheme(sqlite, [], { kind: "sections" }, (theme) => {
      theme.brand = { ...theme.brand, logo: "m_logo", favicon: "m_missing" };
    });
    await businessDocument.write(db, {
      companyName: "Shop Ltd",
      invoicePrefix: "SL",
      socialLinks: [{ id: "fb", label: "Facebook", url: "https://facebook.com/shop" }],
    });
    await securityDocument.write(db, { cspAllowedDomains: "https://analytics.example.com" });

    const layout = await getLayoutData(db);
    expect(layout.brand.logo).toMatchObject({ id: "m_logo", alt: "Shop logo", url: expect.stringMatching(/media\/logo\.png\/320\.webp$/) });
    expect(layout.brand.favicon).toBeNull();
    expect(layout.business).toMatchObject({ companyName: "Shop Ltd", country: "Bangladesh", socialLinks: [{ id: "fb", url: "https://facebook.com/shop" }] });
    expect(layout.business).not.toHaveProperty("invoicePrefix");
    expect(layout.cspAllowedDomains).toBe("https://analytics.example.com");

    // An unreadable stored theme renders the default whole: no brand images.
    sqlite.prepare("UPDATE theme_settings SET colors = ?").run(JSON.stringify({ version: 6, brand: { logo: "m_logo" } }));
    expect((await getLayoutData(db)).brand.logo).toBeNull();
  });
});
