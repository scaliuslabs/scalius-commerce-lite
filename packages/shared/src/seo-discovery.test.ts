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
        feeds: { productCatalogEnabled: false },
      }),
    ).toEqual({
      ...DEFAULT_SEO_DISCOVERY_SETTINGS,
      sitemap: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap,
        products: false,
      },
      feeds: { productCatalogEnabled: false },
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
          feeds: { productCatalogEnabled: false },
          robots: { advertiseSitemap: false },
          structuredData: { organization: false, websiteSearch: true },
        },
        {
          sitemap: { pages: true },
          structuredData: { websiteSearch: false },
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
      feeds: { productCatalogEnabled: false },
      robots: { advertiseSitemap: false },
      structuredData: { organization: false, websiteSearch: false },
    });
  });
});
