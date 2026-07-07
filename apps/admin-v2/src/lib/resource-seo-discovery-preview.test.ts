import { describe, expect, it } from "vitest";
import { buildResourceDiscoveryPreview } from "./resource-seo-discovery-preview";

const storefrontUrl = "https://storefront.example.test";

function discovery(overrides: Record<string, unknown> = {}) {
  return {
    sitemap: {
      enabled: true,
      staticPages: true,
      products: true,
      categories: true,
      collections: true,
      pages: true,
      ...(overrides.sitemap as Record<string, unknown> | undefined),
    },
    feeds: {
      productCatalogEnabled: true,
      includeUnavailableProducts: true,
      variantStrategy: "variants",
      title: "",
      description: "",
    },
    robots: {
      advertiseSitemap: true,
    },
    structuredData: {
      organization: true,
      websiteSearch: true,
      products: true,
      productGroups: true,
      offerShippingDetails: true,
      breadcrumbs: true,
      collections: true,
      ...(overrides.structuredData as Record<string, unknown> | undefined),
    },
  };
}

describe("buildResourceDiscoveryPreview", () => {
  it("previews category canonical, sitemap, and JSON-LD readiness", () => {
    const preview = buildResourceDiscoveryPreview({
      kind: "category",
      slug: "summer-shoes",
      discovery: discovery(),
      storefrontUrl,
    });

    expect(preview.canonical).toMatchObject({
      tone: "ok",
      path: "/categories/summer-shoes",
      url: "https://storefront.example.test/categories/summer-shoes",
    });
    expect(preview.sitemap).toMatchObject({
      tone: "ok",
      value: "/sitemap-categories.xml",
    });
    expect(preview.structuredData).toMatchObject({
      tone: "ok",
      title: "CollectionPage + Breadcrumb JSON-LD on",
    });
  });

  it("shows noindex as public but removed from XML/schema discovery", () => {
    const preview = buildResourceDiscoveryPreview({
      kind: "category",
      slug: "landing-copy",
      noIndex: true,
      discovery: discovery(),
      storefrontUrl,
    });

    expect(preview.sitemap).toMatchObject({
      tone: "disabled",
      title: "Noindexed",
    });
    expect(preview.sitemap.summary).toContain("stays public");
    expect(preview.structuredData).toMatchObject({
      tone: "disabled",
      title: "JSON-LD off while noindexed",
    });
  });

  it("marks disabled sitemap sections as off without implying the page is hidden", () => {
    const preview = buildResourceDiscoveryPreview({
      kind: "collection",
      id: "featured",
      isActive: true,
      discovery: discovery({ sitemap: { collections: false } }),
      storefrontUrl,
    });

    expect(preview.sitemap).toMatchObject({
      tone: "disabled",
      title: "Collections sitemap off",
    });
    expect(preview.canonical).toMatchObject({
      tone: "ok",
      path: "/collections/featured",
    });
  });

  it("keeps CMS page schema copy honest", () => {
    const preview = buildResourceDiscoveryPreview({
      kind: "page",
      slug: "returns",
      isPublished: true,
      discovery: discovery(),
      storefrontUrl,
    });

    expect(preview.sitemap).toMatchObject({
      tone: "ok",
      value: "/sitemap-pages.xml",
    });
    expect(preview.structuredData).toMatchObject({
      tone: "info",
      title: "No page JSON-LD emitted",
    });
  });

  it("fails canonical previews closed on invalid override paths", () => {
    const preview = buildResourceDiscoveryPreview({
      kind: "page",
      slug: "returns",
      canonicalPath: "https://external.example.test/returns",
      isPublished: true,
      discovery: discovery(),
      storefrontUrl,
    });

    expect(preview.canonical).toMatchObject({
      tone: "warning",
      title: "Canonical path needs cleanup",
      path: null,
      url: null,
    });
    expect(preview.sitemap).toMatchObject({
      tone: "draft",
      title: "Sitemap pending",
    });
  });

  it("fails canonical previews closed on non-routable override paths", () => {
    const preview = buildResourceDiscoveryPreview({
      kind: "category",
      slug: "summer-shoes",
      canonicalPath: "/shop/summer-shoes",
      discovery: discovery(),
      storefrontUrl,
    });

    expect(preview.canonical).toMatchObject({
      tone: "warning",
      title: "Canonical path needs cleanup",
      path: null,
      url: null,
    });
    expect(preview.sitemap).toMatchObject({
      tone: "draft",
      title: "Sitemap pending",
    });
  });

  it("fails collection canonical preview when the override is not the saved ID route", () => {
    const preview = buildResourceDiscoveryPreview({
      kind: "collection",
      id: "V1StGXR8_Z5jdHi6B-myT",
      canonicalPath: "/collections/Z9StGXR8_Z5jdHi6B-myT",
      isActive: true,
      discovery: discovery(),
      storefrontUrl,
    });

    expect(preview.canonical).toMatchObject({
      tone: "warning",
      title: "Canonical path needs cleanup",
      path: null,
      url: null,
    });
    expect(preview.canonical.summary).toContain("served by ID");
    expect(preview.sitemap).toMatchObject({
      tone: "draft",
      title: "Sitemap pending",
    });
  });
});
