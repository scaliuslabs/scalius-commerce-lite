import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@scalius/core/errors";
import {
  DEFAULT_STOREFRONT_THEME,
  EMPTY_STORE_SHAPE,
  storefrontTemplateTheme,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { THEME_VERSION_HISTORY_LIMIT, THEME_VERSION_PAGE_LIMIT } from "@scalius/core/modules/settings";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({

  getCurrencySettings: vi.fn(),
  isCurrencyCodeLocked: vi.fn(),
  saveCurrencySettings: vi.fn(),
  getThemeWorkspace: vi.fn(),
  saveThemeDraft: vi.fn(),
  publishThemeDraft: vi.fn(),
  listThemeVersions: vi.fn(),
  getThemeVersion: vi.fn(),
  restoreThemeVersion: vi.fn(),
  discardThemeDraft: vi.fn(),
  saveThemePageDraft: vi.fn(),
  createThemePreviewSession: vi.fn(),
  getMediaOptimizationSettings: vi.fn(),
  isValidMediaHostInput: vi.fn(),
  saveMediaOptimizationSettings: vi.fn(),
  getSeoSettings: vi.fn(),
  saveSeoSettings: vi.fn(),
  getProductFeedDiagnostics: vi.fn(),
  getStorefrontUrlSetting: vi.fn(),
  saveStorefrontUrl: vi.fn(),
  getAllowedCountries: vi.fn(),
  saveAllowedCountries: vi.fn(),
  runSeoDiscoveryLiveProbe: vi.fn(),
  readSettingsForEdit: vi.fn(),
  readThemeMedia: vi.fn(),
  readStoreShape: vi.fn(),
  listPluginInstallations: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@scalius/core/modules/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/plugins")>()),
  listPluginInstallations: mocks.listPluginInstallations,
}));

// The store's pricing currency: the shop currency at the backup market's increment.
vi.mock("@scalius/core/modules/markets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scalius/core/modules/markets")>();
  return {
    ...actual,
    // No market sells in its own currency, so the shop currency can change.
    listOwnMarketCurrencies: async () => [],
    readStoreCurrency: async (db: unknown) => {
      const currency = await mocks.getCurrencySettings(db);
      return { ...actual.storeCurrencyOf(currency, currency.priceIncrementMinor), symbol: currency.currencySymbol };
    },
  };
});

vi.mock("@scalius/core/modules/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/settings")>()),
  getCurrencySettings: mocks.getCurrencySettings,
  isCurrencyCodeLocked: mocks.isCurrencyCodeLocked,
  saveCurrencySettings: mocks.saveCurrencySettings,
  getThemeWorkspace: mocks.getThemeWorkspace,
  saveThemeDraft: mocks.saveThemeDraft,
  publishThemeDraft: mocks.publishThemeDraft,
  listThemeVersions: mocks.listThemeVersions,
  getThemeVersion: mocks.getThemeVersion,
  restoreThemeVersion: mocks.restoreThemeVersion,
  discardThemeDraft: mocks.discardThemeDraft,
  saveThemePageDraft: mocks.saveThemePageDraft,
  createThemePreviewSession: mocks.createThemePreviewSession,
  getMediaOptimizationSettings: mocks.getMediaOptimizationSettings,
  isValidMediaHostInput: mocks.isValidMediaHostInput,
  saveMediaOptimizationSettings: mocks.saveMediaOptimizationSettings,
  getSeoSettings: mocks.getSeoSettings,
  saveSeoSettings: mocks.saveSeoSettings,
  getAllowedCountries: mocks.getAllowedCountries,
  saveAllowedCountries: mocks.saveAllowedCountries,
  readSettingsForEdit: mocks.readSettingsForEdit,
}));

vi.mock("@scalius/core/modules/storefront", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/storefront")>()),
  readThemeMedia: mocks.readThemeMedia,
  readStoreShape: mocks.readStoreShape,
}));

vi.mock("@scalius/core/modules/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/platform")>()),
  getStorefrontUrlSetting: mocks.getStorefrontUrlSetting,
  saveStorefrontUrl: mocks.saveStorefrontUrl,
}));

vi.mock("@scalius/core/modules/catalog", () => ({
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

vi.mock("@scalius/shared/seo-discovery-live-probe", () => ({
  runSeoDiscoveryLiveProbe: mocks.runSeoDiscoveryLiveProbe,
}));

import { siteSettingsRoutes } from "./site";

function createTestApp() {
  const db = { id: "db" };
  const kv = { delete: vi.fn() };
  const env = {
    CACHE: kv,
    STOREFRONT_URL: "https://storefront.example.com",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  // Editors read a document with its revision; route each document to its reader mock.
  mocks.readSettingsForEdit.mockImplementation(async (database: unknown, document: { key: string }) => {
    const read = {
      currency: mocks.getCurrencySettings,
      media: mocks.getMediaOptimizationSettings,
      seo: mocks.getSeoSettings,
      platform: mocks.getStorefrontUrlSetting,
      customer_countries: mocks.getAllowedCountries,
    }[document.key]!;
    return { value: await read(database), revision: 1 };
  });
  mocks.getCurrencySettings.mockResolvedValue({
    currencyCode: "BDT",
    currencySymbol: "Tk",
  });
  mocks.isCurrencyCodeLocked.mockResolvedValue(false);
  mocks.saveCurrencySettings.mockResolvedValue({ value: {}, revision: 2 });
  const themeDraft = {
    theme: DEFAULT_STOREFRONT_THEME,
    revision: 2,
    basePublishedRevision: 1,
    updatedAt: new Date(1_000),
  };
  const themeWorkspace = {
    published: {
      theme: DEFAULT_STOREFRONT_THEME,
      revision: 1,
    },
    draft: themeDraft,
    draftDiffersFromLive: false,
    lastPublished: null,
  };
  mocks.getThemeWorkspace.mockResolvedValue(themeWorkspace);
  mocks.saveThemeDraft.mockResolvedValue(themeDraft);
  mocks.readThemeMedia.mockResolvedValue([]);
  mocks.readStoreShape.mockResolvedValue(EMPTY_STORE_SHAPE);
  const themeStatus = {
    published: { revision: 2 },
    draft: { revision: 3, basePublishedRevision: 2, updatedAt: new Date(1_000) },
    draftDiffersFromLive: false,
    lastPublished: null,
  };
  mocks.publishThemeDraft.mockResolvedValue(themeStatus);
  mocks.restoreThemeVersion.mockResolvedValue(themeStatus);
  mocks.discardThemeDraft.mockResolvedValue(themeStatus);
  mocks.listThemeVersions.mockResolvedValue([]);
  mocks.createThemePreviewSession.mockResolvedValue({
    continuationId: `tpc_${"a".repeat(48)}`,
    draftRevision: 2,
    basePublishedRevision: 1,
    expiresAt: new Date(Date.now() + 60_000),
  });
  mocks.isValidMediaHostInput.mockReturnValue(true);
  mocks.saveMediaOptimizationSettings.mockResolvedValue({
    value: { canonicalCdnUrl: "cdn.example.com", canonicalHostAliases: [] },
    revision: 2,
  });
  mocks.getSeoSettings.mockResolvedValue({
    homepageTitle: "Scalius",
    homepageMetaDescription: "",
    socialImage: "",
    discovery: {
      feeds: {
        productCatalogEnabled: true,
        includeUnavailableProducts: false,
        variantStrategy: "variants",
        title: "",
        description: "",
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
  mocks.saveSeoSettings.mockResolvedValue({ value: {}, revision: 2 });
  mocks.getStorefrontUrlSetting.mockResolvedValue({
    storefrontUrl: "https://storefront.example.com",
  });
  mocks.saveStorefrontUrl.mockResolvedValue({ value: {}, revision: 2 });
  mocks.saveAllowedCountries.mockResolvedValue({
    value: { allowedCountries: ["BD"], allowedCountriesMode: "include" },
    revision: 2,
  });
  mocks.runSeoDiscoveryLiveProbe.mockImplementation(async (deps) => {
    const [policy, storefront] = await Promise.all([
      deps.getDiscoveryPolicy(),
      deps.getStorefrontUrl(),
    ]);
    return {
      baseUrl: storefront.storefrontUrl,
      checkedAt: "2026-08-13T00:00:00.000Z",
      ok: Boolean(policy.discovery),
      resources: [],
    };
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
      // Revisioned documents take the revision the editor loaded (1 here).
      body: JSON.stringify(
        REVISIONED_PATHS.has(path) ? { expectedRevision: 1, ...(body as object) } : body,
      ),
    },
    env,
  );
}

const REVISIONED_PATHS = new Set(["/currency", "/media", "/seo", "/storefront-url", "/allowed-countries"]);

describe("site settings write behavior", () => {
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

  it("returns a bounded SEO policy projection below the agent response ceiling", async () => {
    const { app, env } = createTestApp();
    const baseline = await mocks.getSeoSettings();
    mocks.getSeoSettings.mockClear();
    mocks.getSeoSettings.mockResolvedValueOnce({
      ...baseline,
      homepageTitle: "h".repeat(2_000),
      homepageMetaDescription: "m".repeat(20_000),
      discovery: {
        ...baseline.discovery,
        feeds: {
          ...baseline.discovery.feeds,
          title: "f".repeat(2_000),
          description: "d".repeat(20_000),
        },
      },
      returnPolicy: {
        ...baseline.returnPolicy,
        policyUrl: `https://storefront.example.com/${"p".repeat(10_000)}`,
      },
    });

    const response = await app.request(
      "/api/v1/admin/settings/seo",
      { method: "GET" },
      env,
    );
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(65_536);
    expect(body.data.homepageTitle).toHaveLength(200);
    expect(body.data.homepageMetaDescription).toHaveLength(1_000);
    expect(body.data.discovery.feeds.title).toHaveLength(200);
    expect(body.data.discovery.feeds.description).toHaveLength(2_000);
    expect(body.data.returnPolicy.policyUrl).toHaveLength(2_048);
    expect(mocks.getSeoSettings).toHaveBeenCalledTimes(1);
  });

  it("bounds every retained general-settings read below its declared ceiling", async () => {
    const { app, env } = createTestApp();
    mocks.getCurrencySettings.mockResolvedValueOnce({
      currencyCode: "BDT",
      currencySymbol: "T".repeat(10_000),
    });
    mocks.getMediaOptimizationSettings.mockResolvedValueOnce({
      canonicalCdnUrl: "c".repeat(10_000),
      canonicalHostAliases: Array.from(
        { length: 100 },
        (_, index) => `alias-${index}.${"b".repeat(1_000)}`,
      ),
    });
    mocks.getStorefrontUrlSetting.mockResolvedValueOnce({
      storefrontUrl: `https://${"a".repeat(3_000)}.example.com`,
    });
    const countryCodes = Array.from({ length: 26 * 26 }, (_, index) =>
      `${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
    );
    mocks.getAllowedCountries.mockResolvedValueOnce({
      allowedCountries: [...countryCodes, "invalid", "BD"],
      allowedCountriesMode: "exclude",
    });

    for (const path of [
      "/currency",
      "/media",
      "/storefront-url",
      "/allowed-countries",
    ]) {
      const response = await app.request(
        `/api/v1/admin/settings${path}`,
        { method: "GET" },
        env,
      );
      const responseText = await response.text();
      expect(response.status, path).toBe(200);
      expect(
        new TextEncoder().encode(responseText).byteLength,
        path,
      ).toBeLessThan(65_536);
    }

    mocks.getMediaOptimizationSettings.mockResolvedValueOnce({
      canonicalCdnUrl: "cdn.example.com",
      canonicalHostAliases: Array.from(
        { length: 100 },
        (_, index) => `alias-${index}.example.com`,
      ),
    });
    const projectedMediaResponse = await app.request(
      "/api/v1/admin/settings/media",
      { method: "GET" },
      env,
    );
    const projectedMediaBody = (await projectedMediaResponse.json()) as {
      data: { canonicalHostAliases: string[] };
    };
    expect(projectedMediaBody.data.canonicalHostAliases).toHaveLength(24);
  });

  it("rejects SEO writes that exceed the bounded policy contract", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, "POST", "/seo", {
      homepageMetaDescription: "m".repeat(1_001),
    });

    expect(response.status).toBe(400);
    expect(mocks.saveSeoSettings).not.toHaveBeenCalled();
  });

  it.each([
    "http://cdn.example.com/social.jpg",
    "http://localhost.example.com/social.jpg",
    "https://user:pass@cdn.example.com/social.jpg",
    "/media/social.jpg",
    "//cdn.example.com/social.jpg",
    " https://cdn.example.com/social.jpg",
    `https://cdn.example.com/${"s".repeat(2_048)}.jpg`,
  ])("rejects a social image that is not blank or an absolute https URL: %s", async (socialImage) => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, "POST", "/seo", { socialImage });

    expect(response.status).toBe(400);
    expect(mocks.saveSeoSettings).not.toHaveBeenCalled();
  });

  it.each(["", "https://cdn.example.com/media/social.jpg", "http://localhost:8787/media/social.jpg"])(
    "accepts a blank, absolute https or local-development social image: %j",
    async (socialImage) => {
      const { app, env } = createTestApp();

      const response = await requestJson(app, env, "POST", "/seo", { socialImage });

      expect(response.status).toBe(200);
      expect(mocks.saveSeoSettings).toHaveBeenCalledWith(expect.anything(), { socialImage }, { expectedRevision: 1 });

    },
  );

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

    },
  );

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

  it("accepts nested partial SEO discovery saves for safe merge semantics", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, "POST", "/seo", {
      discovery: {
        feeds: { variantStrategy: "products" },
      },
    });

    expect(response.status).toBe(200);
    expect(mocks.saveSeoSettings).toHaveBeenCalledWith(expect.anything(), {
      discovery: {
        feeds: { variantStrategy: "products" },
      },
    }, { expectedRevision: 1 });

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
    }, { expectedRevision: 1 });

  });

  it("rejects invalid return policy payloads before saving", async () => {
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
        priceIncrementMinor: 100,
      },
    );
  });

  it("caps legacy feed diagnostic samples and sample text below 64 KiB", async () => {
    const { app, env } = createTestApp();
    const reasons = [
      "feed_disabled",
      "storefront_url_unavailable",
      "product_feed_excluded",
      "inactive_deleted_unpublished",
      "inconsistent_option_axes",
      "no_buyer_sku",
      "non_positive_price",
      "missing_image",
      "unavailable_excluded",
    ] as const;
    mocks.getProductFeedDiagnostics.mockResolvedValueOnce({
      policy: {
        productCatalogEnabled: true,
        includeUnavailableProducts: false,
        variantStrategy: "variants",
      },
      scan: {
        limit: 500,
        scannedProducts: 500,
        truncated: true,
        sampleLimitPerReason: 10,
      },
      totals: {
        emittedRows: 0,
        emittedProductRows: 0,
        emittedVariantRows: 0,
        productsWithIssues: 500,
        skippedRows: 500,
      },
      reasons: reasons.map((reason) => ({
        reason,
        products: 500,
        rows: 500,
        samples: Array.from({ length: 20 }, (_, index) => ({
          id: `prod_${index}_${"i".repeat(1_000)}`,
          name: `Product ${index} ${"n".repeat(10_000)}`,
          slug: `product-${index}-${"s".repeat(10_000)}`,
          reason,
        })),
      })),
    });

    const response = await app.request(
      "/api/v1/admin/settings/seo/feed-diagnostics?sampleLimit=10",
      { method: "GET" },
      env,
    );
    const responseText = await response.text();
    const body = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(new TextEncoder().encode(responseText).byteLength).toBeLessThan(65_536);
    expect(body.data.reasons).toHaveLength(9);
    expect(body.data.reasons[0].samples).toHaveLength(10);
    expect(body.data.reasons[0].samples[0].id).toHaveLength(128);
    expect(body.data.reasons[0].samples[0].name).toHaveLength(200);
    expect(body.data.reasons[0].samples[0].slug).toHaveLength(200);
  });

  it("runs live discovery proof from the saved policy and Store URL authority", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/seo/live-probe",
      { method: "GET" },
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        baseUrl: "https://storefront.example.com",
        checkedAt: "2026-08-13T00:00:00.000Z",
        ok: true,
        resources: [],
      },
    });
    expect(mocks.runSeoDiscoveryLiveProbe).toHaveBeenCalledTimes(1);
    expect(mocks.getSeoSettings).toHaveBeenCalledTimes(1);
    expect(mocks.getStorefrontUrlSetting).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      path: "/currency",
      method: "POST" as const,
      body: { currencyCode: "BDT", currencySymbol: "Tk" },
    },
    {
      path: "/media",
      method: "POST" as const,
      body: { canonicalCdnUrl: "cdn.example.com" },
    },
    {
      path: "/seo",
      method: "POST" as const,
      body: { homepageTitle: "Home", socialImage: "https://cdn.example.com/social.jpg" },
    },
    {
      path: "/storefront-url",
      method: "POST" as const,
      body: { storefrontUrl: "https://storefront.example.com" },
    },
    {
      path: "/allowed-countries",
      method: "PUT" as const,
      body: { allowedCountries: ["BD"], mode: "include" },
    },
  ])(
    "commits $path saves",
    async ({ path, method, body }) => {
      const { app, env, kv } = createTestApp();

      const response = await requestJson(app, env, method, path, body);

      expect(response.status).toBe(200);

      if (path === "/storefront-url") {
        // The storefront origin lives in the platform document; its KV mirror is written through.
        expect(mocks.saveStorefrontUrl).toHaveBeenCalledWith(expect.anything(), expect.any(String), kv, { expectedRevision: 1 });
      }
    },
  );

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
    });

    expect(response.status).toBe(200);
    expect(mocks.saveCurrencySettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currencyCode: "USD" }),
      { expectedRevision: 1 },
    );
  });

  it.each(["", "US", "USDT", "ZZZ", "12A"])(
    "rejects unsupported currency code %s before saving",
    async (currencyCode) => {
      const { app, env } = createTestApp();

      const response = await requestJson(app, env, "POST", "/currency", {
        currencyCode,
        currencySymbol: "$",
      });

      expect(response.status).toBe(400);
      expect(mocks.saveCurrencySettings).not.toHaveBeenCalled();

    },
  );

  it("returns the typed currency lock conflict", async () => {
    const { app, env } = createTestApp();
    mocks.saveCurrencySettings.mockRejectedValueOnce(
      new ConflictError(
        "Currency code cannot be changed after products or orders exist. You can still update the currency symbol.",
      ),
    );

    const response = await requestJson(app, env, "POST", "/currency", {
      currencyCode: "USD",
      currencySymbol: "$",
    });
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };

    expect(response.status).toBe(409);
    expect(payload.error).toEqual({
      code: "CONFLICT",
      message:
        "Currency code cannot be changed after products or orders exist. You can still update the currency symbol.",
    });

  });

  it("rejects invalid theme documents before saving", async () => {
    const { app, env } = createTestApp();
    const lowContrast = structuredClone(DEFAULT_STOREFRONT_THEME) as StorefrontThemeDocument;
    lowContrast.tokens.colors.foreground = "#f5f5f5";
    const unsafeColor = structuredClone(DEFAULT_STOREFRONT_THEME) as unknown as {
      tokens: { colors: Record<string, string> };
    };
    unsafeColor.tokens.colors.background = "#fff; color: red";
    const invalidThemes: unknown[] = [
      lowContrast,
      unsafeColor,
      { ...DEFAULT_STOREFRONT_THEME, version: 3 },
      { ...DEFAULT_STOREFRONT_THEME, template: "classic" },
      { ...DEFAULT_STOREFRONT_THEME, layout: { header: "classic" } },
      { ...DEFAULT_STOREFRONT_THEME, blocks: { ...DEFAULT_STOREFRONT_THEME.blocks, header: { variant: "floating", settings: {} } } },
      { ...DEFAULT_STOREFRONT_THEME, blocks: { ...DEFAULT_STOREFRONT_THEME.blocks, header: { variant: "spec-two-row", settings: { cartTotal: true } } } },
      {
        ...DEFAULT_STOREFRONT_THEME,
        pages: { ...DEFAULT_STOREFRONT_THEME.pages, home: [...DEFAULT_STOREFRONT_THEME.pages.home, { id: "promo", type: "video", version: 1, settings: {} }] },
      },
      {
        ...DEFAULT_STOREFRONT_THEME,
        pages: { ...DEFAULT_STOREFRONT_THEME.pages, home: DEFAULT_STOREFRONT_THEME.pages.home.map((section) => ({ ...section, version: 2 })) },
      },
      { ...DEFAULT_STOREFRONT_THEME, pages: { ...DEFAULT_STOREFRONT_THEME.pages, home: DEFAULT_STOREFRONT_THEME.pages.home.map((section) => ({ ...section, id: "same" })) } },
      { ...DEFAULT_STOREFRONT_THEME, pages: { ...DEFAULT_STOREFRONT_THEME.pages, product: { blocks: [] } } },
    ];

    for (const theme of invalidThemes) {
      const response = await requestJson(app, env, "POST", "/theme/draft", {
        theme,
        expectedDraftRevision: 2,
        basePublishedRevision: 1,
      });
      expect(response.status).toBe(400);
    }
    expect(mocks.saveThemeDraft).not.toHaveBeenCalled();

  });

  it("returns a conflict for a stale theme publish", async () => {
    const { app, env } = createTestApp();
    mocks.publishThemeDraft.mockRejectedValueOnce(
      new ConflictError("The storefront style or its draft changed in another session. Reload before publishing."),
    );

    const response = await requestJson(app, env, "POST", "/theme/publish", {
      expectedPublishedRevision: 1,
      expectedDraftRevision: 2,
    });

    expect(response.status).toBe(409);
    expect(mocks.publishThemeDraft).toHaveBeenCalledWith({ id: "db" }, 1, 2, null, null);
  });

  it("saves theme drafts, and publishing goes only through the draft", async () => {
    const { app, env } = createTestApp();
    const payload = {
      theme: DEFAULT_STOREFRONT_THEME,
      expectedDraftRevision: 2,
      basePublishedRevision: 1,
    };

    const saveResponse = await requestJson(app, env, "POST", "/theme/draft", payload);
    expect(saveResponse.status).toBe(200);
    // A receipt: the editor keeps its own document, agents get revisions only.
    expect(((await saveResponse.json()) as { data: unknown }).data).toEqual({ revision: 2, basePublishedRevision: 1, updatedAt: new Date(1_000).toISOString() });
    expect(mocks.saveThemeDraft).toHaveBeenCalledWith(
      { id: "db" },
      DEFAULT_STOREFRONT_THEME,
      2,
      1,
      null,
    );

    // No direct publish and no rebase: a draft is always based on the live revision.
    for (const path of ["/theme", "/theme/draft/rebase", "/theme/rollback"]) {
      const response = await requestJson(app, env, "POST", path, { expectedRevision: 1, ...payload });
      expect(response.status).toBe(404);
    }
    const legacyRead = await app.request("/api/v1/admin/settings/theme", { method: "GET" }, env);
    expect(legacyRead.status).toBe(404);
  });

  it("opens the editor with every image the draft names and the store shape in one read", async () => {
    const { app, env } = createTestApp();
    const draftTheme = storefrontTemplateTheme("heritage-editorial");
    const media = [{ id: "media_draft", url: "https://cdn.example.com/story.jpg", alt: "", width: 1200, height: 800 }];
    mocks.getThemeWorkspace.mockResolvedValueOnce({
      published: { theme: DEFAULT_STOREFRONT_THEME, revision: 1 },
      draft: { theme: draftTheme, revision: 3, basePublishedRevision: 1, updatedAt: new Date(1_000) },
      draftDiffersFromLive: true,
      lastPublished: null,
    });
    mocks.readThemeMedia.mockResolvedValueOnce(media);

    const response = await app.request("/api/v1/admin/settings/theme/editor", { method: "GET" }, env);
    const body = (await response.json()) as { data?: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(mocks.readThemeMedia).toHaveBeenCalledTimes(1);
    expect(mocks.readThemeMedia).toHaveBeenCalledWith({ id: "db" }, draftTheme);
    expect(body.data).toMatchObject({
      published: { revision: 1 },
      draft: { revision: 3, basePublishedRevision: 1 },
      storeShape: EMPTY_STORE_SHAPE,
      media,
    });
    expect(body.data).not.toHaveProperty("sectionMedia");
    expect(body.data?.apps).toEqual([]);
    // The AI providers load when the AI dialog opens, not with the editor; nobody has saved the draft by name.
    expect(body.data).not.toHaveProperty("aiProviders");
    expect(body.data?.draft).toMatchObject({ updatedByName: null });
    expect(body.data?.draft).not.toHaveProperty("updatedBy");
  });

  it("names who saved the draft without exposing the author id", async () => {
    const { app, env } = createTestApp();
    mocks.getThemeWorkspace.mockResolvedValueOnce({
      published: { theme: DEFAULT_STOREFRONT_THEME, revision: 1 },
      draft: { theme: DEFAULT_STOREFRONT_THEME, revision: 2, basePublishedRevision: 1, updatedAt: new Date(1_000), updatedBy: "user_1", updatedByName: "Rana" },
      draftDiffersFromLive: false,
      lastPublished: null,
    });
    mocks.readThemeMedia.mockResolvedValueOnce([]);

    const response = await app.request("/api/v1/admin/settings/theme/editor", { method: "GET" }, env);
    const body = (await response.json()) as { data: { draft: Record<string, unknown> } };
    expect(response.status).toBe(200);
    expect(body.data.draft).toMatchObject({ revision: 2, updatedByName: "Rana" });
    expect(body.data.draft).not.toHaveProperty("updatedBy");
    expect(body.data).not.toHaveProperty("aiProviders");
  });

  it("offers the theme editor the sections and product blocks of active apps approved for the storefront", async () => {
    const { app, env } = createTestApp();
    mocks.getThemeWorkspace.mockResolvedValueOnce({
      published: { theme: DEFAULT_STOREFRONT_THEME, revision: 1 },
      draft: { theme: DEFAULT_STOREFRONT_THEME, revision: 1, basePublishedRevision: 1, updatedAt: new Date(1_000) },
      draftDiffersFromLive: false,
      lastPublished: null,
    });
    mocks.readThemeMedia.mockResolvedValueOnce([]);
    const { parsePluginManifest } = await import("@scalius/shared/plugins");
    const manifest = (id: string, extra: Record<string, unknown>) => {
      const parsed = parsePluginManifest({
        id, name: id === "acme.reviews" ? "Reviews" : "Hidden", version: "1.0.0", apiVersion: "2026-10", description: "An app.", author: { name: "Acme" },
        routes: { public: [{ name: "draw", methods: ["GET"] }] },
        storefront: {
          sections: [{ type: "latest", name: "Latest reviews", route: "draw", settings: [{ key: "heading", label: "Heading", type: "text", default: "Loved" }] }],
          productBlocks: [{ type: "stars", name: "Stars", placement: "buy-box", route: "draw" }],
        },
        ...extra,
      });
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
      return parsed.manifest;
    };
    const surfaces = { storefrontSurfaces: true };
    mocks.listPluginInstallations.mockResolvedValueOnce([
      { pluginId: "acme.reviews", status: "active", grant: surfaces, manifest: manifest("acme.reviews", {}) },
      { pluginId: "acme.hidden", status: "disabled", grant: surfaces, manifest: manifest("acme.hidden", {}) },
      { pluginId: "acme.ungranted", status: "active", grant: { storefrontSurfaces: false }, manifest: manifest("acme.ungranted", {}) },
    ]);

    const response = await app.request("/api/v1/admin/settings/theme/editor", { method: "GET" }, env);
    const body = (await response.json()) as { data: { apps: unknown[] } };
    expect(response.status).toBe(200);
    expect(body.data.apps).toEqual([{
      id: "acme.reviews",
      name: "Reviews",
      sections: [{
        key: "acme.reviews/latest",
        type: "latest",
        name: "Latest reviews",
        description: null,
        settings: [expect.objectContaining({ key: "heading", type: "text", default: "Loved" })],
      }],
      productBlocks: [{ key: "acme.reviews/stars", type: "stars", name: "Stars", placement: "buy-box", settings: [] }],
    }]);
  });

  it("passes notes and the exact draft revision through publication", async () => {
    const { app, env } = createTestApp();
    const response = await requestJson(app, env, "POST", "/theme/publish", { expectedPublishedRevision: 1, expectedDraftRevision: 2, note: "Eid release" });
    expect(response.status).toBe(200);
    expect(mocks.publishThemeDraft).toHaveBeenCalledWith({ id: "db" }, 1, 2, null, "Eid release");
    const invalid = await requestJson(app, env, "POST", "/theme/publish", { expectedPublishedRevision: 1, expectedDraftRevision: 2, note: "x".repeat(501) });
    expect(invalid.status).toBe(400);
  });

  it("restores versions and discards only through explicit draft CAS commands", async () => {
    const { app, env } = createTestApp();
    expect((await requestJson(app, env, "POST", "/theme/restore", { sourceRevision: 4, expectedDraftRevision: 8, basePublishedRevision: 6 })).status).toBe(200);
    expect(mocks.restoreThemeVersion).toHaveBeenCalledWith({ id: "db" }, 4, 8, 6, null, { withoutMissingImages: false });
    // Restoring without the images deleted from Files since is an explicit choice.
    expect((await requestJson(app, env, "POST", "/theme/restore", { sourceRevision: 4, expectedDraftRevision: 8, basePublishedRevision: 6, withoutMissingImages: true })).status).toBe(200);
    expect(mocks.restoreThemeVersion).toHaveBeenLastCalledWith({ id: "db" }, 4, 8, 6, null, { withoutMissingImages: true });
    expect((await requestJson(app, env, "POST", "/theme/discard", { expectedDraftRevision: 8, basePublishedRevision: 6 })).status).toBe(200);
    expect(mocks.discardThemeDraft).toHaveBeenCalledWith({ id: "db" }, 8, 6, null);
    expect(mocks.publishThemeDraft).not.toHaveBeenCalled();
  });

  it("validates individual page edits and exposes version preview selection", async () => {
    const { app, env } = createTestApp();
    mocks.saveThemePageDraft.mockResolvedValue({ theme: DEFAULT_STOREFRONT_THEME, revision: 3, basePublishedRevision: 1, updatedAt: new Date(1_000) });
    const value = { title: "Eid", description: "", sections: DEFAULT_STOREFRONT_THEME.pages.home };
    const saved = await requestJson(app, env, "POST", "/theme/page-draft", { page: "landing", slug: "eid", value, expectedDraftRevision: 2, basePublishedRevision: 1 });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { data: unknown }).data).toEqual({ revision: 3, basePublishedRevision: 1, updatedAt: new Date(1_000).toISOString() });
    expect(mocks.saveThemePageDraft).toHaveBeenCalledWith({ id: "db" }, { page: "landing", slug: "eid", value }, 2, 1, null);
    expect((await requestJson(app, env, "POST", "/theme/page-draft", { page: "home", value: [], expectedDraftRevision: 2, basePublishedRevision: 1 })).status).toBe(200);
    expect(mocks.saveThemePageDraft).toHaveBeenLastCalledWith({ id: "db" }, { page: "home", value: [] }, 2, 1, null);
    expect((await requestJson(app, env, "POST", "/theme/page-draft", { page: "product", value: { blocks: [] }, expectedDraftRevision: 2, basePublishedRevision: 1 })).status).toBe(400);
    expect((await requestJson(app, env, "POST", "/theme/page-draft", { page: "landing", slug: "products", value, expectedDraftRevision: 2, basePublishedRevision: 1 })).status).toBe(400);
    expect((await requestJson(app, env, "POST", "/theme/preview-session", { expectedDraftRevision: 0, sourceRevision: 1 })).status).toBe(200);
    expect(mocks.createThemePreviewSession).toHaveBeenCalledWith({ id: "db" }, 0, null, 1);
  });

  it("pages the history list five versions at a time", async () => {
    const { app, env } = createTestApp();
    const version = (revision: number) => ({
      id: `themev_${revision}`, revision, source: "publish", sourceRevision: null, publishedBy: "staff_1",
      publishedByName: "ক".repeat(300), createdAt: new Date(1_000), changes: [], moreChanges: 0, note: null,
    });
    mocks.listThemeVersions.mockResolvedValueOnce([9, 8, 7, 6, 5].map(version));
    const ok = await app.request(`/api/v1/admin/settings/theme/versions?limit=${THEME_VERSION_PAGE_LIMIT}&beforeRevision=10`, { method: "GET" }, env);
    const tooMany = await app.request(`/api/v1/admin/settings/theme/versions?limit=${THEME_VERSION_PAGE_LIMIT + 1}`, { method: "GET" }, env);
    expect(ok.status).toBe(200);
    expect(tooMany.status).toBe(400);
    expect(mocks.listThemeVersions).toHaveBeenCalledWith({ id: "db" }, { limit: THEME_VERSION_PAGE_LIMIT, beforeRevision: 10 });
    const body = (await ok.json()) as { data: { versions: Array<{ publishedByName: string }>; nextBeforeRevision: number | null; retained: number } };
    expect(body.data.nextBeforeRevision).toBe(5);
    expect(body.data.retained).toBe(THEME_VERSION_HISTORY_LIMIT);
    expect(body.data.versions[0]!.publishedByName).toHaveLength(200);
  });

  it("reads one version's whole document, and refuses mismatched queries", async () => {
    const { app, env } = createTestApp();
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.pages.landing.eid = { title: "Eid", description: "", sections: [] };
    mocks.getThemeVersion.mockResolvedValue({ revision: 4, theme });
    const version = await app.request("/api/v1/admin/settings/theme/document?source=version&revision=4", { method: "GET" }, env);
    expect(version.status).toBe(200);
    expect(version.headers.get("Content-Disposition")).toBe('inline; filename="theme-version-4.json"');
    expect(version.headers.get("Cache-Control")).toContain("no-store");
    expect(((await version.json()) as { data: unknown }).data).toEqual({ source: "version", revision: 4, document: theme });
    for (const query of ["source=version", "source=draft&revision=4", "source=published&revision=4", "source=version&revision=0"]) {
      const refused = await app.request(`/api/v1/admin/settings/theme/document?${query}`, { method: "GET" }, env);
      expect(refused.status, query).toBeGreaterThanOrEqual(400);
    }
    const draft = await app.request("/api/v1/admin/settings/theme/document", { method: "GET" }, env);
    expect(((await draft.json()) as { data: { revision: number; document: unknown } }).data).toMatchObject({ revision: 2, document: DEFAULT_STOREFRONT_THEME });
  });

  it("reports compact revisions and the landing pages to agents", async () => {
    const { app, env } = createTestApp();
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.pages.landing.eid = { title: "Eid", description: "", sections: theme.pages.home };
    mocks.getThemeWorkspace.mockResolvedValueOnce({
      published: { theme: DEFAULT_STOREFRONT_THEME, revision: 1 },
      draft: { theme, revision: 2, basePublishedRevision: 1, updatedAt: new Date(1_000) },
      draftDiffersFromLive: true,
      lastPublished: { revision: 1, publishedBy: "staff_1", publishedByName: "Rina", createdAt: new Date(500) },
    });
    const response = await app.request("/api/v1/admin/settings/theme/workspace", { method: "GET" }, env);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      published: { revision: 1 },
      draft: { revision: 2, basePublishedRevision: 1, updatedAt: new Date(1_000).toISOString() },
      draftDiffersFromLive: true,
      lastPublished: { revision: 1, publishedBy: "staff_1", publishedByName: "Rina", createdAt: new Date(500).toISOString() },
      landingPages: [{ slug: "eid", title: "Eid", sections: theme.pages.home.length }],
    });
  });

  it("creates a private preview of the saved draft", async () => {
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
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(body.data).toMatchObject({
      continuation: {
        url: "https://storefront.example.com/theme-preview/continue",
        method: "POST",
        fields: {
          continuationCode: `tpc_${"a".repeat(48)}`,
          path: "/",
          device: "full",
        },
      },
      draftRevision: 2,
      basePublishedRevision: 1,
    });
    expect(body.data).not.toHaveProperty("token");
    expect(JSON.stringify(body.data)).not.toContain("/tpc_");
    expect(body.data).not.toHaveProperty("theme");

  });

  it("publishes bounded body-only preview continuation response fields", () => {
    const { app } = createTestApp();
    const document = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Theme preview", version: "test" },
    }) as unknown as {
      paths: Record<string, Record<string, {
        responses?: Record<string, {
          content?: Record<string, { schema?: {
            properties?: Record<string, {
              properties?: Record<string, unknown>;
            }>;
          } }>;
        }>;
      }>>;
    };
    const responseSchema = document.paths[
      "/api/v1/admin/settings/theme/preview-session"
    ]?.post?.responses?.["200"]?.content?.["application/json"]?.schema;
    const data = responseSchema?.properties?.data as {
      properties?: Record<string, unknown>;
    } | undefined;
    const continuation = data?.properties?.continuation as {
      properties?: Record<string, unknown>;
    } | undefined;
    const fields = continuation?.properties?.fields as {
      properties?: Record<string, unknown>;
    } | undefined;

    expect(continuation?.properties?.url).toMatchObject({
      type: "string",
      format: "uri",
      maxLength: 512,
    });
    expect(continuation?.properties?.method).toMatchObject({
      type: "string",
      enum: ["POST"],
    });
    expect(fields?.properties?.continuationCode).toMatchObject({
      type: "string",
      minLength: 52,
      maxLength: 52,
      pattern: "^tpc_[A-Za-z0-9_-]{48}$",
    });
    expect(fields?.properties?.path).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 512,
    });
    expect(fields?.properties?.device).toMatchObject({
      type: "string",
      enum: ["full", "desktop", "mobile"],
    });
  });

  it("returns success after publishing or restoring a theme revision", async () => {
    const { app, env } = createTestApp();
    const publishResponse = await requestJson(
      app,
      env,
      "POST",
      "/theme/publish",
      { expectedPublishedRevision: 1, expectedDraftRevision: 2 },
    );
    const restoreResponse = await requestJson(
      app,
      env,
      "POST",
      "/theme/restore",
      {
        sourceRevision: 1,
        expectedDraftRevision: 3,
        basePublishedRevision: 2,
      },
    );

    expect(publishResponse.status).toBe(200);
    expect(restoreResponse.status).toBe(200);
    // Commands answer revisions only, never a document.
    expect(JSON.stringify(await restoreResponse.json())).not.toContain("\"theme\"");

  });
});
