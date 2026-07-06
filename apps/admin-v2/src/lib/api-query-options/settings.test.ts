import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-functions/settings", () => ({
  getAuthSettings: vi.fn(),
  getCheckoutReadiness: vi.fn(),
  getFirebaseSettings: vi.fn(),
  getGeneralSettings: vi.fn(),
  getMetaConversionsLogs: vi.fn(),
  getMetaConversionsSettings: vi.fn(),
  getPaymentMethods: vi.fn(),
  getSeoSettings: vi.fn(),
  getThemeSettings: vi.fn(),
}));
vi.mock("./currency", () => ({
  currencySettingsQueryOptions: vi.fn(),
}));
vi.mock("./storefront-url", () => ({
  storefrontUrlQueryOptions: vi.fn(),
}));

import { getSeoSettings } from "../api-functions/settings";
import { checkoutReadinessQueryOptions, seoSettingsQueryOptions } from "./settings";

function requireQueryFn(options: ReturnType<typeof checkoutReadinessQueryOptions>) {
  if (typeof options.queryFn !== "function") {
    throw new Error("Expected checkout readiness queryFn to be configured");
  }
  return options.queryFn;
}

describe("checkoutReadinessQueryOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads checkout readiness through the admin browser proxy", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            ready: true,
            hasActiveShippingMethod: true,
            hasActiveDeliveryHierarchy: true,
            issues: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const options = checkoutReadinessQueryOptions();
    const result = await requireQueryFn(options)({} as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/settings/checkout-readiness",
      {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );
    expect(result).toEqual({
      ready: true,
      hasActiveShippingMethod: true,
      hasActiveDeliveryHierarchy: true,
      issues: [],
    });
  });

  it("surfaces admin proxy errors in the readiness panel", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Admin access required.",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const options = checkoutReadinessQueryOptions();

    await expect(requireQueryFn(options)({} as never)).rejects.toThrow(
      "Admin access required.",
    );
  });
});

describe("seoSettingsQueryOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes discovery settings for shared dashboard cache consumers", async () => {
    vi.mocked(getSeoSettings).mockResolvedValue({
      siteTitle: "Scalius",
      homepageTitle: "",
      homepageMetaDescription: "Find tea",
      robotsTxt: null,
      discovery: {
        sitemap: { enabled: false },
        feeds: { productCatalogEnabled: false, title: "  Feed title  " },
        structuredData: { breadcrumbs: false },
      },
    } as never);

    const options = seoSettingsQueryOptions();
    if (typeof options.queryFn !== "function") {
      throw new Error("Expected SEO settings queryFn to be configured");
    }

    const result = await options.queryFn({} as never);

    expect(result).toMatchObject({
      siteTitle: "Scalius",
      homepageTitle: "",
      homepageMetaDescription: "Find tea",
      robotsTxt: "User-agent: *\nAllow: /\n\nSitemap: [your-sitemap-url]",
      discovery: {
        sitemap: {
          enabled: false,
          products: true,
          staticPages: true,
        },
        feeds: {
          productCatalogEnabled: false,
          includeUnavailableProducts: true,
          variantStrategy: "variants",
          title: "Feed title",
        },
        structuredData: {
          products: true,
          productGroups: true,
          offerShippingDetails: true,
          breadcrumbs: false,
        },
      },
    });
  });
});
