import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it, vi } from "vitest";
import {
  businessDocument,
  headerDocument,
  metaConversionsDocument,
  securityDocument,
  seoDocument,
} from "../settings/documents";
import { DEFAULT_STOREFRONT_THEME, EMPTY_STORE_SHAPE, STORE_SHAPE_COUNT_CAP, storefrontTemplateTheme } from "@scalius/shared/storefront-theme";
import { saveHomepagePresentationSettings } from "../settings/site-settings.service";
import { getHomepageData, getLayoutData } from "./storefront.service";
import { readStoreShape } from "./store-shape";

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

  it("normalizes an unsupported saved currency to the platform default", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO settings (id, key, value, category, type)
      VALUES ('set_currency', 'document', '{"currencyCode":"ZZZ"}', 'currency', 'json')`);

    const layout = await getLayoutData(db);
    const fallback = await getLayoutData(createSqliteD1Database().db);
    expect(layout.currency.code).toBe(fallback.currency.code);
    expect(layout.currency.code).not.toBe("ZZZ");
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
      INSERT INTO products (id, name, price_minor, slug, is_active) VALUES
        ('p_1', 'One', 1000, 'one', 1), ('p_2', 'Two', 1000, 'two', 1), ('p_3', 'Three', 1000, 'three', 1),
        ('p_off', 'Off', 1000, 'off', 0);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
        ('v_1', 'p_1', 'ONE', 1000, 1, 0, 1, 1), ('v_2', 'p_2', 'TWO', 1000, 1, 0, 1, 1),
        ('v_off', 'p_off', 'OFF', 1000, 1, 0, 1, 1);
      INSERT INTO collections (id, name, presentation, config) VALUES ('col_1', 'Best', 'grid', '{}');
    `);
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

describe("storefront homepage data", () => {
  it("resolves only collections explicitly placed on the homepage", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`
      INSERT INTO products (id, name, price_minor, slug) VALUES ('p_1', 'Visible', 1000, 'visible');
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
        VALUES ('v_1', 'p_1', 'VIS-1', 1000, 0, 0, 1, 0);
      INSERT INTO collections (id, name, presentation, config, sort_order) VALUES
        ('col_home', 'Home', 'grid', '{"source":"manual","productIds":["p_1"],"showOnHomepage":true}', 0),
        ('col_hidden', 'Hidden', 'grid', '{"source":"manual","productIds":["p_1"],"showOnHomepage":false}', 1);
    `);

    const homepage = await getHomepageData(db);
    expect(homepage.collections.map((collection) => collection?.id)).toEqual(["col_home"]);
  });

  it("projects the saved category rail and SEO documents in the homepage batch", async () => {
    const { db, sqlite } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO categories (id, name, slug, status) VALUES
      ('cat_a', 'Tea', 'tea', 'published'),
      ('cat_b', 'Coffee', 'coffee', 'published'),
      ('cat_draft', 'Hidden', 'hidden', 'draft')`);
    await saveHomepagePresentationSettings(db, {
      categoryRail: { enabled: true, title: "Shop", categoryIds: ["cat_b", "cat_draft", "cat_a"] },
      trustStrip: { enabled: false },
    }, 0);

    const unsaved = await getHomepageData(db);
    expect(unsaved.seo).toEqual({
      homepageTitle: null,
      homepageMetaDescription: null,
    });
    expect(unsaved.presentation.categoryRail.categories.map((category) => category.id)).toEqual(["cat_b", "cat_a"]);

    await seoDocument.write(db, { homepageTitle: "River & Loom" });
    expect((await getHomepageData(db)).seo).toEqual({
      homepageTitle: "River & Loom",
      homepageMetaDescription: null,
    });
  });

  it("points hero slides saved with an original upload at its published rendition (R3-MOB-01)", async () => {
    const { db, sqlite } = createSqliteD1Database();
    const slide = (id: string, url: string) => ({ id, url, title: `Banner ${id}`, link: "" });
    sqlite.exec(`
      INSERT INTO media (id, filename, kind, object_key, size, mime_type, variant_width) VALUES
        ('m_a', 'a.webp', 'image', 'media/hero_a.webp', 64000, 'image/webp', 1080),
        ('m_b', 'b.jpg', 'image', 'media/hero_b.jpg', 64000, 'image/jpeg', NULL);
      INSERT INTO hero_sliders (id, type, images) VALUES
        ('hero_d', 'desktop', '${JSON.stringify([
          slide("a", "https://cdn.example.test/media/hero_a.webp"),
          slide("b", "https://cdn.example.test/media/hero_b.jpg"),
        ])}'),
        ('hero_m', 'mobile', '${JSON.stringify([
          slide("c", "https://cdn.example.test/media/hero_c.webp/960.webp"),
          slide("a2", "https://cdn.example.test/media/hero_a.webp"),
        ])}');
    `);

    const { hero } = await getHomepageData(db);
    expect(hero.desktop?.images.map((image) => image.url)).toEqual([
      // Renditions exist: the storefront can now derive srcset and a small preload.
      "https://cdn.example.test/media/hero_a.webp/1080.webp",
      // No renditions yet: the original stays.
      "https://cdn.example.test/media/hero_b.jpg",
    ]);
    expect(hero.mobile?.images.map((image) => image.url)).toEqual([
      "https://cdn.example.test/media/hero_c.webp/960.webp",
      "https://cdn.example.test/media/hero_a.webp/1080.webp",
    ]);
  });
});

describe("storefront layout settings projection", () => {
  it("uses the configured header branch only once a header document is saved", async () => {
    const { db } = createSqliteD1Database();
    expect((await getLayoutData(db)).header).toMatchObject({
      topBar: { isEnabled: false },
      contact: { isEnabled: false },
    });

    await headerDocument.write(db, { logo: { src: "media/logo.png", alt: "Shop" } });
    await businessDocument.write(db, { companyName: "Shop Ltd", invoicePrefix: "SL" });
    await securityDocument.write(db, { cspAllowedDomains: "https://analytics.example.com" });

    const layout = await getLayoutData(db);
    expect(layout.header).toMatchObject({
      topBar: { isEnabled: true },
      logo: { src: "media/logo.png", alt: "Shop" },
      contact: { isEnabled: true },
    });
    expect(layout.business).toMatchObject({ companyName: "Shop Ltd", country: "Bangladesh" });
    expect(layout.business).not.toHaveProperty("invoicePrefix");
    expect(layout.cspAllowedDomains).toBe("https://analytics.example.com");
  });
});
