import { describe, expect, it } from "vitest";
import { DEFAULT_SEO_DISCOVERY_SETTINGS } from "@scalius/shared/seo-discovery";

import { buildProductSeoDiagnostics } from "./product-seo-diagnostics";

const activeProduct = {
  id: "prod_1",
  slug: "green-tea",
  isActive: true,
  images: [{ url: "https://cdn.example.com/green-tea.jpg", isPrimary: true }],
};

const availableSimpleSku = [
  {
    id: "var_default_prod_1",
    isDefault: true,
    stock: 0,
    reservedStock: 0,
    trackInventory: false,
    deletedAt: null,
  },
];

describe("buildProductSeoDiagnostics", () => {
  it("marks an active product with image and available SKU ready for discovery", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: activeProduct,
      variants: availableSimpleSku,
      variantState: "loaded",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: "https://shop.example.com",
      policySource: "current",
    });

    expect(diagnostics.canonical).toMatchObject({
      tone: "ok",
      path: "/products/green-tea",
      url: "https://shop.example.com/products/green-tea",
    });
    expect(diagnostics.sitemap.title).toBe("Expected in product sitemap");
    expect(diagnostics.feed).toMatchObject({
      tone: "ok",
      inclusion: "included",
      skippedReason: null,
    });
    expect(diagnostics.structuredData.title).toBe(
      "Product + Breadcrumb JSON-LD on",
    );
  });

  it("keeps create-mode products in calm draft states", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: { slug: "", isActive: true, images: [] },
      variantState: "unavailable",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: null,
      policySource: "default",
    });

    expect(diagnostics.canonical.tone).toBe("draft");
    expect(diagnostics.sitemap.tone).toBe("draft");
    expect(diagnostics.feedImage.tone).toBe("draft");
    expect(diagnostics.feed.inclusion).toBe("draft");
    expect(diagnostics.policy.label).toBe("Default SEO policy");
  });

  it("previews same-store canonical path overrides", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: {
        ...activeProduct,
        canonicalPath: "/products/green-tea-campaign",
      },
      variants: availableSimpleSku,
      variantState: "loaded",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: "https://shop.example.com",
    });

    expect(diagnostics.canonical).toMatchObject({
      tone: "ok",
      title: "Canonical override ready",
      path: "/products/green-tea-campaign",
      url: "https://shop.example.com/products/green-tea-campaign",
    });
  });

  it("warns on product canonical overrides outside product routes", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: {
        ...activeProduct,
        canonicalPath: "/shop/green-tea",
      },
      variants: availableSimpleSku,
      variantState: "loaded",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: "https://shop.example.com",
    });

    expect(diagnostics.canonical).toMatchObject({
      tone: "warning",
      title: "Canonical path needs cleanup",
      path: null,
      url: null,
    });
  });

  it("reports the required feed image skip reason without blocking sitemap", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: { ...activeProduct, images: [] },
      variants: availableSimpleSku,
      variantState: "loaded",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: "https://shop.example.com",
      policySource: "current",
    });

    expect(diagnostics.sitemap.tone).toBe("ok");
    expect(diagnostics.feedImage).toMatchObject({
      tone: "warning",
      title: "Feed image needed",
    });
    expect(diagnostics.feed).toMatchObject({
      tone: "warning",
      inclusion: "skipped",
      skippedReason: "Missing or invalid primary image.",
    });
  });

  it("requires the actual primary image for feed readiness", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: {
        ...activeProduct,
        images: [
          { url: "https://cdn.example.com/secondary.jpg", isPrimary: false },
          { url: "", isPrimary: true },
        ],
      },
      variants: availableSimpleSku,
      variantState: "loaded",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: "https://shop.example.com",
      policySource: "current",
    });

    expect(diagnostics.feedImage).toMatchObject({
      tone: "warning",
      title: "Feed image needed",
      imageUrl: null,
    });
    expect(diagnostics.feed).toMatchObject({
      inclusion: "skipped",
      skippedReason: "Missing or invalid primary image.",
    });
  });

  it("uses the shared catalog discovery image contract for feed image readiness", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: {
        ...activeProduct,
        images: [{ url: "//cdn.example.com/protocol-relative.jpg", isPrimary: true }],
      },
      variants: availableSimpleSku,
      variantState: "loaded",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: "https://shop.example.com",
      policySource: "current",
    });

    expect(diagnostics.feedImage).toMatchObject({
      tone: "warning",
      title: "Feed image skipped",
    });
    expect(diagnostics.feed).toMatchObject({
      inclusion: "skipped",
      skippedReason: "Missing or invalid primary image.",
    });
  });

  it("treats product-level XML exclusions as discovery-only controls", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: {
        ...activeProduct,
        excludeFromSitemap: true,
        excludeFromProductFeed: true,
      },
      variants: availableSimpleSku,
      variantState: "loaded",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: "https://shop.example.com",
      policySource: "current",
    });

    expect(diagnostics.canonical).toMatchObject({
      tone: "ok",
      path: "/products/green-tea",
    });
    expect(diagnostics.sitemap).toMatchObject({
      tone: "disabled",
      title: "Excluded from product sitemap",
    });
    expect(diagnostics.feed).toMatchObject({
      tone: "disabled",
      inclusion: "skipped",
      skippedReason: "Product feed exclusion is on.",
    });
    expect(diagnostics.structuredData.title).toBe(
      "Product + Breadcrumb JSON-LD on",
    );
  });

  it("treats product noindex as public but not search-discoverable", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: {
        ...activeProduct,
        noIndex: true,
      },
      variants: availableSimpleSku,
      variantState: "loaded",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: "https://shop.example.com",
    });

    expect(diagnostics.canonical).toMatchObject({
      tone: "ok",
      path: "/products/green-tea",
    });
    expect(diagnostics.sitemap).toMatchObject({
      tone: "disabled",
      title: "Noindexed",
    });
    expect(diagnostics.structuredData).toMatchObject({
      tone: "disabled",
      title: "JSON-LD off while noindexed",
      productsEnabled: false,
      breadcrumbsEnabled: false,
    });
  });

  it("honors sold-out inclusion policy for the product feed", () => {
    const soldOutSku = [
      {
        id: "var_default_prod_1",
        isDefault: true,
        stock: 0,
        reservedStock: 0,
        trackInventory: true,
        deletedAt: null,
      },
    ];

    const excluded = buildProductSeoDiagnostics({
      product: activeProduct,
      variants: soldOutSku,
      variantState: "loaded",
      discovery: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS,
        feeds: {
          ...DEFAULT_SEO_DISCOVERY_SETTINGS.feeds,
          includeUnavailableProducts: false,
        },
      },
      storefrontUrl: "https://shop.example.com",
    });

    expect(excluded.availability.state).toBe("sold_out");
    expect(excluded.feed).toMatchObject({
      title: "Skipped while sold out",
      inclusion: "skipped",
      skippedReason: "Sold-out products are excluded.",
    });

    const included = buildProductSeoDiagnostics({
      product: activeProduct,
      variants: soldOutSku,
      variantState: "loaded",
      discovery: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS,
        feeds: {
          ...DEFAULT_SEO_DISCOVERY_SETTINGS.feeds,
          includeUnavailableProducts: true,
        },
      },
      storefrontUrl: "https://shop.example.com",
    });

    expect(included.feed).toMatchObject({
      title: "Included as out of stock",
      inclusion: "included",
      skippedReason: null,
    });
  });

  it("flags products without a buyer-resolvable SKU as not discoverable", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: activeProduct,
      variants: [
        {
          id: "var_orphan",
          isDefault: false,
          optionCombinationKey: null,
          stock: 10,
          reservedStock: 0,
          trackInventory: true,
          deletedAt: null,
        },
      ],
      variantState: "loaded",
      discovery: DEFAULT_SEO_DISCOVERY_SETTINGS,
      storefrontUrl: "https://shop.example.com",
    });

    expect(diagnostics.availability).toMatchObject({
      state: "not_resolvable",
      canResolveBuyerSku: false,
    });
    expect(diagnostics.sitemap.title).toBe("Sitemap waits for SKU");
    expect(diagnostics.feed.skippedReason).toBe("No buyer-resolvable SKU.");
  });

  it("surfaces global Product and Breadcrumb JSON-LD switches", () => {
    const diagnostics = buildProductSeoDiagnostics({
      product: activeProduct,
      variants: availableSimpleSku,
      variantState: "loaded",
      discovery: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS,
        structuredData: {
          ...DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData,
          breadcrumbs: false,
        },
      },
      storefrontUrl: "https://shop.example.com",
    });

    expect(diagnostics.structuredData).toMatchObject({
      tone: "info",
      title: "Partial product JSON-LD on",
      productsEnabled: true,
      breadcrumbsEnabled: false,
    });
    expect(diagnostics.structuredData.summary).toContain("Breadcrumbs off");
  });
});
