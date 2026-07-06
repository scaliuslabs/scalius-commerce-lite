import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertSetting: vi.fn(),
}));

vi.mock("../payments/gateway-settings", () => ({
  upsertSetting: mocks.upsertSetting,
}));

import { getSeoSettings, saveSeoSettings } from "./site-settings.service";

function createSeoReadDb(discoveryValue?: string) {
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
          breadcrumbs: true,
          collections: true,
        },
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
          breadcrumbs: true,
          collections: true,
        },
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
        breadcrumbs: true,
        collections: true,
      },
    });
  });
});
