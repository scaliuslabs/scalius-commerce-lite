import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEO_DISCOVERY_SETTINGS,
  mergeSeoDiscoverySettings,
  normalizeSeoDiscoverySettings,
  parseSeoDiscoverySettings,
} from "./seo-discovery";

describe("SEO discovery settings", () => {
  it("defaults every discovery surface on", () => {
    expect(normalizeSeoDiscoverySettings(null)).toEqual(
      DEFAULT_SEO_DISCOVERY_SETTINGS,
    );
    expect(parseSeoDiscoverySettings("not json")).toEqual(
      DEFAULT_SEO_DISCOVERY_SETTINGS,
    );
  });

  it("merges partial settings without losing safe defaults", () => {
    expect(
      normalizeSeoDiscoverySettings({
        sitemap: { products: false },
        feeds: {
          productCatalogEnabled: false,
          includeUnavailableProducts: false,
          variantStrategy: "products",
          title: "  Merchant feed  ",
        },
        structuredData: {
          productGroups: false,
        },
      }),
    ).toEqual({
      ...DEFAULT_SEO_DISCOVERY_SETTINGS,
      sitemap: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap,
        products: false,
      },
      feeds: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS.feeds,
        productCatalogEnabled: false,
        includeUnavailableProducts: false,
        variantStrategy: "products",
        title: "Merchant feed",
      },
      structuredData: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData,
        productGroups: false,
      },
    });
  });

  it("fills missing new settings from safe defaults for older saved values", () => {
    expect(
      normalizeSeoDiscoverySettings({
        feeds: {
          productCatalogEnabled: true,
          includeUnavailableProducts: false,
        },
        structuredData: {
          products: true,
          breadcrumbs: false,
        },
      }),
    ).toMatchObject({
      feeds: {
        variantStrategy: "variants",
      },
      structuredData: {
        productGroups: true,
        offerShippingDetails: true,
      },
    });
  });

  it("ignores invalid values instead of treating strings as flags", () => {
    expect(
      normalizeSeoDiscoverySettings({
        sitemap: { enabled: "false", categories: false },
        feeds: { variantStrategy: "skus" },
        robots: { advertiseSitemap: "no" },
        structuredData: { productGroups: "yes" },
      }),
    ).toEqual({
      ...DEFAULT_SEO_DISCOVERY_SETTINGS,
      sitemap: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap,
        categories: false,
      },
    });
  });

  it("deep-merges partial patches without resetting sibling discovery toggles", () => {
    expect(
      mergeSeoDiscoverySettings(
        {
          sitemap: {
            enabled: true,
            staticPages: true,
            products: false,
            categories: false,
            collections: true,
            pages: false,
            articles: true,
          },
          feeds: {
            productCatalogEnabled: false,
            includeUnavailableProducts: true,
            variantStrategy: "products",
            title: "Catalog",
            description: "Products",
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
            articles: true,
          },
        },
        {
          sitemap: { pages: true },
          feeds: {
            includeUnavailableProducts: false,
            variantStrategy: "variants",
          },
          structuredData: {
            websiteSearch: false,
            products: false,
            productGroups: false,
          },
        },
      ),
    ).toEqual({
      sitemap: {
        enabled: true,
        staticPages: true,
        products: false,
        categories: false,
        collections: true,
        pages: true,
        articles: true,
      },
      feeds: {
        productCatalogEnabled: false,
        includeUnavailableProducts: false,
        variantStrategy: "variants",
        title: "Catalog",
        description: "Products",
      },
      robots: { advertiseSitemap: false },
      structuredData: {
        organization: false,
        websiteSearch: false,
        products: false,
        productGroups: false,
        offerShippingDetails: true,
        breadcrumbs: true,
        collections: true,
        articles: true,
      },
    });
  });
});
