import { describe, expect, it } from "vitest";

import {
  buildSeoDiscoveryStatus,
  getSeoDiscoveryLiveProbeCountIssue,
  normalizeSeoDiscoverySettingsWithReturnPolicy,
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
          offerShippingDetails: true,
          breadcrumbs: true,
          collections: false,
        },
        returnPolicy: {
          enabled: true,
          country: "bd",
          category: "finite",
          returnWindowDays: "14",
          returnFees: "free",
          returnMethod: "both",
          policyUrl: " https://shop.example.com/returns ",
        },
      },
      robotsTxt: "User-agent: *\nAllow: /\nSitemap: [your-sitemap-url]",
      storefrontUrl: "https://shop.example.com/",
      businessIdentity: {
        companyName: "Scalius Mart",
        legalName: "",
      },
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
      "absolute http(s) product and image links",
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
      "Organization; site search off; products; ProductGroup variants; shipping offers; return policy; breadcrumbs; collections off",
    );
    expect(status.structuredData.returnPolicySummary).toBe(
      "BD; 14 day return window; free returns; mail or in-store returns; policy URL set",
    );
    expect(status.structuredData.organizationNote).toBe(
      "OnlineStore schema needs an absolute Store URL, a business name, and a header logo; Product seller identity uses Business settings only; ProductGroup schema describes optioned products; shipping schema uses active shipping methods; return-policy schema uses only saved public policy fields. BreadcrumbList and CollectionPage are separate controls.",
    );
    expect(status.structuredData.identityWarning).toBeUndefined();
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
      "Runtime strips all Sitemap directives and advertises no sitemap.",
    );
    expect(status.robots.warning).toBe(
      "Saved custom Sitemap lines are ignored; runtime strips or replaces them with the canonical current sitemap.",
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
    expect(relative.sitemap.tone).toBe("warning");
    expect(relative.sitemap.title).toBe("Sitemap needs Store URL");
    expect(relative.robots.tone).toBe("warning");
    expect(relative.robots.title).toBe("robots.txt needs Store URL");
    expect(relative.productFeed.variantStrategy).toBe("variants");
    expect(relative.productFeed.tone).toBe("warning");
    expect(relative.productFeed.summary).toBe(
      "SKU / variant rows; Store URL must be an absolute http(s) URL. Feed XML is unavailable until this is fixed.",
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
          offerShippingDetails: false,
          breadcrumbs: false,
          collections: false,
        },
      },
      storefrontUrl: "",
    });

    expect(status.sitemap.tone).toBe("disabled");
    expect(status.productFeed.tone).toBe("disabled");
    expect(status.structuredData.tone).toBe("disabled");
    expect(status.structuredData.returnPolicySummary).toBe("return policy off");
    expect(status.storefront.mode).toBe("unavailable");
    expect(status.storefront.baseUrl).toBeNull();
    expect(status.storefront.links.every((link) => link.href === null)).toBe(
      true,
    );
  });

  it("normalizes return-policy discovery facts for schema-safe UI consumers", () => {
    expect(
      normalizeSeoDiscoverySettingsWithReturnPolicy({
        returnPolicy: {
          enabled: "yes",
          country: "Bangladesh",
          category: "finite",
          returnWindowDays: 900,
          returnFees: "unknown",
          returnMethod: "in_store",
          policyUrl: "javascript:alert(1)",
        },
      }).returnPolicy,
    ).toEqual({
      enabled: false,
      country: "BD",
      category: "finite",
      returnWindowDays: null,
      returnFees: "customer_responsibility",
      returnMethod: "in_store",
      policyUrl: "",
    });

    expect(
      normalizeSeoDiscoverySettingsWithReturnPolicy({
        returnPolicy: {
          enabled: true,
          country: "US",
          category: "unlimited",
          returnWindowDays: 30,
          policyUrl: "https://example.com/returns",
        },
      }).returnPolicy,
    ).toMatchObject({
      enabled: true,
      country: "US",
      category: "unlimited",
      returnWindowDays: null,
      policyUrl: "https://example.com/returns",
    });
  });

  it("warns when enabled schema needs a business identity", () => {
    const status = buildSeoDiscoveryStatus({
      discovery: {
        structuredData: {
          organization: true,
          websiteSearch: true,
          products: true,
        },
      },
      storefrontUrl: "https://shop.example.com",
      businessIdentity: {
        companyName: "",
        legalName: "",
      },
    });

    expect(status.structuredData.tone).toBe("warning");
    expect(status.structuredData.identityWarning).toBe(
      "Add a company name or legal name in Business settings before relying on OnlineStore, site search, or Product seller identity schema.",
    );
  });

  it("warns when OnlineStore schema is enabled but the header logo is missing", () => {
    const status = buildSeoDiscoveryStatus({
      discovery: {
        structuredData: {
          organization: true,
          websiteSearch: false,
          products: false,
        },
      },
      storefrontUrl: "https://shop.example.com",
      businessIdentity: {
        companyName: "Scalius Mart",
        legalName: "",
      },
      hasStoreLogo: false,
    });

    expect(status.structuredData.tone).toBe("warning");
    expect(status.structuredData.identityWarning).toBe(
      "Add a header logo before relying on OnlineStore schema; runtime omits it without a logo.",
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
          <item><g:link>https://shop.example.com/products/a</g:link><g:image_link>https://img.example.com/a.jpg</g:image_link><g:availability>in stock</g:availability></item>
          <item><link>https://shop.example.com/products/b</link><image_link>https://img.example.com/b.jpg</image_link><availability>out of stock</availability></item>
        </channel></rss>`,
      ),
    ).toEqual({
      feedItems: 2,
      feedLinks: 2,
      absoluteFeedLinks: 2,
      imageLinks: 2,
      absoluteImageLinks: 2,
      availabilityValues: 2,
    });
  });

  it("detects non-empty feed items missing required fields or absolute links", () => {
    const counts = summarizeSeoDiscoveryProbeBody(
      "productFeed",
      `<rss><channel>
        <item><g:link>/products/a</g:link><g:image_link>/images/a.jpg</g:image_link></item>
        <item><g:availability>out of stock</g:availability></item>
      </channel></rss>`,
    );

    expect(counts).toEqual({
      feedItems: 2,
      feedLinks: 1,
      absoluteFeedLinks: 0,
      imageLinks: 1,
      absoluteImageLinks: 0,
      availabilityValues: 1,
    });
    expect(
      getSeoDiscoveryLiveProbeCountIssue({ counts, kind: "feed" }),
    ).toBe(
      "Missing feed fields: 1/2 link, 1/2 image_link, 1/2 availability. Feed links must be absolute http(s): 0/1. Feed images must be absolute http(s): 0/1.",
    );
  });
});
