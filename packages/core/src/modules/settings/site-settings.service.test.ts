import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { DEFAULT_SEO_DISCOVERY_SETTINGS } from "@scalius/shared/seo-discovery";

import { DEFAULT_STOREFRONT_THEME, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";

import {
  getCurrencySettings,
  getSeoSettings,
  saveCurrencySettings,
  saveSeoSettings,
  saveThemeDraft,
} from "./site-settings.service";
import { getBusinessSettings, saveBusinessSettings } from "./business-settings.service";
import { getCurrencyConfig } from "./settings.service";

function storeDocument(sqlite: ReturnType<typeof createSqliteD1Database>["sqlite"], category: string, value: string) {
  sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES (?, 'document', ?, 'json', ?)")
    .run(`${category}_doc`, value, category);
}

function documentCount(sqlite: ReturnType<typeof createSqliteD1Database>["sqlite"], category: string): number {
  return Number((sqlite.prepare("SELECT count(*) AS count FROM settings WHERE category = ?").get(category) as { count: number }).count);
}

/** The default theme with a logo, one hero slide and a product homepage. */
function themeNaming(ids: { logo?: string; slide?: string; product?: string; link?: string | null }): StorefrontThemeDocument {
  const theme = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
  theme.brand = { ...theme.brand, logo: ids.logo ?? null };
  if (ids.product) theme.pages.homeMode = { kind: "product", productId: ids.product };
  theme.pages.home = theme.pages.home.map((section) => section.type === "hero" && ids.slide
    ? { ...section, settings: { ...section.settings, slides: [{ image: ids.slide, focalPoint: { x: 50, y: 50 }, alt: "Eid", link: ids.link ?? null }] } }
    : section);
  return theme;
}

function seedFiles(sqlite: ReturnType<typeof createSqliteD1Database>["sqlite"]) {
  sqlite.exec(`
    INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, trashed_at, deleted_at) VALUES
      ('media_logo', 'logo.png', 'image', 'media/logo.png', 1, 'image/png', 'ready', NULL, NULL),
      ('media_old', 'old.png', 'image', 'media/old.png', 1, 'image/png', 'trashed', unixepoch(), NULL),
      ('media_gone', 'gone.png', 'image', 'media/gone.png', 1, 'image/png', 'deleted', unixepoch(), unixepoch()),
      ('media_clip', 'clip.mp4', 'video', 'media/clip.mp4', 1, 'video/mp4', 'ready', NULL, NULL);
    INSERT INTO products (id, name, price_minor, slug) VALUES ('prod_live', 'Live', 1000, 'live'), ('prod_trash', 'Trash', 1000, 'trash');
    UPDATE products SET deleted_at = unixepoch() WHERE id = 'prod_trash';
  `);
}

describe("theme draft references", () => {
  const heroIndex = DEFAULT_STOREFRONT_THEME.pages.home.findIndex((section) => section.type === "hero");

  it("saves a draft whose images are images in Files (trashed ones keep serving) and whose home product exists", async () => {
    const { db, sqlite } = createSqliteD1Database();
    seedFiles(sqlite);
    const draft = await saveThemeDraft(db, themeNaming({ logo: "media_logo", slide: "media_old", product: "prod_live" }), 0, 0);
    expect(draft.theme.brand.logo).toBe("media_logo");
    expect(draft.theme.pages.homeMode).toEqual({ kind: "product", productId: "prod_live" });
  });

  it("rejects missing, deleted or non-image media and a trashed home product, each at its document path", async () => {
    const { db, sqlite } = createSqliteD1Database();
    seedFiles(sqlite);
    const failure = await saveThemeDraft(
      db,
      themeNaming({ logo: "media_missing", slide: "media_clip", product: "prod_trash" }),
      0,
      0,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).details).toEqual([
      { path: "brand.logo", message: expect.stringContaining("not in Files") },
      { path: `pages.home.${heroIndex}.settings.slides.0.image`, message: expect.stringContaining("not in Files") },
      { path: "pages.homeMode.productId", message: expect.stringContaining("unavailable or in trash") },
    ]);
    await expect(saveThemeDraft(db, themeNaming({ logo: "media_gone" }), 0, 0)).rejects.toBeInstanceOf(ValidationError);
    expect(documentCount(sqlite, "theme")).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS count FROM theme_settings_drafts").get()).toEqual({ count: 0 });
  });

  it("rejects unsafe slide links before anything is read", async () => {
    const { db, sqlite } = createSqliteD1Database();
    seedFiles(sqlite);
    for (const link of ["javascript:alert(1)", "http://example.com", "//evil.example"]) {
      await expect(saveThemeDraft(db, themeNaming({ slide: "media_logo", link }), 0, 0), link)
        .rejects.toBeInstanceOf(ValidationError);
    }
    await expect(saveThemeDraft(db, themeNaming({ slide: "media_logo", link: "https://example.com/eid" }), 0, 0))
      .resolves.toMatchObject({ revision: 1 });
  });
});

describe("store social profiles", () => {
  it("saves https profiles in order and rejects unsafe ones against their field", async () => {
    const { db } = createSqliteD1Database();
    const saved = await saveBusinessSettings(db, {
      socialLinks: [
        { id: "fb", label: " Facebook ", url: "https://facebook.com/shop" },
        { id: "ig", label: "Instagram", url: "https://instagram.com/shop" },
      ],
    });
    expect(saved.value.socialLinks).toEqual([
      { id: "fb", label: "Facebook", url: "https://facebook.com/shop" },
      { id: "ig", label: "Instagram", url: "https://instagram.com/shop" },
    ]);
    const failure = await saveBusinessSettings(db, {
      socialLinks: [{ id: "bad", label: "Bad", url: "javascript:alert(1)" }],
    }, { expectedRevision: saved.revision }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ValidationError);
    expect(JSON.stringify((failure as ValidationError).details)).toContain("socialLinks");
    expect((await getBusinessSettings(db)).socialLinks).toHaveLength(2);
  });
});

describe("site currency settings", () => {
  it("normalizes a supported legacy lowercase code and drops the retired USD rate on read", async () => {
    const { db, sqlite } = createSqliteD1Database();
    storeDocument(sqlite, "currency", JSON.stringify({
      currencyCode: " bdt ",
      currencySymbol: "Tk",
      usdExchangeRate: "120",
    }));

    await expect(getCurrencySettings(db)).resolves.toEqual({
      currencyCode: "BDT",
      currencySymbol: "Tk",
    });
  });

  it("fails closed to the complete default when the persisted code is unsupported", async () => {
    const { db, sqlite } = createSqliteD1Database();
    storeDocument(sqlite, "currency", JSON.stringify({
      currencyCode: "USDT",
      currencySymbol: "₿",
      usdExchangeRate: "999",
    }));

    await expect(getCurrencySettings(db)).resolves.toEqual({
      currencyCode: "BDT",
      currencySymbol: "৳",
    });
  });

  it("canonicalizes codes before persisting the initial setup", async () => {
    const { db } = createSqliteD1Database();
    await saveCurrencySettings(db, { currencyCode: " usd ", currencySymbol: "$" });
    await expect(getCurrencySettings(db)).resolves.toEqual({
      currencyCode: "USD",
      currencySymbol: "$",
    });
  });

  it("rejects unsupported codes before any write", async () => {
    const { db, sqlite } = createSqliteD1Database();
    await expect(saveCurrencySettings(db, { currencyCode: "USDT" }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(documentCount(sqlite, "currency")).toBe(0);
  });

  it("locks the code once money-bearing rows exist but still accepts symbol updates", async () => {
    const { db, sqlite } = createSqliteD1Database();
    sqlite.exec("INSERT INTO products (id, name, price_minor, slug) VALUES ('p1', 'Product', 1000, 'product')");

    await expect(saveCurrencySettings(db, { currencyCode: "USD" })).rejects.toBeInstanceOf(ConflictError);
    await saveCurrencySettings(db, { currencyCode: "BDT", currencySymbol: "Tk" });
    sqlite.exec("DELETE FROM product_variants; DELETE FROM products; INSERT INTO shipping_methods (id, name, fee_minor) VALUES ('ship', 'Standard', 6000)");
    await expect(saveCurrencySettings(db, { currencyCode: "JPY" })).rejects.toBeInstanceOf(ConflictError);
    await expect(getCurrencySettings(db)).resolves.toEqual({
      currencyCode: "BDT",
      currencySymbol: "Tk",
    });
  });

  it("saves the shop currency alone: the price increment is the backup market's", async () => {
    const { db } = createSqliteD1Database();
    await expect(getCurrencyConfig(db)).resolves.toEqual({ code: "BDT", symbol: "৳", decimalPlaces: 2 });
    const symbol = await saveCurrencySettings(db, { currencySymbol: "Tk" });
    expect(symbol.currencyChanged).toBe(false);
    const usd = await saveCurrencySettings(db, { currencyCode: "USD", currencySymbol: "$" });
    expect(usd.currencyChanged).toBe(true);
    await expect(getCurrencySettings(db)).resolves.toEqual({ currencyCode: "USD", currencySymbol: "$" });
  });
});

describe("site SEO settings", () => {
  it("returns default-on discovery settings when nothing is saved", async () => {
    const { db } = createSqliteD1Database();
    await expect(getSeoSettings(db)).resolves.toMatchObject({
      homepageTitle: "",
      socialImage: "",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      returnPolicy: { enabled: false },
    });
  });

  it("merges saved discovery settings with safe defaults and drops removed fields", async () => {
    const { db, sqlite } = createSqliteD1Database();
    storeDocument(sqlite, "seo", JSON.stringify({
      homepageTitle: "Store",
      siteTitle: "Old",
      robotsTxt: "User-agent: *",
      discovery: { sitemap: { products: false }, feeds: { variantStrategy: "bogus" } },
    }));

    const seo = await getSeoSettings(db);
    expect(seo.homepageTitle).toBe("Store");
    expect(seo).not.toHaveProperty("siteTitle");
    expect(seo).not.toHaveProperty("robotsTxt");
    expect(seo.discovery).toEqual(DEFAULT_SEO_DISCOVERY_SETTINGS);
  });

  it("preserves existing nested discovery and return policy details on partial saves", async () => {
    const { db } = createSqliteD1Database();
    await saveSeoSettings(db, {
      homepageTitle: "Store",
      socialImage: "https://cdn.example.com/social.jpg",
      discovery: { feeds: { title: "Catalog", productCatalogEnabled: false } },
      returnPolicy: { enabled: true, category: "finite", returnWindowDays: 14 },
    });
    await saveSeoSettings(db, {
      discovery: { feeds: { variantStrategy: "products" } },
      returnPolicy: { returnWindowDays: 30 },
    });

    const seo = await getSeoSettings(db);
    expect(seo.homepageTitle).toBe("Store");
    expect(seo.socialImage).toBe("https://cdn.example.com/social.jpg");
    expect(seo.discovery.feeds).toMatchObject({
      title: "Catalog",
      productCatalogEnabled: false,
      variantStrategy: "products",
    });
    expect(seo.returnPolicy).toMatchObject({ enabled: true, category: "finite", returnWindowDays: 30 });
  });
});
