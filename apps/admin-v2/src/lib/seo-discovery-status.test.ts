import { describe, expect, it } from "vitest";

import {
  buildSeoDiscoveryStatus,
  summarizeSeoDiscoveryProbeBody,
} from "./seo-discovery-status";

describe("buildSeoDiscoveryStatus", () => {
  it("summarizes enabled discovery controls and safe absolute preview links", () => {
    const status = buildSeoDiscoveryStatus({
      discovery: {
        sitemap: {
          enabled: true,
          products: true,
          categories: false,
          collections: true,
          pages: true,
        },
        feeds: {
          productCatalogEnabled: true,
          includeUnavailableProducts: false,
          variantStrategy: "products",
          title: "  Merchant feed  ",
          description: "  Fresh catalog  ",
        },
        robots: { advertiseSitemap: true },
        structuredData: {
          organization: true,
          websiteSearch: false,
          products: true,
          productGroups: true,
          breadcrumbs: true,
          collections: false,
        },
      },
      robotsTxt: "User-agent: *\nAllow: /\nSitemap: [your-sitemap-url]",
      storefrontUrl: "https://shop.example.com/",
    });

    expect(status.sitemap.title).toBe("Sitemap index on");
    expect(status.sitemap.summary).toBe(
      "Includes home + search, products, collections, pages.",
    );
    expect(status.sitemap.includedSections).toEqual([
      { key: "staticPages", label: "Home + search", enabled: true },
      { key: "products", label: "Products", enabled: true },
      { key: "categories", label: "Categories", enabled: false },
      { key: "collections", label: "Collections", enabled: true },
      { key: "pages", label: "Pages", enabled: true },
    ]);
    expect(status.productFeed.imagePolicy).toContain(
      "absolute http(s) primary image",
    );
    expect(status.productFeed.summary).toBe(
      "Product rows; only items currently available for sale are included.",
    );
    expect(status.productFeed.variantStrategy).toBe("products");
    expect(status.productFeed.variantStrategyLabel).toBe("Product rows");
    expect(status.productFeed.feedTitle).toBe("Merchant feed");
    expect(status.productFeed.feedDescription).toBe("Fresh catalog");
    expect(status.robots.warning).toBeUndefined();
    expect(status.structuredData.summary).toBe(
      "Organization; site search off; products; ProductGroup variants; breadcrumbs; collections off",
    );
    expect(status.structuredData.organizationNote).toBe(
      "Organization schema needs a logo; ProductGroup schema describes optioned products and SKU variants when product schema is emitted.",
    );
    expect(status.storefront.mode).toBe("absolute");
    expect(status.storefront.links).toContainEqual({
      key: "sitemap",
      label: "Sitemap index",
      path: "/sitemap.xml",
      href: "https://shop.example.com/sitemap.xml",
    });
  });

  it("warns when robots.txt has non-placeholder Sitemap lines", () => {
    const status = buildSeoDiscoveryStatus({
      discovery: {
        robots: { advertiseSitemap: false },
      },
      robotsTxt:
        "User-agent: *\nAllow: /\nSitemap: https://old.example.com/sitemap.xml\nSitemap: your-sitemap-url",
      storefrontUrl: "https://shop.example.com",
    });

    expect(status.robots.tone).toBe("warning");
    expect(status.robots.customSitemapLines).toEqual([
      "Sitemap: https://old.example.com/sitemap.xml",
    ]);
    expect(status.robots.summary).toBe(
      "Runtime removes placeholder Sitemap lines but keeps custom Sitemap lines.",
    );
    expect(status.robots.warning).toBe(
      "Custom Sitemap lines are preserved; confirm they point to the right storefront.",
    );
  });

  it("keeps preview links path-only for relative or non-http Store URLs", () => {
    const relative = buildSeoDiscoveryStatus({
      discovery: null,
      storefrontUrl: "/demo-store",
    });
    const nonHttp = buildSeoDiscoveryStatus({
      discovery: null,
      storefrontUrl: "ftp://shop.example.com",
    });

    expect(relative.storefront.mode).toBe("path-only");
    expect(relative.productFeed.variantStrategy).toBe("variants");
    expect(relative.productFeed.summary).toBe(
      "SKU / variant rows; sold-out catalog items are marked out of stock.",
    );
    expect(relative.storefront.links.every((link) => link.href === null)).toBe(
      true,
    );
    expect(nonHttp.storefront.mode).toBe("path-only");
    expect(nonHttp.storefront.links.every((link) => link.href === null)).toBe(
      true,
    );
  });

  it("reports unavailable preview links when Store URL is missing", () => {
    const status = buildSeoDiscoveryStatus({
      discovery: {
        sitemap: { enabled: false },
        feeds: { productCatalogEnabled: false },
        structuredData: {
          organization: false,
          websiteSearch: false,
          products: false,
          productGroups: false,
          breadcrumbs: false,
          collections: false,
        },
      },
      storefrontUrl: "",
    });

    expect(status.sitemap.tone).toBe("disabled");
    expect(status.productFeed.tone).toBe("disabled");
    expect(status.structuredData.tone).toBe("disabled");
    expect(status.storefront.mode).toBe("unavailable");
    expect(status.storefront.baseUrl).toBeNull();
    expect(status.storefront.links.every((link) => link.href === null)).toBe(
      true,
    );
  });
});

describe("summarizeSeoDiscoveryProbeBody", () => {
  it("counts robots Sitemap directives without exposing body text", () => {
    expect(
      summarizeSeoDiscoveryProbeBody(
        "robots",
        "User-agent: *\nAllow: /\nSitemap: https://shop.example.com/sitemap.xml\nsitemap: https://shop.example.com/sitemap-products.xml",
      ),
    ).toEqual({ robotsSitemapLines: 2 });
  });

  it("counts sitemap loc tags with optional XML namespaces", () => {
    expect(
      summarizeSeoDiscoveryProbeBody(
        "sitemap",
        `<sitemapindex>
          <sitemap><loc>https://shop.example.com/sitemap-products.xml</loc></sitemap>
          <x:loc>https://shop.example.com/sitemap-pages.xml</x:loc>
        </sitemapindex>`,
      ),
    ).toEqual({ sitemapLocs: 2 });
  });

  it("counts feed item, image_link, and availability tags", () => {
    expect(
      summarizeSeoDiscoveryProbeBody(
        "productFeed",
        `<rss><channel>
          <item><g:image_link>https://img.example.com/a.jpg</g:image_link><g:availability>in stock</g:availability></item>
          <item><image_link>https://img.example.com/b.jpg</image_link><availability>out of stock</availability></item>
        </channel></rss>`,
      ),
    ).toEqual({
      feedItems: 2,
      imageLinks: 2,
      availabilityValues: 2,
    });
  });
});
