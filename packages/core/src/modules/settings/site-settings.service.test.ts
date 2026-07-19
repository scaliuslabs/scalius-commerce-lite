import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  ValidationError,
} from "@scalius/core/errors";

const mocks = vi.hoisted(() => ({
  upsertSetting: vi.fn(),
}));

vi.mock("../payments/gateway-settings", () => ({
  upsertSetting: mocks.upsertSetting,
}));

import {
  getCurrencySettings,
  getGeneralSettings,
  getSeoSettings,
  saveHeaderConfig,
  saveCurrencySettings,
  saveSeoSettings,
} from "./site-settings.service";

describe("general site settings", () => {
  it("returns only header and footer presentation fields", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          limit: vi.fn(async () => [{
            headerConfig: JSON.stringify({
              topBar: { text: "Free delivery", isEnabled: true },
              navigation: [{
                id: "returns",
                target: { type: "internal_path", path: "/returns" },
                labelMode: "custom",
                customLabel: "Returns",
              }],
            }),
            footerConfig: JSON.stringify({
              tagline: "Thoughtful goods",
              menus: [{ id: "legacy-menu", links: [] }],
            }),
          }]),
        })),
      })),
    };

    await expect(getGeneralSettings(db as never)).resolves.toMatchObject({
      headerConfig: {
        topBar: { text: "Free delivery", isEnabled: true },
      },
      footerConfig: { tagline: "Thoughtful goods" },
    });
  });

  it("isolates malformed or legacy embedded navigation documents", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          limit: vi.fn(async () => [{
            headerConfig: "{not-json",
            footerConfig: JSON.stringify({
              description: "Support when you need it",
              menus: [{
                id: "help",
                title: "Help",
                links: [{
                  id: "returns",
                  target: { type: "internal_path", path: "/returns" },
                  labelMode: "custom",
                  customLabel: "Returns",
                }],
              }],
            }),
          }]),
        })),
      })),
    };

    await expect(getGeneralSettings(db as never)).resolves.toMatchObject({
      headerConfig: {},
      footerConfig: { description: "Support when you need it" },
      navigationReadiness: {
        header: { state: "ready" },
        footer: { state: "ready" },
      },
    });
  });

  it("does not migrate legacy embedded navigation while reading", async () => {
    const update = vi.fn();
    const insert = vi.fn();
    const db = {
      update,
      insert,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          limit: vi.fn(async () => [{
            headerConfig: JSON.stringify({
              navigation: [{ id: "home", title: "Home", href: "/" }],
            }),
            footerConfig: JSON.stringify({ menus: [] }),
          }]),
        })),
      })),
    };

    await expect(getGeneralSettings(db as never)).resolves.toMatchObject({
      headerConfig: {},
      navigationReadiness: {
        header: { state: "ready" },
        footer: { state: "ready" },
      },
    });
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("strips embedded navigation and unknown keys before writing header settings", async () => {
    const returning = vi.fn(async () => [{ revision: 1 }]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const db = { insert: vi.fn(() => ({ values })) };

    await expect(saveHeaderConfig(db as never, {
      topBar: { text: "Hello", isEnabled: true },
      navigation: [{
        id: "unsafe",
        target: { type: "external_url", url: "javascript:alert(1)" },
        labelMode: "custom",
        customLabel: "Unsafe",
      }],
      arbitrary: "not-persisted",
    }, 0)).resolves.toEqual({ revision: 1 });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      headerConfig: JSON.stringify({
        topBar: { text: "Hello", isEnabled: true },
      }),
    }));
  });
});

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

function createCurrencyWriteDb({
  values = {
    currency_code: "BDT",
    currency_symbol: "৳",
    usd_exchange_rate: "1",
  },
  hasProducts = false,
  hasOrders = false,
}: {
  values?: Record<string, string>;
  hasProducts?: boolean;
  hasOrders?: boolean;
} = {}) {
  let selectCount = 0;
  const writtenValues: Array<Record<string, unknown>> = [];
  const batch = vi.fn(async (statements: Array<{ kind: string }>) => {
    if (statements[0]?.kind === "product-existence") {
      return [
        hasProducts ? [{ id: "product_1" }] : [],
        hasOrders ? [{ id: "order_1" }] : [],
      ];
    }
    return statements.map(() => ({ success: true }));
  });

  return {
    writtenValues,
    batch,
    select: vi.fn(() => {
      const index = selectCount++;
      if (index === 0) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              all: vi.fn(async () => Object.entries(values).map(([key, value]) => ({
                key,
                value,
              }))),
            })),
          })),
        };
      }

      return {
        from: vi.fn(() => ({
          limit: vi.fn(() => ({
            kind: index === 1 ? "product-existence" : "order-existence",
          })),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((inserted: Record<string, unknown>) => {
        writtenValues.push(inserted);
        return {
          onConflictDoUpdate: vi.fn(() => ({ kind: "currency-write" })),
        };
      }),
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
    const db = createCurrencyWriteDb();

    await saveCurrencySettings(db as never, { currencyCode: " bdt " });

    expect(db.writtenValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "currency_code", value: "BDT" }),
      ]),
    );
  });

  it("rejects unsupported codes before any setting write", async () => {
    const db = createCurrencyWriteDb();

    await expect(
      saveCurrencySettings(db as never, {
        currencyCode: "USDT",
        currencySymbol: "$",
        usdExchangeRate: "1",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });

  it.each(["", "0", "-1", "Infinity", "NaN", "1foo"])(
    "rejects invalid USD exchange rate %j before any setting write",
    async (usdExchangeRate) => {
      const db = createCurrencyWriteDb();

      await expect(
        saveCurrencySettings(db as never, { usdExchangeRate }),
      ).rejects.toMatchObject({
        name: "ValidationError",
        message: "USD exchange rate must be a finite number greater than 0.",
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { hasProducts: true, hasOrders: false },
    { hasProducts: false, hasOrders: true },
  ])("blocks currency code changes when money-bearing rows exist", async (rowState) => {
    const db = createCurrencyWriteDb(rowState);

    await expect(
      saveCurrencySettings(db as never, { currencyCode: "USD" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it("allows initial currency setup and commits all three values in one batch", async () => {
    const db = createCurrencyWriteDb();

    await saveCurrencySettings(db as never, {
      currencyCode: "USD",
      currencySymbol: "$",
      usdExchangeRate: " 1.25 ",
    });

    expect(db.writtenValues).toEqual([
      expect.objectContaining({ key: "currency_code", value: "USD" }),
      expect.objectContaining({ key: "currency_symbol", value: "$" }),
      expect.objectContaining({ key: "usd_exchange_rate", value: "1.25" }),
    ]);
    expect(db.batch).toHaveBeenCalledTimes(2);
    expect(db.batch.mock.calls[1]?.[0]).toHaveLength(3);
  });

  it("allows same-code, symbol, and rate updates after catalog rows exist", async () => {
    const db = createCurrencyWriteDb({ hasProducts: true, hasOrders: true });

    await saveCurrencySettings(db as never, {
      currencyCode: "BDT",
      currencySymbol: "Tk",
      usdExchangeRate: "120",
    });

    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.writtenValues).toEqual([
      expect.objectContaining({ key: "currency_code", value: "BDT" }),
      expect.objectContaining({ key: "currency_symbol", value: "Tk" }),
      expect.objectContaining({ key: "usd_exchange_rate", value: "120" }),
    ]);
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
