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
          title: "  Merchant feed  ",
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
        title: "Merchant feed",
      },
    });
  });

  it("ignores non-boolean values instead of treating strings as flags", () => {
    expect(
      normalizeSeoDiscoverySettings({
        sitemap: { enabled: "false", categories: false },
        robots: { advertiseSitemap: "no" },
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
          },
          feeds: {
            productCatalogEnabled: false,
            includeUnavailableProducts: true,
            title: "Catalog",
            description: "Products",
          },
          robots: { advertiseSitemap: false },
          structuredData: {
            organization: false,
            websiteSearch: true,
            products: true,
            breadcrumbs: true,
            collections: true,
          },
        },
        {
          sitemap: { pages: true },
          feeds: { includeUnavailableProducts: false },
          structuredData: { websiteSearch: false, products: false },
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
      },
      feeds: {
        productCatalogEnabled: false,
        includeUnavailableProducts: false,
        title: "Catalog",
        description: "Products",
      },
      robots: { advertiseSitemap: false },
      structuredData: {
        organization: false,
        websiteSearch: false,
        products: false,
        breadcrumbs: true,
        collections: true,
      },
    });
  });
});
