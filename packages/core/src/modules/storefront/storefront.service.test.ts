import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it, vi } from "vitest";
import {
  businessDocument,
  headerDocument,
  metaConversionsDocument,
  securityDocument,
  seoDocument,
} from "../settings/documents";
import { saveHomepagePresentationSettings } from "../settings/site-settings.service";
import { getHomepageData, getLayoutData } from "./storefront.service";

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
});

describe("storefront homepage data", () => {
  it("resolves only collections explicitly placed on the homepage", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`
      INSERT INTO products (id, name, price, slug) VALUES ('p_1', 'Visible', 10, 'visible');
      INSERT INTO product_variants (id, product_id, sku, price, stock, reserved_stock, is_default, track_inventory)
        VALUES ('v_1', 'p_1', 'VIS-1', 10, 0, 0, 1, 0);
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
      homepageTitle: "Welcome to Scalius Commerce",
      homepageMetaDescription: "Your one-stop shop for everything amazing.",
    });
    expect(unsaved.presentation.categoryRail.categories.map((category) => category.id)).toEqual(["cat_b", "cat_a"]);

    await seoDocument.write(db, { homepageTitle: "River & Loom" });
    expect((await getHomepageData(db)).seo).toEqual({
      homepageTitle: "River & Loom",
      homepageMetaDescription: "",
    });
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
