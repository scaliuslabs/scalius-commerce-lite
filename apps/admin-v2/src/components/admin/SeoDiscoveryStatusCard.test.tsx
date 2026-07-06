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
        label: "robots.txt",
        path: "/robots.txt",
        href: "https://shop.example.com/robots.txt",
        ok: true,
        status: 200,
        contentType: "text/plain",
        cacheControl: "public, max-age=300",
        counts: { robotsSitemapLines: 1 },
      },
      {
        key: "sitemap",
        label: "Sitemap index",
        path: "/sitemap.xml",
        href: "https://shop.example.com/sitemap.xml",
        ok: true,
        status: 200,
        contentType: "application/xml",
        cacheControl: "public, max-age=600",
        counts: { sitemapLocs: 1 },
      },
      {
        key: "productFeed",
        label: "Product feed",
        path: "/api/product-feed.xml?limit=5",
        href: "https://shop.example.com/api/product-feed.xml?limit=5",
        ok: true,
        status: 200,
        contentType: "application/rss+xml",
        cacheControl: "public, max-age=600",
        counts: { feedItems: 1, imageLinks: 1, availabilityValues: 1 },
      },
      {
        key: "facebookFeed",
        label: "Facebook feed",
        path: "/api/facebook-feed.xml?limit=5",
        href: "https://shop.example.com/api/facebook-feed.xml?limit=5",
        ok: true,
        status: 200,
        contentType: "application/rss+xml",
        cacheControl: "public, max-age=600",
        counts: { feedItems: 1, imageLinks: 1, availabilityValues: 1 },
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
        reason: "inactive_deleted_unpublished",
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

  function renderCard(robotsTxt = "User-agent: *\nAllow: /") {
    act(() => {
      root.render(
        <SeoDiscoveryStatusCard
          discovery={normalizeSeoDiscoverySettingsWithReturnPolicy(
            DEFAULT_SEO_DISCOVERY_SETTINGS,
          )}
          robotsTxt={robotsTxt}
        />,
      );
    });
  }

  it("renders dashboard preview links only for an absolute Store URL", () => {
    renderCard();

    const links = Array.from(host.querySelectorAll("a")).map((link) =>
      link.getAttribute("href"),
    );

    expect(host.textContent).toContain("Discovery Status / QA");
    expect(host.textContent).toContain("Output mode: SKU / variant rows");
    expect(host.textContent).toContain(
      "This is a dashboard preview, not a live probe of the storefront Worker env.",
    );
    expect(host.textContent).toContain("Live proof complete");
    expect(host.textContent).toContain("Catalog diagnostics");
    expect(host.textContent).toContain("Rows ready: 11");
    expect(host.textContent).toContain("No feed blockers found");
    expect(host.textContent).toContain("1 Sitemap line");
    expect(host.textContent).toContain("1 item; 1 image_link; 1 availability");
    expect(links).toEqual([
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
    expect(host.textContent).toContain("/sitemap.xml");
    expect(host.textContent).toContain(
      "Live proof waits for an absolute http(s) Store URL.",
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
});
