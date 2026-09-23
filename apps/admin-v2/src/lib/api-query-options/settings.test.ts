import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminSettingsCheckoutReadiness: vi.fn(),
  getApiV1AdminSettingsSeo: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("./currency", () => ({
  currencySettingsQueryOptions: vi.fn(),
}));
vi.mock("./storefront-url", () => ({
  storefrontUrlQueryOptions: vi.fn(),
}));

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
  });

  it("returns the readiness payload from the API envelope", async () => {
    sdk.getApiV1AdminSettingsCheckoutReadiness.mockResolvedValue({
      data: {
        success: true,
        data: {
          status: "ready",
          hasActiveShippingMethod: true,
          hasActiveDeliveryHierarchy: true,
          issues: [],
        },
      },
      response: new Response(null, { status: 200 }),
    });

    const result = await requireQueryFn(checkoutReadinessQueryOptions())({} as never);

    expect(result).toEqual({
      status: "ready",
      hasActiveShippingMethod: true,
      hasActiveDeliveryHierarchy: true,
      issues: [],
    });
  });

  it("surfaces admin proxy errors in the readiness panel", async () => {
    sdk.getApiV1AdminSettingsCheckoutReadiness.mockResolvedValue({
      error: {
        success: false,
        error: { code: "UNAUTHORIZED", message: "Admin access required." },
      },
      response: new Response(null, { status: 401 }),
    });

    await expect(
      requireQueryFn(checkoutReadinessQueryOptions())({} as never),
    ).rejects.toMatchObject({ message: "Admin access required.", status: 401 });
  });
});

describe("seoSettingsQueryOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes discovery settings for shared dashboard cache consumers", async () => {
    sdk.getApiV1AdminSettingsSeo.mockResolvedValue({ data: { success: true, data: {
      siteTitle: "Scalius",
      homepageTitle: "",
      homepageMetaDescription: "Find tea",
      robotsTxt: null,
      discovery: {
        sitemap: { enabled: false },
        feeds: { productCatalogEnabled: false, title: "  Feed title  " },
        structuredData: { breadcrumbs: false },
        returnPolicy: {
          enabled: true,
          country: "us",
          category: "unlimited",
          returnWindowDays: 30,
          returnFees: "free",
          returnMethod: "in_store",
          policyUrl: " https://shop.example.com/returns ",
        },
      },
    } } });

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
        returnPolicy: {
          enabled: true,
          country: "US",
          category: "unlimited",
          returnWindowDays: null,
          returnFees: "free",
          returnMethod: "in_store",
          policyUrl: "https://shop.example.com/returns",
        },
      },
    });
  });
});
