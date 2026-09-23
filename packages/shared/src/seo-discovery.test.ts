import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEO_DISCOVERY_SETTINGS,
  mergeSeoDiscoverySettings,
  normalizeSeoDiscoverySettings,
  parseSeoDiscoverySettings,
} from "./seo-discovery";

describe("SEO discovery settings", () => {
  it("defaults the product catalog feed on", () => {
    expect(normalizeSeoDiscoverySettings(null)).toEqual(
      DEFAULT_SEO_DISCOVERY_SETTINGS,
    );
    expect(parseSeoDiscoverySettings("not json")).toEqual(
      DEFAULT_SEO_DISCOVERY_SETTINGS,
    );
  });

  it("normalizes partial feed settings without losing safe defaults", () => {
    expect(
      normalizeSeoDiscoverySettings({
        feeds: {
          productCatalogEnabled: false,
          includeUnavailableProducts: false,
          variantStrategy: "products",
          title: "  Merchant feed  ",
        },
      }),
    ).toEqual({
      feeds: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS.feeds,
        productCatalogEnabled: false,
        includeUnavailableProducts: false,
        variantStrategy: "products",
        title: "Merchant feed",
      },
    });
  });

  it("ignores invalid values instead of treating strings as flags", () => {
    expect(
      normalizeSeoDiscoverySettings({
        feeds: {
          productCatalogEnabled: "false",
          variantStrategy: "skus",
          title: 42,
        },
      }),
    ).toEqual(DEFAULT_SEO_DISCOVERY_SETTINGS);
  });

  it("keeps only the feed group", () => {
    expect(
      normalizeSeoDiscoverySettings({
        sitemap: { enabled: false },
        structuredData: { products: false },
      }),
    ).toEqual(DEFAULT_SEO_DISCOVERY_SETTINGS);
  });

  it("deep-merges partial feed patches without resetting sibling fields", () => {
    expect(
      mergeSeoDiscoverySettings(
        {
          feeds: {
            productCatalogEnabled: false,
            includeUnavailableProducts: true,
            variantStrategy: "products",
            title: "Catalog",
            description: "Products",
          },
        },
        {
          feeds: {
            includeUnavailableProducts: false,
            variantStrategy: "variants",
          },
        },
      ),
    ).toEqual({
      feeds: {
        productCatalogEnabled: false,
        includeUnavailableProducts: false,
        variantStrategy: "variants",
        title: "Catalog",
        description: "Products",
      },
    });
  });
});
