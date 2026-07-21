import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@scalius/core/errors";
import { DEFAULT_STOREFRONT_THEME_SETTINGS } from "@scalius/shared/storefront-theme";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getKv: vi.fn(),
  invalidateSiteSettingsCache: vi.fn(),
  invalidateStorefrontUrlCache: vi.fn(),
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  getCurrencySettings: vi.fn(),
  isCurrencyCodeLocked: vi.fn(),
  saveCurrencySettings: vi.fn(),
  getGeneralSettings: vi.fn(),
  saveHeaderConfig: vi.fn(),
  saveFooterConfig: vi.fn(),
  getThemeSettings: vi.fn(),
  saveThemeSettings: vi.fn(),
  getThemeWorkspace: vi.fn(),
  saveThemeDraft: vi.fn(),
  rebaseThemeDraft: vi.fn(),
  publishThemeDraft: vi.fn(),
  listThemeVersions: vi.fn(),
  rollbackThemeSettings: vi.fn(),
  createThemePreviewSession: vi.fn(),
  getMediaOptimizationSettings: vi.fn(),
  isValidMediaHostInput: vi.fn(),
  saveMediaOptimizationSettings: vi.fn(),
  getSeoSettings: vi.fn(),
  saveSeoSettings: vi.fn(),
  getProductFeedDiagnostics: vi.fn(),
  getStorefrontUrlSetting: vi.fn(),
  saveStorefrontUrl: vi.fn(),
  getHomepagePresentationSettings: vi.fn(),
  saveHomepagePresentationSettings: vi.fn(),
  getAllowedCountries: vi.fn(),
  saveAllowedCountries: vi.fn(),
}));

vi.mock("../../../utils/kv-cache", () => ({
  getKv: mocks.getKv,
}));

vi.mock("@scalius/core/modules/settings", () => ({
  invalidateSiteSettingsCache: mocks.invalidateSiteSettingsCache,
  invalidateStorefrontUrlCache: mocks.invalidateStorefrontUrlCache,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups:
    mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/core/modules/settings/site-settings.service", () => ({
  getCurrencySettings: mocks.getCurrencySettings,
  isCurrencyCodeLocked: mocks.isCurrencyCodeLocked,
  saveCurrencySettings: mocks.saveCurrencySettings,
  getGeneralSettings: mocks.getGeneralSettings,
  saveHeaderConfig: mocks.saveHeaderConfig,
  saveFooterConfig: mocks.saveFooterConfig,
  getThemeSettings: mocks.getThemeSettings,
  saveThemeSettings: mocks.saveThemeSettings,
  getThemeWorkspace: mocks.getThemeWorkspace,
  saveThemeDraft: mocks.saveThemeDraft,
  rebaseThemeDraft: mocks.rebaseThemeDraft,
  publishThemeDraft: mocks.publishThemeDraft,
  listThemeVersions: mocks.listThemeVersions,
  rollbackThemeSettings: mocks.rollbackThemeSettings,
  createThemePreviewSession: mocks.createThemePreviewSession,
  getMediaOptimizationSettings: mocks.getMediaOptimizationSettings,
  isValidMediaHostInput: mocks.isValidMediaHostInput,
  saveMediaOptimizationSettings: mocks.saveMediaOptimizationSettings,
  getSeoSettings: mocks.getSeoSettings,
  saveSeoSettings: mocks.saveSeoSettings,
  getStorefrontUrlSetting: mocks.getStorefrontUrlSetting,
  saveStorefrontUrl: mocks.saveStorefrontUrl,
  getHomepagePresentationSettings: mocks.getHomepagePresentationSettings,
  saveHomepagePresentationSettings: mocks.saveHomepagePresentationSettings,
  getAllowedCountries: mocks.getAllowedCountries,
  saveAllowedCountries: mocks.saveAllowedCountries,
}));

vi.mock("@scalius/core/modules/products", () => ({
  PRODUCT_FEED_DIAGNOSTIC_MAX_SAMPLE_LIMIT: 10,
  PRODUCT_FEED_DIAGNOSTIC_MAX_SCAN_LIMIT: 500,
  PRODUCT_FEED_DIAGNOSTIC_REASONS: [
    "feed_disabled",
    "storefront_url_unavailable",
    "product_feed_excluded",
    "inactive_deleted_unpublished",
    "inconsistent_option_axes",
    "no_buyer_sku",
    "non_positive_price",
    "missing_image",
    "unavailable_excluded",
  ],
  getProductFeedDiagnostics: mocks.getProductFeedDiagnostics,
}));

import { siteSettingsRoutes } from "./site";

function createTestApp() {
  const db = { id: "db" };
  const kv = { delete: vi.fn() };
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
    STOREFRONT_URL: "https://storefront.example.com",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.getKv.mockReturnValue(kv);
  mocks.invalidateSiteSettingsCache.mockResolvedValue(undefined);
  mocks.invalidateStorefrontUrlCache.mockResolvedValue(undefined);
  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
  mocks.getCurrencySettings.mockResolvedValue({
    currencyCode: "BDT",
    currencySymbol: "Tk",
    usdExchangeRate: "1",
  });
  mocks.isCurrencyCodeLocked.mockResolvedValue(false);
  mocks.saveCurrencySettings.mockResolvedValue(undefined);
  mocks.getGeneralSettings.mockResolvedValue({
    headerConfig: {},
    footerConfig: {},
    navigationReadiness: {
      header: { state: "ready" },
      footer: { state: "ready" },
    },
  });
  mocks.saveHeaderConfig.mockResolvedValue(undefined);
  mocks.saveFooterConfig.mockResolvedValue(undefined);
  mocks.getHomepagePresentationSettings.mockResolvedValue({
    config: {
      categoryRail: {
        enabled: false,
        title: "Shop by category",
        categoryIds: [],
      },
      trustStrip: { enabled: false },
    },
    revision: 1,
  });
  mocks.saveHomepagePresentationSettings.mockResolvedValue({
    config: {
      categoryRail: { enabled: true, title: "Browse", categoryIds: ["cat_1"] },
      trustStrip: { enabled: true },
    },
    revision: 2,
  });
  mocks.getThemeSettings.mockResolvedValue({
    theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
    revision: 1,
  });
  mocks.saveThemeSettings.mockResolvedValue({
    theme: {
      ...DEFAULT_STOREFRONT_THEME_SETTINGS,
      colors: { primary: "#000000" },
    },
    revision: 2,
  });
  const themeDraft = {
    theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
    revision: 2,
    basePublishedRevision: 1,
    updatedAt: new Date(1_000),
  };
  const themeWorkspace = {
    published: {
      theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
      revision: 1,
    },
    draft: themeDraft,
  };
  mocks.getThemeWorkspace.mockResolvedValue(themeWorkspace);
  mocks.saveThemeDraft.mockResolvedValue(themeDraft);
  mocks.rebaseThemeDraft.mockResolvedValue({
    ...themeDraft,
    revision: 3,
  });
  mocks.publishThemeDraft.mockResolvedValue({
    published: {
      theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
      revision: 2,
    },
    draft: {
      ...themeDraft,
      revision: 3,
      basePublishedRevision: 2,
    },
  });
  mocks.listThemeVersions.mockResolvedValue([]);
  mocks.rollbackThemeSettings.mockResolvedValue({
    published: {
      theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
      revision: 2,
    },
    draft: {
      ...themeDraft,
      revision: 3,
      basePublishedRevision: 2,
    },
  });
  mocks.createThemePreviewSession.mockResolvedValue({
    token: `tpv_${"a".repeat(48)}`,
    theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
    draftRevision: 2,
    basePublishedRevision: 1,
    expiresAt: new Date(Date.now() + 60_000),
  });
  mocks.isValidMediaHostInput.mockReturnValue(true);
  mocks.saveMediaOptimizationSettings.mockResolvedValue({
    enabled: true,
    canonicalCdnUrl: "cdn.example.com",
    allowedImageHosts: [],
    canonicalHostAliases: [],
  });
  mocks.getSeoSettings.mockResolvedValue({
    siteTitle: "Scalius",
    homepageTitle: "Scalius",
    homepageMetaDescription: "",
    robotsTxt: "",
    discovery: {
      sitemap: {
        enabled: true,
        staticPages: true,
        products: true,
        categories: true,
        collections: true,
        pages: true,
      },
      feeds: {
        productCatalogEnabled: true,
        includeUnavailableProducts: false,
        variantStrategy: "variants",
        title: "",
        description: "",
      },
      robots: { advertiseSitemap: true },
      structuredData: {
        organization: true,
        websiteSearch: true,
        products: true,
        productGroups: true,
        offerShippingDetails: true,
        breadcrumbs: true,
        collections: true,
      },
    },
    returnPolicy: {
      enabled: true,
      country: "BD",
      category: "finite",
      returnWindowDays: 14,
      returnFees: "customer_responsibility",
      returnMethod: "mail",
      policyUrl: "https://storefront.example.com/returns",
    },
  });
  mocks.getProductFeedDiagnostics.mockResolvedValue({
    policy: {
      productCatalogEnabled: true,
      includeUnavailableProducts: false,
      variantStrategy: "variants",
    },
    scan: {
      limit: 25,
      scannedProducts: 2,
      truncated: false,
      sampleLimitPerReason: 2,
    },
    totals: {
      emittedRows: 1,
      emittedProductRows: 0,
      emittedVariantRows: 1,
      productsWithIssues: 1,
      skippedRows: 1,
    },
    reasons: [
      {
        reason: "missing_image",
        products: 1,
        rows: 1,
        samples: [
          {
            id: "prod_1",
            name: "Missing image product",
            slug: "missing-image-product",
            reason: "missing_image",
          },
        ],
      },
    ],
  });
  mocks.saveSeoSettings.mockResolvedValue(undefined);
  mocks.getStorefrontUrlSetting.mockResolvedValue({
    storefrontUrl: "https://storefront.example.com",
  });
  mocks.saveStorefrontUrl.mockResolvedValue(undefined);
  mocks.saveAllowedCountries.mockResolvedValue({
    allowedCountries: ["BD"],
    allowedCountriesMode: "include",
  });

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/settings", siteSettingsRoutes);
  return { app, env, kv };
}

async function requestJson(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
) {
  return app.request(
    `/api/v1/admin/settings${path}`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("site settings cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fails SEO reads visibly instead of returning default-on settings", async () => {
    const { app, env } = createTestApp();
    mocks.getSeoSettings.mockRejectedValueOnce(new Error("D1 unavailable"));

    const response = await app.request(
      "/api/v1/admin/settings/seo",
      { method: "GET" },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false });
    expect(mocks.saveSeoSettings).not.toHaveBeenCalled();
  });

  it("fails general settings reads visibly instead of returning empty success", async () => {
    const { app, env } = createTestApp();
    mocks.getGeneralSettings.mockRejectedValueOnce(new Error("D1 unavailable"));

    const response = await app.request(
      "/api/v1/admin/settings/general",
      { method: "GET" },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false });
  });

  it("fails Store URL reads visibly instead of returning a relative fallback", async () => {
    const { app, env } = createTestApp();
    mocks.getStorefrontUrlSetting.mockRejectedValueOnce(
      new Error("D1 unavailable"),
    );

    const response = await app.request(
      "/api/v1/admin/settings/storefront-url",
      { method: "GET" },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false });
    expect(mocks.saveStorefrontUrl).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "/",
    "storefront.example.com",
    "http://storefront.example.com",
    "https://storefront.example.com/shop",
    "https://user:secret@storefront.example.com",
  ])(
    "rejects invalid Store URL origin %j before writes",
    async (storefrontUrl) => {
      const { app, env } = createTestApp();

      const response = await requestJson(app, env, "POST", "/storefront-url", {
        storefrontUrl,
      });

      expect(response.status).toBe(400);
      expect(mocks.saveStorefrontUrl).not.toHaveBeenCalled();
      expect(
        mocks.invalidateApiAndScheduleStorefrontGroups,
      ).not.toHaveBeenCalled();
    },
  );

  it("returns section-local navigation diagnostics without failing general settings", async () => {
    const { app, env } = createTestApp();
    mocks.getGeneralSettings.mockResolvedValueOnce({
      headerConfig: { navigation: [] },
      footerConfig: {
        menus: [{ id: "help", title: "Help", links: [] }],
      },
      navigationReadiness: {
        header: {
          state: "invalid",
          message: "Stored header configuration is invalid.",
        },
        footer: { state: "ready" },
      },
    });

    const response = await app.request(
      "/api/v1/admin/settings/general",
      { method: "GET" },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        headerConfig: { navigation: [] },
        footerConfig: { menus: [{ id: "help" }] },
        navigationReadiness: {
          header: { state: "invalid" },
          footer: { state: "ready" },
        },
      },
    });
  });

  it("exposes return policy settings on SEO reads", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/seo",
      { method: "GET" },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        returnPolicy: {
          enabled: true,
          country: "BD",
          category: "finite",
          returnWindowDays: 14,
          returnFees: "customer_responsibility",
          returnMethod: "mail",
          policyUrl: "https://storefront.example.com/returns",
        },
      },
    });
  });

  it("keeps navigation out of the header presentation write boundary", async () => {
    const { app, env } = createTestApp();
    const navigationItem = {
      id: "featured-product",
      target: {
        type: "resource",
        resourceType: "product",
        resourceId: "prod_1",
        query: "?color=blue",
      },
      labelMode: "resource",
      lastKnownLabel: "Featured trainer",
    };

    const response = await requestJson(app, env, "POST", "/header", {
      expectedRevision: 1,
      topBar: { text: "Hi", isEnabled: true },
      logo: { src: "/logo.png", alt: "Logo" },
      favicon: { src: "/favicon.png", alt: "Icon" },
      contact: { phone: "123", text: "Call", isEnabled: true },
      social: [],
      navigation: [navigationItem],
    });

    expect(response.status).toBe(200);
    expect(mocks.saveHeaderConfig).toHaveBeenCalledWith(
      expect.anything(),
      {
        topBar: { text: "Hi", isEnabled: true },
        logo: { src: "/logo.png", alt: "Logo", width: 180 },
        favicon: { src: "/favicon.png", alt: "Icon" },
        contact: { phone: "123", text: "Call", isEnabled: true },
        social: [],
      },
      1,
    );
  });

  it("accepts nested partial SEO discovery saves for safe merge semantics", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, "POST", "/seo", {
      discovery: {
        sitemap: { pages: false },
        feeds: { variantStrategy: "products" },
        structuredData: {
          websiteSearch: false,
          productGroups: false,
        },
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.saveSeoSettings).toHaveBeenCalledWith(expect.anything(), {
      discovery: {
        sitemap: { pages: false },
        feeds: { variantStrategy: "products" },
        structuredData: {
          websiteSearch: false,
          productGroups: false,
        },
      },
    });
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["homepage", "layout", "discovery"],
      expect.anything(),
      {
        htmlPaths: [
          "/",
          "/robots.txt",
          "/sitemap.xml",
          "/sitemap-static.xml",
          "/sitemap-categories.xml",
          "/sitemap-collections.xml",
          "/sitemap-pages.xml",
          "/sitemap-articles.xml",
          "/blog/feed.xml",
          "/sitemap-products.xml?page=1",
          "/api/product-feed.xml",
          "/api/facebook-feed.xml",
        ],
      },
    );
  });

  it("accepts return policy saves through the SEO settings route", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, "POST", "/seo", {
      returnPolicy: {
        enabled: true,
        country: "BD",
        category: "finite",
        returnWindowDays: 30,
        returnFees: "free",
        returnMethod: "both",
        policyUrl: "/returns",
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.saveSeoSettings).toHaveBeenCalledWith(expect.anything(), {
      returnPolicy: {
        enabled: true,
        country: "BD",
        category: "finite",
        returnWindowDays: 30,
        returnFees: "free",
        returnMethod: "both",
        policyUrl: "/returns",
      },
    });
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["homepage", "layout", "discovery"],
      expect.objectContaining({ env }),
      expect.objectContaining({
        htmlPaths: expect.arrayContaining(["/robots.txt", "/sitemap.xml"]),
      }),
    );
  });

  it("rejects invalid return policy payloads before saving or invalidating", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, "POST", "/seo", {
      returnPolicy: {
        enabled: true,
        country: "BD",
        category: "finite",
        returnWindowDays: 30,
        returnFees: "free",
        returnMethod: "mail",
        policyUrl: "//evil.example/returns",
      },
    });

    expect(response.status).toBe(400);
    expect(mocks.saveSeoSettings).not.toHaveBeenCalled();
    expect(
      mocks.invalidateApiAndScheduleStorefrontGroups,
    ).not.toHaveBeenCalled();
  });

  it("returns bounded product feed diagnostics from the current SEO feed policy", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/seo/feed-diagnostics?scanLimit=25&sampleLimit=2",
      { method: "GET" },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        scan: { limit: 25, sampleLimitPerReason: 2 },
        totals: { emittedRows: 1, skippedRows: 1 },
      },
    });
    expect(mocks.getProductFeedDiagnostics).toHaveBeenCalledWith(
      expect.anything(),
      {
        productCatalogEnabled: true,
        includeUnavailableProducts: false,
        variantStrategy: "variants",
        title: "",
        description: "",
      },
      {
        scanLimit: 25,
        sampleLimitPerReason: 2,
        storefrontBaseUrl: "https://storefront.example.com",
        currencyCode: "BDT",
      },
    );
  });

  it.each([
    {
      path: "/currency",
      method: "POST" as const,
      body: { currencyCode: "BDT", currencySymbol: "Tk", usdExchangeRate: "1" },
      groups: ["layout", "checkout"],
    },
    {
      path: "/header",
      method: "POST" as const,
      body: {
        expectedRevision: 1,
        topBar: { text: "Hi", isEnabled: true },
        logo: { src: "/logo.png", alt: "Logo" },
        favicon: { src: "/favicon.png", alt: "Icon" },
        contact: { phone: "123", text: "Call", isEnabled: true },
        social: [],
        navigation: [],
      },
      groups: ["layout"],
    },
    {
      path: "/footer",
      method: "POST" as const,
      body: {
        expectedRevision: 1,
        logo: { src: "/logo.png", alt: "Logo" },
        tagline: "",
        description: "",
        copyrightText: "",
        menus: [],
        social: [],
      },
      groups: ["layout"],
    },
    {
      path: "/theme",
      method: "POST" as const,
      body: {
        expectedRevision: 1,
        theme: {
          ...DEFAULT_STOREFRONT_THEME_SETTINGS,
          colors: { primary: "#000000" },
        },
      },
      groups: ["layout"],
    },
    {
      path: "/media",
      method: "POST" as const,
      body: { enabled: true, canonicalCdnUrl: "cdn.example.com" },
      groups: ["media"],
    },
    {
      path: "/seo",
      method: "POST" as const,
      body: { siteTitle: "Site", homepageTitle: "Home" },
      groups: ["homepage", "layout", "discovery"],
      options: {
        htmlPaths: [
          "/",
          "/robots.txt",
          "/sitemap.xml",
          "/sitemap-static.xml",
          "/sitemap-categories.xml",
          "/sitemap-collections.xml",
          "/sitemap-pages.xml",
          "/sitemap-articles.xml",
          "/blog/feed.xml",
          "/sitemap-products.xml?page=1",
          "/api/product-feed.xml",
          "/api/facebook-feed.xml",
        ],
      },
    },
    {
      path: "/storefront-url",
      method: "POST" as const,
      body: { storefrontUrl: "https://storefront.example.com" },
      groups: ["homepage", "layout", "discovery"],
      options: {
        htmlPaths: [
          "/",
          "/robots.txt",
          "/sitemap.xml",
          "/sitemap-static.xml",
          "/sitemap-categories.xml",
          "/sitemap-collections.xml",
          "/sitemap-pages.xml",
          "/sitemap-articles.xml",
          "/blog/feed.xml",
          "/sitemap-products.xml?page=1",
          "/api/product-feed.xml",
          "/api/facebook-feed.xml",
        ],
      },
    },
    {
      path: "/homepage-presentation",
      method: "POST" as const,
      body: {
        expectedRevision: 1,
        categoryRail: {
          enabled: true,
          title: "Browse",
          categoryIds: ["cat_1"],
        },
        trustStrip: { enabled: true },
      },
      groups: ["homepage"],
    },
    {
      path: "/allowed-countries",
      method: "PUT" as const,
      body: { allowedCountries: ["BD"], mode: "include" },
      groups: ["checkout"],
    },
  ])(
    "invalidates $groups after $path saves",
    async ({ path, method, body, groups, options }) => {
      const { app, env, kv } = createTestApp();

      const response = await requestJson(app, env, method, path, body);

      expect(response.status).toBe(200);
      if (options) {
        expect(
          mocks.invalidateApiAndScheduleStorefrontGroups,
        ).toHaveBeenCalledWith(
          groups,
          expect.objectContaining({ env }),
          options,
        );
      } else {
        expect(
          mocks.invalidateApiAndScheduleStorefrontGroups,
        ).toHaveBeenCalledWith(groups, expect.objectContaining({ env }));
      }
      if (path === "/storefront-url") {
        expect(mocks.invalidateSiteSettingsCache).toHaveBeenCalledOnce();
        expect(mocks.invalidateStorefrontUrlCache).toHaveBeenCalledOnce();
        expect(mocks.invalidateStorefrontUrlCache).toHaveBeenCalledWith(kv);
      }
    },
  );

  it("does not fail currency saves when legacy gateway currency KV cleanup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app, env, kv } = createTestApp();
    kv.delete.mockRejectedValueOnce(new Error("kv unavailable"));

    const response = await requestJson(app, env, "POST", "/currency", {
      currencyCode: "BDT",
      currencySymbol: "Tk",
      usdExchangeRate: "1",
    });

    expect(response.status).toBe(200);
    expect(kv.delete).toHaveBeenCalledWith("gw:currency");
    expect(warn).toHaveBeenCalledWith(
      "[Settings] Legacy KV delete failed for gw:currency:",
      "kv unavailable",
    );
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["layout", "checkout"],
      expect.objectContaining({ env }),
    );

    warn.mockRestore();
  });

  it("reports the persisted-currency lock state to the admin form", async () => {
    const { app, env } = createTestApp();
    mocks.isCurrencyCodeLocked.mockResolvedValueOnce(true);

    const response = await app.request(
      "/api/v1/admin/settings/currency",
      { method: "GET" },
      env,
    );
    const payload = (await response.json()) as {
      data?: { currencyCodeLocked?: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.data?.currencyCodeLocked).toBe(true);
  });

  it("normalizes a supported lowercase currency code before saving", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, "POST", "/currency", {
      currencyCode: " usd ",
      currencySymbol: "$",
      usdExchangeRate: "1",
    });

    expect(response.status).toBe(200);
    expect(mocks.saveCurrencySettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currencyCode: "USD" }),
    );
  });

  it.each(["", "US", "USDT", "ZZZ", "12A"])(
    "rejects unsupported currency code %s before saving or invalidating",
    async (currencyCode) => {
      const { app, env } = createTestApp();

      const response = await requestJson(app, env, "POST", "/currency", {
        currencyCode,
        currencySymbol: "$",
        usdExchangeRate: "1",
      });

      expect(response.status).toBe(400);
      expect(mocks.saveCurrencySettings).not.toHaveBeenCalled();
      expect(
        mocks.invalidateApiAndScheduleStorefrontGroups,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["", "0", "-1", "Infinity", "NaN", "1foo"])(
    "rejects invalid USD exchange rate %j before saving or invalidating",
    async (usdExchangeRate) => {
      const { app, env } = createTestApp();

      const response = await requestJson(app, env, "POST", "/currency", {
        currencyCode: "BDT",
        currencySymbol: "Tk",
        usdExchangeRate,
      });

      expect(response.status).toBe(400);
      expect(mocks.saveCurrencySettings).not.toHaveBeenCalled();
      expect(
        mocks.invalidateApiAndScheduleStorefrontGroups,
      ).not.toHaveBeenCalled();
    },
  );

  it("returns the typed currency lock conflict without invalidating caches", async () => {
    const { app, env } = createTestApp();
    mocks.saveCurrencySettings.mockRejectedValueOnce(
      new ConflictError(
        "Currency code cannot be changed after products or orders exist. You can still update the currency symbol and USD exchange rate.",
      ),
    );

    const response = await requestJson(app, env, "POST", "/currency", {
      currencyCode: "USD",
      currencySymbol: "$",
      usdExchangeRate: "1",
    });
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };

    expect(response.status).toBe(409);
    expect(payload.error).toEqual({
      code: "CONFLICT",
      message:
        "Currency code cannot be changed after products or orders exist. You can still update the currency symbol and USD exchange rate.",
    });
    expect(
      mocks.invalidateApiAndScheduleStorefrontGroups,
    ).not.toHaveBeenCalled();
  });

  it("rejects unsafe theme colors before saving or invalidating cache", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, "POST", "/theme", {
      expectedRevision: 1,
      theme: {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS,
        colors: {
          primary: "#059669",
          background: "#fff; color: red",
          unsafe: "#000",
        },
      },
    });

    expect(response.status).toBe(400);
    expect(mocks.saveThemeSettings).not.toHaveBeenCalled();
    expect(
      mocks.invalidateApiAndScheduleStorefrontGroups,
    ).not.toHaveBeenCalled();
  });

  it("does not invalidate storefront caches after a stale theme publish", async () => {
    const { app, env } = createTestApp();
    mocks.saveThemeSettings.mockRejectedValueOnce(
      new ConflictError(
        "The storefront theme was published from another session. Your draft is still available; load the latest saved theme before publishing again.",
      ),
    );

    const response = await requestJson(app, env, "POST", "/theme", {
      expectedRevision: 1,
      theme: {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS,
        colors: { primary: "#2563eb" },
      },
    });

    expect(response.status).toBe(409);
    expect(mocks.saveThemeSettings).toHaveBeenCalledWith(
      { id: "db" },
      {
        ...DEFAULT_STOREFRONT_THEME_SETTINGS,
        colors: { primary: "#2563eb" },
      },
      1,
      null,
    );
    expect(
      mocks.invalidateApiAndScheduleStorefrontGroups,
    ).not.toHaveBeenCalled();
  });

  it("saves and rebases theme drafts without invalidating the published storefront", async () => {
    const { app, env } = createTestApp();
    const payload = {
      theme: DEFAULT_STOREFRONT_THEME_SETTINGS,
      expectedDraftRevision: 2,
      basePublishedRevision: 1,
    };

    const saveResponse = await requestJson(
      app,
      env,
      "POST",
      "/theme/draft",
      payload,
    );
    const rebaseResponse = await requestJson(
      app,
      env,
      "POST",
      "/theme/draft/rebase",
      payload,
    );

    expect(saveResponse.status).toBe(200);
    expect(rebaseResponse.status).toBe(200);
    expect(mocks.saveThemeDraft).toHaveBeenCalledWith(
      { id: "db" },
      DEFAULT_STOREFRONT_THEME_SETTINGS,
      2,
      1,
      null,
    );
    expect(mocks.rebaseThemeDraft).toHaveBeenCalledWith(
      { id: "db" },
      DEFAULT_STOREFRONT_THEME_SETTINGS,
      2,
      1,
      null,
    );
    expect(
      mocks.invalidateApiAndScheduleStorefrontGroups,
    ).not.toHaveBeenCalled();
  });

  it("creates a private exact-draft preview without invalidating caches", async () => {
    const { app, env } = createTestApp();
    const response = await requestJson(
      app,
      env,
      "POST",
      "/theme/preview-session",
      { expectedDraftRevision: 2 },
    );
    const body = (await response.json()) as { data?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(body.data).toMatchObject({
      token: `tpv_${"a".repeat(48)}`,
      draftRevision: 2,
      basePublishedRevision: 1,
    });
    expect(body.data).not.toHaveProperty("theme");
    expect(
      mocks.invalidateApiAndScheduleStorefrontGroups,
    ).not.toHaveBeenCalled();
  });

  it("invalidates layout only after publishing or restoring a theme revision", async () => {
    const { app, env } = createTestApp();
    const publishResponse = await requestJson(
      app,
      env,
      "POST",
      "/theme/publish",
      { expectedPublishedRevision: 1, expectedDraftRevision: 2 },
    );
    const rollbackResponse = await requestJson(
      app,
      env,
      "POST",
      "/theme/rollback",
      {
        sourceRevision: 1,
        expectedPublishedRevision: 1,
        expectedDraftRevision: 2,
      },
    );

    expect(publishResponse.status).toBe(200);
    expect(rollbackResponse.status).toBe(200);
    expect(
      mocks.invalidateApiAndScheduleStorefrontGroups,
    ).toHaveBeenCalledTimes(2);
    expect(
      mocks.invalidateApiAndScheduleStorefrontGroups,
    ).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(["layout"]),
      expect.anything(),
    );
    expect(
      mocks.invalidateApiAndScheduleStorefrontGroups,
    ).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(["layout"]),
      expect.anything(),
    );
  });
});
