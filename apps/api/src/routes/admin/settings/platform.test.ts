import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@scalius/core/errors";
import { PLATFORM_READINESS_FIX } from "@scalius/shared/platform-config";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getPlatformSettingsDocument: vi.fn(),
  savePlatformSettings: vi.fn(),

}));

vi.mock("@scalius/core/modules/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/platform")>()),
  getPlatformSettingsDocument: mocks.getPlatformSettingsDocument,
  savePlatformSettings: mocks.savePlatformSettings,
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

  mocks.getPlatformSettingsDocument.mockResolvedValue({ value: STORED, revision: 4 });
  mocks.savePlatformSettings.mockResolvedValue({ value: STORED, revision: 5 });

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
      body: JSON.stringify({ expectedRevision: 4, ...(body as object) }),
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
      expect(mocks.getPlatformSettingsDocument).toHaveBeenCalledWith(db);
      await expect(response.json()).resolves.toEqual({
        success: true,
        data: {
          ...STORED,
          revision: 4,
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
          dashboardBasePath: "",
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
      mocks.getPlatformSettingsDocument.mockResolvedValue({
        value: { ...STORED, apiUrl: "https://api.example.com", mediaUrl: "https://cdn.example.com" },
        revision: 4,
      });

      const response = await app.request("/api/v1/admin/settings/platform", { method: "GET" }, env);
      const body = await response.json() as { data: { readiness: unknown } };

      expect(body.data.readiness).toEqual({ status: "ready", issues: [], missing: [] });
    });
  });

  describe("PUT /api/v1/admin/settings/platform", () => {
    it("saves a partial patch through the platform cache", async () => {
      const { app, env, db, cache } = createTestApp();
      const saved = {
        ...STORED,
        apiUrl: "https://api.example.com",
        mediaUrl: "https://cdn.example.com",
      };
      mocks.savePlatformSettings.mockResolvedValue({ value: saved, revision: 5 });

      const response = await putJson(app, env, {
        apiUrl: "https://api.example.com",
        mediaUrl: "https://cdn.example.com",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mocks.savePlatformSettings).toHaveBeenCalledWith(db, {
        apiUrl: "https://api.example.com",
        mediaUrl: "https://cdn.example.com",
      }, cache, { expectedRevision: 4 });

      // The response reflects the persisted state, not the request-time env.
      await expect(response.json()).resolves.toEqual({
        success: true,
        data: {
          ...saved,
          revision: 5,
          readiness: { status: "ready", issues: [], missing: [] },
          effective: {
            storefrontUrl: "https://shop.example.com",
            apiUrl: "https://api.example.com",
            dashboardUrl: "https://dashboard.example.com",
            mediaUrl: "",
          },
          dashboardBasePath: "",
        },
      });
    });

    it("passes partial automation patches through and derives the dashboard base path", async () => {
      const { app, env, db } = createTestApp();
      const saved = {
        ...STORED,
        dashboardUrl: "https://shop.example.com/ops/dashboard",
        setupTokenRequired: true,
        identityHandoff: {
          enabled: true,
          issuer: "https://idp.example.com",
          audience: "scalius:store-1",
          jwksUrl: "",
          localLoginDisabled: false,
        },
      };
      mocks.savePlatformSettings.mockResolvedValue({ value: saved, revision: 5 });

      const response = await putJson(app, env, {
        dashboardUrl: "https://shop.example.com/ops/dashboard",
        setupTokenRequired: true,
        identityHandoff: { enabled: true, issuer: "https://idp.example.com", audience: "scalius:store-1" },
      });
      const body = await response.json() as { data: Record<string, unknown> };

      expect(response.status).toBe(200);
      expect(mocks.savePlatformSettings).toHaveBeenCalledWith(db, {
        dashboardUrl: "https://shop.example.com/ops/dashboard",
        setupTokenRequired: true,
        identityHandoff: { enabled: true, issuer: "https://idp.example.com", audience: "scalius:store-1" },
      }, expect.anything(), { expectedRevision: 4 });
      expect(body.data.dashboardBasePath).toBe("/ops/dashboard");
      expect(body.data.identityHandoff).toEqual(saved.identityHandoff);
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
      }, expect.anything(), { expectedRevision: 4 });
    });

    it.each([
      ["a non-array CORS list", { corsAllowedOrigins: "https://mobile.example.com" }],
      ["a non-string origin", { storefrontUrl: 123 }],
      ["an over-long origin", { apiUrl: `https://${"a".repeat(2_100)}.example.com` }],
      ["too many CORS origins", { corsAllowedOrigins: Array.from({ length: 21 }, (_, i) => `https://o${i}.example.com`) }],
      ["an over-long cookie domain", { customerAuthCookieDomain: "a".repeat(254) }],
      ["a non-boolean setup token flag", { setupTokenRequired: "yes" }],
      ["an over-long handoff issuer", { identityHandoff: { issuer: "a".repeat(513) } }],
    ])("rejects %s before touching the database", async (_label, body) => {
      const { app, env } = createTestApp();

      const response = await putJson(app, env, body);

      expect(response.status).toBe(400);
      expect(mocks.savePlatformSettings).not.toHaveBeenCalled();

    });

    it("surfaces service validation errors as 400 and skips write behavior", async () => {
      const { app, env } = createTestApp();
      mocks.savePlatformSettings.mockRejectedValueOnce(
        new ValidationError("API URL must be an HTTPS origin without credentials, path, query, or fragment. HTTP is limited to loopback development."),
      );

      const response = await putJson(app, env, { apiUrl: "http://api.example.com" });
      const body = await response.json() as { success: boolean; error: { message: string } };

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.message).toContain("API URL must be an HTTPS origin");

    });
  });
});
