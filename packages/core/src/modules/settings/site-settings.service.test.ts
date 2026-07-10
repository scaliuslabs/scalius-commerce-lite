import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@scalius/core/errors";

const mocks = vi.hoisted(() => ({
  upsertSetting: vi.fn(),
}));

vi.mock("../payments/gateway-settings", () => ({
  upsertSetting: mocks.upsertSetting,
}));

import {
  getCurrencySettings,
  getSeoSettings,
  saveCurrencySettings,
  saveSeoSettings,
} from "./site-settings.service";

function createCurrencyReadDb(values: Record<string, string>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(async () => Object.entries(values).map(([key, value]) => ({
            key,
            value,
          }))),
        })),
      })),
    })),
  };
}

describe("site currency settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertSetting.mockResolvedValue(undefined);
  });

  it("normalizes a supported legacy lowercase code on read", async () => {
    const db = createCurrencyReadDb({
      currency_code: " bdt ",
      currency_symbol: "Tk",
      usd_exchange_rate: "120",
    });

    await expect(getCurrencySettings(db as never)).resolves.toEqual({
      currencyCode: "BDT",
      currencySymbol: "Tk",
      usdExchangeRate: "120",
    });
  });

  it("fails closed to the complete default when the persisted code is unsupported", async () => {
    const db = createCurrencyReadDb({
      currency_code: "USDT",
      currency_symbol: "₿",
      usd_exchange_rate: "999",
    });

    await expect(getCurrencySettings(db as never)).resolves.toEqual({
      currencyCode: "BDT",
      currencySymbol: "৳",
      usdExchangeRate: "1",
    });
  });

  it("canonicalizes lowercase supported codes before persisting", async () => {
    await saveCurrencySettings({} as never, { currencyCode: " usd " });

    expect(mocks.upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "currency",
      "currency_code",
      "USD",
    );
  });

  it("rejects unsupported codes before any setting write", async () => {
    await expect(
      saveCurrencySettings({} as never, {
        currencyCode: "USDT",
        currencySymbol: "$",
        usdExchangeRate: "1",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(mocks.upsertSetting).not.toHaveBeenCalled();
  });
});

function createSeoReadDb(discoveryValue?: string, returnPolicyValue?: string) {
  const query = {
    from: vi.fn(() => ({
      limit: vi.fn(() => ({})),
      where: vi.fn(() => ({
        limit: vi.fn(() => ({})),
      })),
    })),
  };

  return {
    select: vi.fn(() => query),
    batch: vi.fn(async () => [
      [
        {
          siteTitle: "Store",
          homepageTitle: "Home",
          homepageMetaDescription: "Description",
          robotsTxt: "User-agent: *\nAllow: /",
        },
      ],
      discoveryValue ? [{ value: discoveryValue }] : [],
      returnPolicyValue ? [{ value: returnPolicyValue }] : [],
    ]),
  };
}

describe("site SEO settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertSetting.mockResolvedValue(undefined);
  });

  it("returns default-on discovery settings when no discovery row exists", async () => {
    const db = createSeoReadDb();

    await expect(getSeoSettings(db as never)).resolves.toMatchObject({
      siteTitle: "Store",
      discovery: {
        sitemap: {
          enabled: true,
          staticPages: true,
          products: true,
          categories: true,
          collections: true,
          pages: true,
        },
        feeds: {
          productCatalogEnabled: true,
          includeUnavailableProducts: true,
          variantStrategy: "variants",
          title: "",
          description: "",
        },
        robots: { advertiseSitemap: true },
        structuredData: {
          organization: true,
          websiteSearch: true,
          products: true,
          productGroups: true,
          offerShippingDetails: true,
          breadcrumbs: true,
          collections: true,
        },
      },
      returnPolicy: {
        enabled: false,
        country: "BD",
        category: "finite",
        returnWindowDays: null,
        returnFees: "customer_responsibility",
        returnMethod: "mail",
        policyUrl: "",
      },
    });
  });

  it("merges saved discovery settings with safe defaults", async () => {
    const db = createSeoReadDb(
      JSON.stringify({
        sitemap: { products: false },
        structuredData: { websiteSearch: false },
      }),
    );

    await expect(getSeoSettings(db as never)).resolves.toMatchObject({
      discovery: {
        sitemap: {
          enabled: true,
          staticPages: true,
          products: false,
          categories: true,
          collections: true,
          pages: true,
        },
        feeds: {
          productCatalogEnabled: true,
          includeUnavailableProducts: true,
          variantStrategy: "variants",
          title: "",
          description: "",
        },
        robots: { advertiseSitemap: true },
        structuredData: {
          organization: true,
          websiteSearch: false,
          products: true,
          productGroups: true,
          offerShippingDetails: true,
          breadcrumbs: true,
          collections: true,
        },
      },
    });
  });

  it("returns normalized return policy settings from the generic settings table", async () => {
    const db = createSeoReadDb(
      undefined,
      JSON.stringify({
        enabled: true,
        country: "us",
        category: "finite",
        returnWindowDays: 30,
        returnFees: "free",
        returnMethod: "both",
        policyUrl: "https://store.example.com/returns",
      }),
    );

    await expect(getSeoSettings(db as never)).resolves.toMatchObject({
      returnPolicy: {
        enabled: true,
        country: "US",
        category: "finite",
        returnWindowDays: 30,
        returnFees: "free",
        returnMethod: "both",
        policyUrl: "https://store.example.com/returns",
      },
    });
  });

  it("saves discovery-only changes in the generic settings table", async () => {
    const db = {
      ...createSeoReadDb(),
      insert: vi.fn(),
    };

    await saveSeoSettings(db as never, {
      discovery: {
        feeds: { productCatalogEnabled: false },
      } as never,
    });

    expect(db.insert).not.toHaveBeenCalled();
    expect(mocks.upsertSetting).toHaveBeenCalledTimes(1);
    const [, category, key, rawValue] = mocks.upsertSetting.mock.calls[0] ?? [];
    expect({ category, key }).toEqual({ category: "seo", key: "discovery" });
    expect(JSON.parse(String(rawValue))).toMatchObject({
      sitemap: { enabled: true, products: true },
      feeds: { productCatalogEnabled: false },
      robots: { advertiseSitemap: true },
    });
  });

  it("preserves existing nested discovery settings on partial saves", async () => {
    const db = {
      ...createSeoReadDb(
        JSON.stringify({
          sitemap: {
            enabled: true,
            staticPages: true,
            products: false,
            categories: false,
            collections: true,
            pages: false,
          },
          feeds: { productCatalogEnabled: false },
          robots: { advertiseSitemap: false },
          structuredData: { organization: false, websiteSearch: true },
        }),
      ),
      insert: vi.fn(),
    };

    await saveSeoSettings(db as never, {
      discovery: {
        sitemap: { pages: true },
      } as never,
    });

    const [, , , rawValue] = mocks.upsertSetting.mock.calls[0] ?? [];
    expect(JSON.parse(String(rawValue))).toEqual({
      sitemap: {
        enabled: true,
        staticPages: true,
        products: false,
        categories: false,
        collections: true,
        pages: true,
      },
      feeds: {
        productCatalogEnabled: false,
        includeUnavailableProducts: true,
        variantStrategy: "variants",
        title: "",
        description: "",
      },
      robots: { advertiseSitemap: false },
      structuredData: {
        organization: false,
        websiteSearch: true,
        products: true,
        productGroups: true,
        offerShippingDetails: true,
        breadcrumbs: true,
        collections: true,
      },
    });
  });

  it("saves return policy changes in the generic settings table", async () => {
    const db = {
      ...createSeoReadDb(),
      insert: vi.fn(),
    };

    await saveSeoSettings(db as never, {
      returnPolicy: {
        enabled: true,
        country: "bd",
        category: "finite",
        returnWindowDays: 7,
        returnFees: "free",
        returnMethod: "mail",
        policyUrl: "https://store.example.com/returns",
      },
    });

    expect(db.insert).not.toHaveBeenCalled();
    expect(mocks.upsertSetting).toHaveBeenCalledTimes(1);
    const [, category, key, rawValue] = mocks.upsertSetting.mock.calls[0] ?? [];
    expect({ category, key }).toEqual({
      category: "seo",
      key: "return_policy",
    });
    expect(JSON.parse(String(rawValue))).toEqual({
      enabled: true,
      country: "BD",
      category: "finite",
      returnWindowDays: 7,
      returnFees: "free",
      returnMethod: "mail",
      policyUrl: "https://store.example.com/returns",
    });
  });

  it("preserves existing return policy details on partial saves", async () => {
    const db = {
      ...createSeoReadDb(
        undefined,
        JSON.stringify({
          enabled: true,
          country: "BD",
          category: "finite",
          returnWindowDays: 15,
          returnFees: "customer_responsibility",
          returnMethod: "mail",
          policyUrl: "https://store.example.com/returns",
        }),
      ),
      insert: vi.fn(),
    };

    await saveSeoSettings(db as never, {
      returnPolicy: {
        returnFees: "free",
        returnMethod: "both",
      },
    });

    const [, , , rawValue] = mocks.upsertSetting.mock.calls[0] ?? [];
    expect(JSON.parse(String(rawValue))).toEqual({
      enabled: true,
      country: "BD",
      category: "finite",
      returnWindowDays: 15,
      returnFees: "free",
      returnMethod: "both",
      policyUrl: "https://store.example.com/returns",
    });
  });
});
