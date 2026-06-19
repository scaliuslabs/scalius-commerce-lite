import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getKv: vi.fn(),
  invalidateSiteSettingsCache: vi.fn(),
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  getCurrencySettings: vi.fn(),
  saveCurrencySettings: vi.fn(),
  getGeneralSettings: vi.fn(),
  saveHeaderConfig: vi.fn(),
  saveFooterConfig: vi.fn(),
  getThemeSettings: vi.fn(),
  saveThemeSettings: vi.fn(),
  getMediaOptimizationSettings: vi.fn(),
  isValidMediaHostInput: vi.fn(),
  saveMediaOptimizationSettings: vi.fn(),
  getSeoSettings: vi.fn(),
  saveSeoSettings: vi.fn(),
  getStorefrontUrlSetting: vi.fn(),
  saveStorefrontUrl: vi.fn(),
  getAllowedCountries: vi.fn(),
  saveAllowedCountries: vi.fn(),
}));

vi.mock("../../../utils/kv-cache", () => ({
  getKv: mocks.getKv,
}));

vi.mock("@scalius/core/modules/settings", () => ({
  invalidateSiteSettingsCache: mocks.invalidateSiteSettingsCache,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/core/modules/settings/site-settings.service", () => ({
  getCurrencySettings: mocks.getCurrencySettings,
  saveCurrencySettings: mocks.saveCurrencySettings,
  getGeneralSettings: mocks.getGeneralSettings,
  saveHeaderConfig: mocks.saveHeaderConfig,
  saveFooterConfig: mocks.saveFooterConfig,
  getThemeSettings: mocks.getThemeSettings,
  saveThemeSettings: mocks.saveThemeSettings,
  getMediaOptimizationSettings: mocks.getMediaOptimizationSettings,
  isValidMediaHostInput: mocks.isValidMediaHostInput,
  saveMediaOptimizationSettings: mocks.saveMediaOptimizationSettings,
  getSeoSettings: mocks.getSeoSettings,
  saveSeoSettings: mocks.saveSeoSettings,
  getStorefrontUrlSetting: mocks.getStorefrontUrlSetting,
  saveStorefrontUrl: mocks.saveStorefrontUrl,
  getAllowedCountries: mocks.getAllowedCountries,
  saveAllowedCountries: mocks.saveAllowedCountries,
}));

import { siteSettingsRoutes } from "./site";

function createTestApp() {
  const db = { id: "db" };
  const kv = { delete: vi.fn() };
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.getKv.mockReturnValue(kv);
  mocks.invalidateSiteSettingsCache.mockResolvedValue(undefined);
  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
  mocks.saveCurrencySettings.mockResolvedValue(undefined);
  mocks.saveHeaderConfig.mockResolvedValue(undefined);
  mocks.saveFooterConfig.mockResolvedValue(undefined);
  mocks.saveThemeSettings.mockResolvedValue(undefined);
  mocks.isValidMediaHostInput.mockReturnValue(true);
  mocks.saveMediaOptimizationSettings.mockResolvedValue({
    enabled: true,
    canonicalCdnUrl: "cdn.example.com",
    allowedImageHosts: [],
    canonicalHostAliases: [],
  });
  mocks.saveSeoSettings.mockResolvedValue(undefined);
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
      body: { colors: { primary: "#000000" } },
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
      groups: ["homepage"],
    },
    {
      path: "/storefront-url",
      method: "POST" as const,
      body: { storefrontUrl: "https://storefront.example.com" },
      groups: ["layout"],
    },
    {
      path: "/allowed-countries",
      method: "PUT" as const,
      body: { allowedCountries: ["BD"], mode: "include" },
      groups: ["checkout"],
    },
  ])("invalidates $groups after $path saves", async ({ path, method, body, groups }) => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, method, path, body);

    expect(response.status).toBe(200);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      groups,
      expect.objectContaining({ env }),
    );
  });

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

  it("rejects unsafe theme colors before saving or invalidating cache", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, "POST", "/theme", {
      colors: {
        primary: "#059669",
        background: "#fff; color: red",
        unsafe: "#000",
      },
    });

    expect(response.status).toBe(400);
    expect(mocks.saveThemeSettings).not.toHaveBeenCalled();
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
  });
});
