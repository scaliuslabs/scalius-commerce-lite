// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SEO_DISCOVERY_SETTINGS } from "@scalius/shared/seo-discovery";

import { SeoDiscoveryStatusCard } from "./SeoDiscoveryStatusCard";
import { normalizeSeoDiscoverySettingsWithReturnPolicy } from "../../lib/seo-discovery-status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const storefrontUrlState = vi.hoisted(() => ({
  storefrontUrl: "https://shop.example.com" as string | null,
  isLoading: false,
  error: null as Error | null,
}));
const liveProbeState = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isFetching: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));
const feedDiagnosticsState = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isFetching: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));

vi.mock("../../hooks/use-storefront-url", () => ({
  useStorefrontUrl: () => storefrontUrlState,
}));
vi.mock("../../lib/api-query-options/seo-discovery-live-probe", () => ({
  seoDiscoveryLiveProbeQueryOptions: () => ({
    queryKey: ["settings", "seo-discovery-live-probe"],
    queryFn: vi.fn(),
  }),
}));
vi.mock("../../lib/api-query-options/seo-feed-diagnostics", () => ({
  seoFeedDiagnosticsQueryOptions: () => ({
    queryKey: ["settings", "seo-feed-diagnostics"],
    queryFn: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey?: readonly unknown[] }) =>
    options.queryKey?.includes("seo-feed-diagnostics")
      ? feedDiagnosticsState
      : liveProbeState,
}));

function createHealthyLiveProbe() {
  return {
    baseUrl: "https://shop.example.com/",
    checkedAt: "2026-07-06T00:00:00.000Z",
    ok: true,
    resources: [
      {
        key: "robots",
        kind: "robots",
        label: "robots.txt",
        path: "/robots.txt",
        href: "https://shop.example.com/robots.txt",
        ok: true,
        status: 200,
        contentType: "text/plain",
        cacheControl: "public, max-age=300",
        counts: { robotsSitemapLines: 1 },
        expectedRobotsSitemapLines: 1,
      },
      {
        key: "sitemap",
        kind: "sitemap",
        label: "Sitemap index",
        path: "/sitemap.xml",
        href: "https://shop.example.com/sitemap.xml",
        ok: true,
        status: 200,
        contentType: "application/xml",
        cacheControl: "public, max-age=600",
        counts: { sitemapLocs: 5 },
        minimumSitemapLocs: 5,
      },
      {
        key: "productFeed",
        kind: "feed",
        label: "Product feed",
        path: "/api/product-feed.xml?limit=5",
        href: "https://shop.example.com/api/product-feed.xml?limit=5",
        ok: true,
        status: 200,
        contentType: "application/rss+xml",
        cacheControl: "public, max-age=600",
        counts: {
          feedItems: 1,
          feedLinks: 1,
          absoluteFeedLinks: 1,
          imageLinks: 1,
          absoluteImageLinks: 1,
          availabilityValues: 1,
        },
      },
      {
        key: "facebookFeed",
        kind: "feed",
        label: "Facebook feed",
        path: "/api/facebook-feed.xml?limit=5",
        href: "https://shop.example.com/api/facebook-feed.xml?limit=5",
        ok: true,
        status: 200,
        contentType: "application/rss+xml",
        cacheControl: "public, max-age=600",
        counts: {
          feedItems: 1,
          feedLinks: 1,
          absoluteFeedLinks: 1,
          imageLinks: 1,
          absoluteImageLinks: 1,
          availabilityValues: 1,
        },
      },
      {
        key: "ucpProfile",
        kind: "ucpProfile",
        label: "UCP catalog profile",
        path: "/.well-known/ucp",
        href: "https://shop.example.com/.well-known/ucp",
        ok: true,
        status: 200,
        contentType: "application/json; charset=utf-8",
        cacheControl: "public, max-age=300",
        counts: {
          ucpValidJson: 1,
          ucpVersion: "2026-04-08",
          ucpShoppingRestServices: 1,
          ucpCatalogCapabilities: 2,
          ucpForbiddenCapabilities: 0,
          ucpPaymentHandlers: 0,
        },
      },
      {
        key: "staticPagesSitemap",
        kind: "sitemapChild",
        label: "Home + search sitemap",
        path: "/sitemap-static.xml",
        href: "https://shop.example.com/sitemap-static.xml",
        ok: true,
        status: 200,
        contentType: "application/xml",
        cacheControl: "public, max-age=600",
        counts: { sitemapLocs: 2 },
        minimumSitemapLocs: 1,
      },
      {
        key: "productsSitemap",
        kind: "sitemapChild",
        label: "Products sitemap",
        path: "/sitemap-products.xml?page=1",
        href: "https://shop.example.com/sitemap-products.xml?page=1",
        ok: true,
        status: 200,
        contentType: "application/xml",
        cacheControl: "public, max-age=600",
        counts: { sitemapLocs: 1 },
        minimumSitemapLocs: 0,
      },
      {
        key: "categoriesSitemap",
        kind: "sitemapChild",
        label: "Categories sitemap",
        path: "/sitemap-categories.xml",
        href: "https://shop.example.com/sitemap-categories.xml",
        ok: true,
        status: 200,
        contentType: "application/xml",
        cacheControl: "public, max-age=600",
        counts: { sitemapLocs: 1 },
        minimumSitemapLocs: 0,
      },
      {
        key: "collectionsSitemap",
        kind: "sitemapChild",
        label: "Collections sitemap",
        path: "/sitemap-collections.xml",
        href: "https://shop.example.com/sitemap-collections.xml",
        ok: true,
        status: 200,
        contentType: "application/xml",
        cacheControl: "public, max-age=600",
        counts: { sitemapLocs: 1 },
        minimumSitemapLocs: 0,
      },
      {
        key: "pagesSitemap",
        kind: "sitemapChild",
        label: "Pages sitemap",
        path: "/sitemap-pages.xml",
        href: "https://shop.example.com/sitemap-pages.xml",
        ok: true,
        status: 200,
        contentType: "application/xml",
        cacheControl: "public, max-age=600",
        counts: { sitemapLocs: 1 },
        minimumSitemapLocs: 0,
      },
    ],
  };
}

function createHealthyFeedDiagnostics() {
  return {
    policy: {
      productCatalogEnabled: true,
      includeUnavailableProducts: false,
      variantStrategy: "variants",
    },
    scan: {
      limit: 500,
      scannedProducts: 12,
      truncated: false,
      sampleLimitPerReason: 5,
    },
    totals: {
      emittedRows: 11,
      emittedProductRows: 3,
      emittedVariantRows: 8,
      productsWithIssues: 0,
      skippedRows: 0,
    },
    reasons: [
      {
        reason: "feed_disabled",
        products: 0,
        rows: 0,
        samples: [],
      },
      {
        reason: "storefront_url_unavailable",
        products: 0,
        rows: 0,
        samples: [],
      },
      {
        reason: "product_feed_excluded",
        products: 0,
        rows: 0,
        samples: [],
      },
      {
        reason: "inactive_deleted_unpublished",
        products: 0,
        rows: 0,
        samples: [],
      },
      {
        reason: "inconsistent_option_axes",
        products: 0,
        rows: 0,
        samples: [],
      },
      {
        reason: "no_buyer_sku",
        products: 0,
        rows: 0,
        samples: [],
      },
      {
        reason: "non_positive_price",
        products: 0,
        rows: 0,
        samples: [],
      },
      {
        reason: "missing_image",
        products: 0,
        rows: 0,
        samples: [],
      },
      {
        reason: "unavailable_excluded",
        products: 0,
        rows: 0,
        samples: [],
      },
    ],
  };
}

function createWarningFeedDiagnostics() {
  const result = createHealthyFeedDiagnostics();
  return {
    ...result,
    scan: {
      ...result.scan,
      truncated: true,
    },
    totals: {
      emittedRows: 9,
      emittedProductRows: 3,
      emittedVariantRows: 6,
      productsWithIssues: 2,
      skippedRows: 2,
    },
    reasons: result.reasons.map((reason) =>
      reason.reason === "missing_image"
        ? {
            reason: "missing_image",
            products: 2,
            rows: 2,
            samples: [
              {
                id: "prod_1",
                name: "No Photo Tee",
                slug: "no-photo-tee",
                reason: "missing_image",
              },
            ],
          }
        : reason,
    ),
  };
}

describe("SeoDiscoveryStatusCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    storefrontUrlState.storefrontUrl = "https://shop.example.com";
    storefrontUrlState.isLoading = false;
    storefrontUrlState.error = null;
    liveProbeState.data = createHealthyLiveProbe();
    liveProbeState.isLoading = false;
    liveProbeState.isFetching = false;
    liveProbeState.error = null;
    liveProbeState.refetch = vi.fn();
    feedDiagnosticsState.data = createHealthyFeedDiagnostics();
    feedDiagnosticsState.isLoading = false;
    feedDiagnosticsState.isFetching = false;
    feedDiagnosticsState.error = null;
    feedDiagnosticsState.refetch = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  function renderCard(
    robotsTxt = "User-agent: *\nAllow: /",
    discovery: unknown = DEFAULT_SEO_DISCOVERY_SETTINGS,
  ) {
    act(() => {
      root.render(
        <SeoDiscoveryStatusCard
          discovery={normalizeSeoDiscoverySettingsWithReturnPolicy(discovery)}
          robotsTxt={robotsTxt}
          businessIdentity={{ companyName: "Scalius Mart", legalName: "" }}
          hasStoreLogo
        />,
      );
    });
  }

  it("renders dashboard preview links only for an absolute Store URL", () => {
    renderCard();

    const links = Array.from(host.querySelectorAll("a")).map((link) =>
      link.getAttribute("href"),
    );

    expect(host.textContent).toContain("Public discovery outcome");
    expect(host.textContent).toContain(
      "Preview current edits and inspect published discovery files.",
    );
    expect(host.textContent).toContain("Output mode: SKU / variant rows");
    expect(host.textContent).toContain(
      "This is a dashboard preview, not a live probe of the storefront Worker env.",
    );
    expect(host.textContent).toContain("Live proof complete");
    expect(host.textContent).toContain("Catalog diagnostics");
    expect(host.textContent).toContain("Rows ready: 11");
    expect(host.textContent).toContain("OnlineStore ready");
    expect(host.textContent).toContain("WebSite SearchAction ready");
    expect(host.textContent).toContain("MerchantReturnPolicy off");
    expect(host.textContent).toContain(
      "That is valid when a public policy is disabled or still incomplete.",
    );
    expect(host.textContent).toContain("Product page schema ready");
    expect(host.textContent).toContain("Category/collection schema ready");
    expect(host.textContent).toContain("No feed blockers found");
    expect(host.textContent).toContain("UCP catalog discovery on");
    expect(host.textContent).toContain(
      "Shopping agents can discover read-only catalog search and lookup.",
    );
    expect(host.textContent).toContain("No checkout/payment");
    expect(host.textContent).toContain(
      "version 2026-04-08; 1 REST service; 2 catalog capabilities; 0 gated capabilities",
    );
    expect(host.textContent).toContain("1/1 Sitemap line");
    expect(host.textContent).toContain("Home + search sitemap");
    expect(host.textContent).toContain(
      "1 item; 1 link; 1 image_link; 1 availability",
    );
    expect(links).toEqual([
      "https://shop.example.com/.well-known/ucp",
      "https://shop.example.com/robots.txt",
      "https://shop.example.com/sitemap.xml",
      "https://shop.example.com/api/product-feed.xml",
    ]);
  });

  it("does not render broken external links for relative Store URLs", () => {
    storefrontUrlState.storefrontUrl = "/local-store";

    renderCard();

    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain("Path-only preview");
    expect(host.textContent).toContain("Sitemap needs Store URL");
    expect(host.textContent).toContain("Product feed needs Store URL");
    expect(host.textContent).toContain("robots.txt needs Store URL");
    expect(host.textContent).toContain("UCP catalog needs HTTPS Store URL");
    expect(host.textContent).toContain("/sitemap.xml");
    expect(host.textContent).toContain("/.well-known/ucp");
    expect(host.textContent).toContain(
      "Live proof waits for an absolute http(s) Store URL.",
    );
  });

  it("does not warn about robots Store URL when sitemap advertising is off", () => {
    const discovery = {
      ...DEFAULT_SEO_DISCOVERY_SETTINGS,
      robots: { advertiseSitemap: false },
    };

    for (const storefrontUrl of [null, "/local-store"]) {
      storefrontUrlState.storefrontUrl = storefrontUrl;
      renderCard("User-agent: *\nAllow: /", discovery);

      expect(host.textContent).toContain("robots.txt sitemap not advertised");
      expect(host.textContent).toContain(
        "Runtime strips all Sitemap directives and advertises no sitemap.",
      );
      expect(host.textContent).not.toContain("robots.txt needs Store URL");
    }
  });

  it("does not say robots advertises a sitemap when sitemap generation is off", () => {
    renderCard("User-agent: *\nAllow: /", {
      ...DEFAULT_SEO_DISCOVERY_SETTINGS,
      sitemap: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap,
        enabled: false,
      },
      robots: { advertiseSitemap: true },
    });

    expect(host.textContent).toContain("robots.txt sitemap not advertised");
    expect(host.textContent).toContain(
      "Sitemap index is off, so runtime advertises no sitemap.",
    );
    expect(host.textContent).not.toContain(
      "robots.txt advertises canonical sitemap",
    );
  });

  it("warns that public UCP discovery requires HTTPS even when the Store URL is absolute HTTP", () => {
    storefrontUrlState.storefrontUrl = "http://shop.example.com";
    const result = createHealthyLiveProbe();
    liveProbeState.data = {
      ...result,
      baseUrl: "http://shop.example.com/",
      resources: result.resources.map((resource) =>
        resource.key === "ucpProfile"
          ? {
              ...resource,
              href: "http://shop.example.com/.well-known/ucp",
              ok: true,
              status: null,
              contentType: null,
              cacheControl: null,
              counts: {},
              disabledReason:
                "UCP public discovery requires an HTTPS Store URL, so this catalog profile check is skipped.",
            }
          : resource,
      ),
    };

    renderCard();

    expect(host.textContent).toContain("UCP catalog needs HTTPS Store URL");
    expect(host.textContent).toContain(
      "UCP public discovery requires an HTTPS Store URL.",
    );
    expect(host.textContent).toContain(
      "UCP public discovery requires an HTTPS Store URL, so this catalog profile check is skipped.",
    );
    expect(host.textContent).toContain("Skipped by policy");
  });

  it("warns when live feed proof counts are incomplete", () => {
    const result = createHealthyLiveProbe();
    liveProbeState.data = {
      ...result,
      ok: true,
      resources: result.resources.map((resource) =>
        resource.key === "productFeed"
          ? {
              ...resource,
              ok: true,
              counts: {
                feedItems: 2,
                feedLinks: 2,
                absoluteFeedLinks: 2,
                imageLinks: 1,
                absoluteImageLinks: 1,
                availabilityValues: 1,
              },
            }
          : resource,
      ),
    };

    renderCard();

    expect(host.textContent).toContain("Live proof needs review");
    expect(host.textContent).toContain(
      "Missing feed fields: 1/2 image_link, 1/2 availability.",
    );
  });

  it("surfaces missing business identity schema warnings", () => {
    act(() => {
      root.render(
        <SeoDiscoveryStatusCard
          discovery={normalizeSeoDiscoverySettingsWithReturnPolicy(
            DEFAULT_SEO_DISCOVERY_SETTINGS,
          )}
          robotsTxt="User-agent: *\nAllow: /"
          businessIdentity={{ companyName: "", legalName: "" }}
        />,
      );
    });

    expect(host.textContent).toContain("Structured data needs review");
    expect(host.textContent).toContain(
      "Add a company name or legal name in Business settings",
    );
    expect(host.textContent).toContain(
      "BreadcrumbList and CollectionPage are separate controls",
    );
  });

  it("surfaces custom robots sitemap line warnings", () => {
    renderCard(
      "User-agent: *\nAllow: /\nSitemap: https://old.example.com/sitemap.xml",
    );

    expect(host.textContent).toContain(
      "Saved custom Sitemap lines are ignored; runtime strips or replaces them with the canonical current sitemap.",
    );
  });

  it("keeps editing available when Store URL preview fails to load", () => {
    storefrontUrlState.storefrontUrl = null;
    storefrontUrlState.error = new Error("Failed to load");

    renderCard();

    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain(
      "Store URL preview failed to load; editing remains available.",
    );
  });

  it("refreshes live proof on Retry", () => {
    renderCard();

    const retry = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry"),
    );
    expect(retry).toBeTruthy();

    act(() => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(liveProbeState.refetch).toHaveBeenCalledTimes(1);
  });

  it("renders aggregate feed diagnostic blockers with samples", () => {
    feedDiagnosticsState.data = createWarningFeedDiagnostics();

    renderCard();

    expect(host.textContent).toContain("Catalog needs attention");
    expect(host.textContent).toContain("Products to fix: 2");
    expect(host.textContent).toContain("Missing primary image");
    expect(host.textContent).toContain("Sample: No Photo Tee");
    const sampleLink = host.querySelector<HTMLAnchorElement>(
      'a[href="/admin/products/prod_1/edit"]',
    );
    expect(sampleLink?.textContent).toBe("No Photo Tee");
    expect(host.textContent).toContain(
      "More products exist outside this bounded scan.",
    );
  });

  it("refreshes feed diagnostics separately from the live proof", () => {
    renderCard();

    const refresh = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Refresh"),
    );
    expect(refresh).toBeTruthy();

    act(() => {
      refresh?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(feedDiagnosticsState.refetch).toHaveBeenCalledTimes(1);
    expect(liveProbeState.refetch).not.toHaveBeenCalled();
  });

  it("renders live probe loading and server-function error states", () => {
    liveProbeState.data = undefined;
    liveProbeState.isLoading = true;
    liveProbeState.isFetching = true;

    renderCard();

    expect(host.textContent).toContain("Checking live discovery files");

    act(() => {
      root.unmount();
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    liveProbeState.isLoading = false;
    liveProbeState.isFetching = false;
    liveProbeState.error = new Error("Admin access required.");

    renderCard();

    expect(host.textContent).toContain("Live proof needs review");
    expect(host.textContent).toContain("Admin access required.");
  });

  it("renders feed diagnostics loading and error states", () => {
    feedDiagnosticsState.data = undefined;
    feedDiagnosticsState.isLoading = true;
    feedDiagnosticsState.isFetching = true;

    renderCard();

    expect(host.textContent).toContain("Scanning catalog");

    act(() => {
      root.unmount();
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    feedDiagnosticsState.isLoading = false;
    feedDiagnosticsState.isFetching = false;
    feedDiagnosticsState.error = new Error("Admin access required.");

    renderCard();

    expect(host.textContent).toContain("Catalog needs attention");
    expect(host.textContent).toContain("Admin access required.");
  });

  it("warns when return policy is enabled without OnlineStore or Product targets", () => {
    renderCard("User-agent: *\nAllow: /", {
      ...DEFAULT_SEO_DISCOVERY_SETTINGS,
      structuredData: {
        organization: false,
        websiteSearch: false,
        products: false,
        productGroups: false,
        offerShippingDetails: false,
        breadcrumbs: false,
        collections: false,
      },
      returnPolicy: {
        enabled: true,
        country: "BD",
        category: "finite",
        returnWindowDays: 7,
        returnFees: "customer_responsibility",
        returnMethod: "mail",
        policyUrl: "/returns",
      },
    });

    expect(host.textContent).toContain(
      "Return policy facts are saved but will not emit until Organization or Product schema is enabled.",
    );
    expect(host.textContent).toContain("MerchantReturnPolicy waiting");
    expect(host.textContent).toContain(
      "they only emit through OnlineStore or Product offer schema",
    );
  });

  it("names the return policy schema targets when Organization and Product schema are on", () => {
    renderCard("User-agent: *\nAllow: /", {
      ...DEFAULT_SEO_DISCOVERY_SETTINGS,
      structuredData: {
        ...DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData,
        organization: true,
        products: true,
      },
      returnPolicy: {
        enabled: true,
        country: "BD",
        category: "finite",
        returnWindowDays: 7,
        returnFees: "customer_responsibility",
        returnMethod: "mail",
        policyUrl: "/returns",
      },
    });

    expect(host.textContent).toContain(
      "Return policy can emit through OnlineStore and Product offers; normal schema prerequisites still apply.",
    );
    expect(host.textContent).toContain("MerchantReturnPolicy ready");
    expect(host.textContent).toContain(
      "Can attach through OnlineStore and Product offers when those pages are public and schema is eligible.",
    );
  });
});
