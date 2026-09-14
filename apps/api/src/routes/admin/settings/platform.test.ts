import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import { PLATFORM_READINESS_FIX } from "@scalius/shared/platform-config";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getPlatformSettings: vi.fn(),
  savePlatformSettings: vi.fn(),
  invalidatePlatformConfigCache: vi.fn(),
  invalidateSiteSettingsCache: vi.fn(),
  invalidateStorefrontUrlCache: vi.fn(),
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/platform-settings.service", () => ({
  getPlatformSettings: mocks.getPlatformSettings,
  savePlatformSettings: mocks.savePlatformSettings,
  invalidatePlatformConfigCache: mocks.invalidatePlatformConfigCache,
  platformSettingsDocument: {
    invalidationGroups: ["layout", "homepage", "discovery", "checkout"],
  },
}));

vi.mock("@scalius/core/modules/settings", () => ({
  invalidateSiteSettingsCache: mocks.invalidateSiteSettingsCache,
  invalidateStorefrontUrlCache: mocks.invalidateStorefrontUrlCache,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

import { platformSettingsRoutes } from "./platform";

const STORED = {
  storefrontUrl: "https://shop.example.com",
  apiUrl: "",
  dashboardUrl: "https://dashboard.example.com",
  mediaUrl: "",
  customerAuthCookieDomain: "example.com",
  corsAllowedOrigins: ["https://mobile.example.com"],
};

const EFFECTIVE = {
  storefrontUrl: "https://shop.example.com",
  apiUrl: "https://api.example.com",
  dashboardUrl: "https://dashboard.example.com",
  mediaUrl: "",
  customerAuthCookieDomain: "example.com",
  corsAllowedOrigins: ["https://mobile.example.com"],
};

function createTestApp(options: { platformConfig?: typeof EFFECTIVE | undefined } = { platformConfig: EFFECTIVE }) {
  const db = { id: "db" };
  const cache = { id: "api-cache-kv" };
  const env = {
    CACHE: cache,
    PLATFORM_CONFIG: options.platformConfig,
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.getPlatformSettings.mockResolvedValue(STORED);
  mocks.savePlatformSettings.mockResolvedValue(STORED);
  mocks.invalidatePlatformConfigCache.mockResolvedValue(undefined);
  mocks.invalidateSiteSettingsCache.mockResolvedValue(undefined);
  mocks.invalidateStorefrontUrlCache.mockResolvedValue(undefined);
  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/settings", platformSettingsRoutes);
  return { app, env, db, cache };
}

function putJson(app: OpenAPIHono<{ Bindings: Env }>, env: Env, body: unknown) {
  return app.request(
    "/api/v1/admin/settings/platform",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("admin platform settings", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/v1/admin/settings/platform", () => {
    it("returns the stored origins, readiness, and the effective request-time origins without caching", async () => {
      const { app, env, db } = createTestApp();

      const response = await app.request("/api/v1/admin/settings/platform", { method: "GET" }, env);

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mocks.getPlatformSettings).toHaveBeenCalledWith(db);
      await expect(response.json()).resolves.toEqual({
        success: true,
        data: {
          ...STORED,
          readiness: {
            status: "incomplete",
            issues: [
              { code: "missing_api_url", message: "API URL is not configured.", fix: PLATFORM_READINESS_FIX },
              { code: "missing_media_url", message: "Media URL is not configured.", fix: PLATFORM_READINESS_FIX },
            ],
            missing: ["apiUrl", "mediaUrl"],
          },
          effective: {
            storefrontUrl: "https://shop.example.com",
            apiUrl: "https://api.example.com",
            dashboardUrl: "https://dashboard.example.com",
            mediaUrl: "",
          },
        },
      });
    });

    it("falls back to the stored origins for the effective view when no runtime config was composed", async () => {
      const { app, env } = createTestApp({ platformConfig: undefined });

      const response = await app.request("/api/v1/admin/settings/platform", { method: "GET" }, env);
      const body = await response.json() as { data: { effective: Record<string, string> } };

      expect(response.status).toBe(200);
      expect(body.data.effective).toEqual({
        storefrontUrl: "https://shop.example.com",
        apiUrl: "",
        dashboardUrl: "https://dashboard.example.com",
        mediaUrl: "",
      });
    });

    it("reports complete readiness once all four origins are stored", async () => {
      const { app, env } = createTestApp();
      mocks.getPlatformSettings.mockResolvedValue({
        ...STORED,
        apiUrl: "https://api.example.com",
        mediaUrl: "https://cdn.example.com",
      });

      const response = await app.request("/api/v1/admin/settings/platform", { method: "GET" }, env);
      const body = await response.json() as { data: { readiness: unknown } };

      expect(body.data.readiness).toEqual({ status: "ready", issues: [], missing: [] });
    });
  });

  describe("PUT /api/v1/admin/settings/platform", () => {
    it("saves a partial patch, invalidates every platform cache, and schedules storefront purges", async () => {
      const { app, env, db, cache } = createTestApp();
      const saved = {
        ...STORED,
        apiUrl: "https://api.example.com",
        mediaUrl: "https://cdn.example.com",
      };
      mocks.savePlatformSettings.mockResolvedValue(saved);

      const response = await putJson(app, env, {
        apiUrl: "https://api.example.com",
        mediaUrl: "https://cdn.example.com",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mocks.savePlatformSettings).toHaveBeenCalledWith(db, {
        apiUrl: "https://api.example.com",
        mediaUrl: "https://cdn.example.com",
      });
      expect(mocks.invalidatePlatformConfigCache).toHaveBeenCalledWith(cache);
      expect(mocks.invalidateSiteSettingsCache).toHaveBeenCalledWith(cache);
      expect(mocks.invalidateStorefrontUrlCache).toHaveBeenCalledWith(cache);
      expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
        ["layout", "homepage", "discovery", "checkout"],
        expect.anything(),
      );
      // The response reflects the persisted state, not the request-time env.
      await expect(response.json()).resolves.toEqual({
        success: true,
        data: {
          ...saved,
          readiness: { status: "ready", issues: [], missing: [] },
          effective: {
            storefrontUrl: "https://shop.example.com",
            apiUrl: "https://api.example.com",
            dashboardUrl: "https://dashboard.example.com",
            mediaUrl: "",
          },
        },
      });
    });

    it("accepts clearing values with empty strings and an empty CORS list", async () => {
      const { app, env, db } = createTestApp();

      const response = await putJson(app, env, {
        customerAuthCookieDomain: "",
        corsAllowedOrigins: [],
      });

      expect(response.status).toBe(200);
      expect(mocks.savePlatformSettings).toHaveBeenCalledWith(db, {
        customerAuthCookieDomain: "",
        corsAllowedOrigins: [],
      });
    });

    it.each([
      ["a non-array CORS list", { corsAllowedOrigins: "https://mobile.example.com" }],
      ["a non-string origin", { storefrontUrl: 123 }],
      ["an over-long origin", { apiUrl: `https://${"a".repeat(2_100)}.example.com` }],
      ["too many CORS origins", { corsAllowedOrigins: Array.from({ length: 21 }, (_, i) => `https://o${i}.example.com`) }],
      ["an over-long cookie domain", { customerAuthCookieDomain: "a".repeat(254) }],
    ])("rejects %s before touching the database", async (_label, body) => {
      const { app, env } = createTestApp();

      const response = await putJson(app, env, body);

      expect(response.status).toBe(400);
      expect(mocks.savePlatformSettings).not.toHaveBeenCalled();
      expect(mocks.invalidatePlatformConfigCache).not.toHaveBeenCalled();
      expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
    });

    it("surfaces service validation errors as 400 and skips cache invalidation", async () => {
      const { app, env } = createTestApp();
      mocks.savePlatformSettings.mockRejectedValueOnce(
        new ValidationError("API URL must be an HTTPS origin without credentials, path, query, or fragment. HTTP is limited to loopback development."),
      );

      const response = await putJson(app, env, { apiUrl: "http://api.example.com" });
      const body = await response.json() as { success: boolean; error: { message: string } };

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain("API URL must be an HTTPS origin");
      expect(mocks.invalidatePlatformConfigCache).not.toHaveBeenCalled();
      expect(mocks.invalidateSiteSettingsCache).not.toHaveBeenCalled();
      expect(mocks.invalidateStorefrontUrlCache).not.toHaveBeenCalled();
      expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
    });
  });
});
