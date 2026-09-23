import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { DEFAULT_SEO_DISCOVERY_SETTINGS } from "@scalius/shared/seo-discovery";

import {
  getCurrencySettings,
  getGeneralSettings,
  getSeoSettings,
  saveCurrencySettings,
  saveHeaderConfig,
  saveSeoSettings,
} from "./site-settings.service";

function storeDocument(sqlite: ReturnType<typeof createSqliteD1Database>["sqlite"], category: string, value: string) {
  sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES (?, 'document', ?, 'json', ?)")
    .run(`${category}_doc`, value, category);
}

function documentCount(sqlite: ReturnType<typeof createSqliteD1Database>["sqlite"], category: string): number {
  return Number((sqlite.prepare("SELECT count(*) AS count FROM settings WHERE category = ?").get(category) as { count: number }).count);
}

describe("general site settings", () => {
  it("returns only header and footer presentation fields", async () => {
    const { db, sqlite } = createSqliteD1Database();
    storeDocument(sqlite, "header", JSON.stringify({
      topBar: { text: "Free delivery", isEnabled: true },
      navigation: [{ id: "returns", target: { type: "internal_path", path: "/returns" } }],
    }));
    storeDocument(sqlite, "footer", JSON.stringify({
      tagline: "Thoughtful goods",
      menus: [{ id: "legacy-menu", links: [] }],
    }));

    await expect(getGeneralSettings(db)).resolves.toMatchObject({
      headerConfig: { topBar: { text: "Free delivery", isEnabled: true } },
      footerConfig: { tagline: "Thoughtful goods" },
      revisions: { header: 1, footer: 1 },
      navigationReadiness: {
        header: { status: "ready", issues: [] },
        footer: { status: "ready", issues: [] },
      },
    });
  });

  it("isolates a malformed presentation document", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { db, sqlite } = createSqliteD1Database();
    storeDocument(sqlite, "header", "{not-json");
    storeDocument(sqlite, "footer", JSON.stringify({ description: "Support when you need it" }));

    await expect(getGeneralSettings(db)).resolves.toMatchObject({
      headerConfig: {},
      footerConfig: { description: "Support when you need it" },
    });
  });

  it("strips embedded navigation and unknown keys before writing header settings", async () => {
    const { db, sqlite } = createSqliteD1Database();
    await saveHeaderConfig(db, {
      topBar: { text: "Hello", isEnabled: true },
      navigation: [{ id: "home" }],
      unknown: "value",
    }, 0);

    const row = sqlite.prepare("SELECT value FROM settings WHERE category = 'header'").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual({ topBar: { text: "Hello", isEnabled: true } });
  });
});

describe("site currency settings", () => {
  it("normalizes a supported legacy lowercase code on read", async () => {
    const { db, sqlite } = createSqliteD1Database();
    storeDocument(sqlite, "currency", JSON.stringify({
      currencyCode: " bdt ",
      currencySymbol: "Tk",
      usdExchangeRate: "120",
    }));

    await expect(getCurrencySettings(db)).resolves.toEqual({
      currencyCode: "BDT",
      currencySymbol: "Tk",
      usdExchangeRate: "120",
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
      usdExchangeRate: "1",
    });
  });

  it("canonicalizes codes and rates before persisting the initial setup", async () => {
    const { db } = createSqliteD1Database();
    await saveCurrencySettings(db, { currencyCode: " usd ", currencySymbol: "$", usdExchangeRate: " 1.25 " });
    await expect(getCurrencySettings(db)).resolves.toEqual({
      currencyCode: "USD",
      currencySymbol: "$",
      usdExchangeRate: "1.25",
    });
  });

  it("rejects unsupported codes and invalid rates before any write", async () => {
    const { db, sqlite } = createSqliteD1Database();
    await expect(saveCurrencySettings(db, { currencyCode: "USDT" }))
      .rejects.toBeInstanceOf(ValidationError);
    for (const usdExchangeRate of ["", "0", "-1", "Infinity", "NaN", "1foo"]) {
      await expect(saveCurrencySettings(db, { usdExchangeRate })).rejects.toMatchObject({
        name: "ValidationError",
        message: "USD exchange rate must be a finite number greater than 0.",
      });
    }
    expect(documentCount(sqlite, "currency")).toBe(0);
  });

  it("locks the code once money-bearing rows exist but still accepts symbol and rate updates", async () => {
    const { db, sqlite } = createSqliteD1Database();
    sqlite.exec("INSERT INTO products (id, name, price, slug) VALUES ('p1', 'Product', 10, 'product')");

    await expect(saveCurrencySettings(db, { currencyCode: "USD" })).rejects.toBeInstanceOf(ConflictError);
    await saveCurrencySettings(db, { currencyCode: "BDT", currencySymbol: "Tk", usdExchangeRate: "120" });
    await expect(getCurrencySettings(db)).resolves.toEqual({
      currencyCode: "BDT",
      currencySymbol: "Tk",
      usdExchangeRate: "120",
    });
  });
});

describe("site SEO settings", () => {
  it("returns default-on discovery settings when nothing is saved", async () => {
    const { db } = createSqliteD1Database();
    await expect(getSeoSettings(db)).resolves.toMatchObject({
      siteTitle: "",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      returnPolicy: { enabled: false },
    });
  });

  it("merges saved discovery settings with safe defaults", async () => {
    const { db, sqlite } = createSqliteD1Database();
    storeDocument(sqlite, "seo", JSON.stringify({
      siteTitle: "Store",
      discovery: { sitemap: { products: false }, feeds: { variantStrategy: "bogus" } },
    }));

    const seo = await getSeoSettings(db);
    expect(seo.siteTitle).toBe("Store");
    expect(seo.discovery.sitemap).toEqual({ ...DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap, products: false });
    expect(seo.discovery.feeds.variantStrategy).toBe(DEFAULT_SEO_DISCOVERY_SETTINGS.feeds.variantStrategy);
  });

  it("preserves existing nested discovery and return policy details on partial saves", async () => {
    const { db } = createSqliteD1Database();
    await saveSeoSettings(db, {
      siteTitle: "Store",
      discovery: { sitemap: { products: false }, feeds: { title: "Catalog" } },
      returnPolicy: { enabled: true, category: "finite", returnWindowDays: 14 },
    });
    await saveSeoSettings(db, {
      discovery: { sitemap: { categories: false } },
      returnPolicy: { returnWindowDays: 30 },
    });

    const seo = await getSeoSettings(db);
    expect(seo.siteTitle).toBe("Store");
    expect(seo.discovery.sitemap).toMatchObject({ products: false, categories: false });
    expect(seo.discovery.feeds.title).toBe("Catalog");
    expect(seo.returnPolicy).toMatchObject({ enabled: true, category: "finite", returnWindowDays: 30 });
  });
});
