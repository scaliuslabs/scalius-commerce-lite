import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { platformRoutes } from "./platform";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

function createApp(config: typeof RESOLVED_CONFIG | null = RESOLVED_CONFIG) {
  const { db, sqlite } = createSqliteD1Database();
  if (config) sqlite.prepare("INSERT INTO settings (id, category, key, value, type) VALUES ('platform', 'platform', 'document', ?, 'json')").run(JSON.stringify(config));
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.use("*", async (c, next) => { c.set("db", db); await next(); });
  app.route("/platform", platformRoutes);
  return app;
}

const RESOLVED_CONFIG = {
  storefrontUrl: "https://shop.example.com",
  apiUrl: "https://api.example.com",
  dashboardUrl: "https://dashboard.example.com",
  mediaUrl: "https://cdn.example.com",
  customerAuthCookieDomain: "example.com",
  corsAllowedOrigins: ["https://mobile.example.com"],
  setupTokenRequired: true,
  identityHandoff: {
    enabled: true,
    issuer: "https://idp.example.com",
    audience: "scalius:store-1",
    jwksUrl: "",
    localLoginDisabled: true,
  },
};

describe("GET /api/v1/platform", () => {
  it("reads current public configuration even when the entry-time KV hint is stale", async () => {
    const response = await createApp().request(
      "/api/v1/platform",
      {},
      { PLATFORM_CONFIG: { ...RESOLVED_CONFIG, storefrontUrl: "https://old.example.com" } } as unknown as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        storefrontUrl: "https://shop.example.com",
        apiUrl: "https://api.example.com",
        dashboardUrl: "https://dashboard.example.com",
        mediaUrl: "https://cdn.example.com",
        setupTokenRequired: true,
        identityHandoff: {
          enabled: true,
          issuer: "https://idp.example.com",
          audience: "scalius:store-1",
          jwksUrl: "",
          localLoginDisabled: true,
        },
      },
    });
  });

  it("does not leak the cookie domain or CORS list into the public payload", async () => {
    const response = await createApp().request(
      "/api/v1/platform",
      {},
      { PLATFORM_CONFIG: RESOLVED_CONFIG } as unknown as Env,
    );
    const text = await response.text();

    expect(text).not.toContain("customerAuthCookieDomain");
    expect(text).not.toContain("corsAllowedOrigins");
    expect(text).not.toContain("mobile.example.com");
  });

  it("answers with empty origins when the platform is not configured yet", async () => {
    const response = await createApp(null).request("/api/v1/platform", {}, {} as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        storefrontUrl: "",
        apiUrl: "",
        dashboardUrl: "",
        mediaUrl: "",
        setupTokenRequired: false,
        identityHandoff: {
          enabled: false,
          issuer: "",
          audience: "",
          jwksUrl: "",
          localLoginDisabled: false,
        },
      },
    });
  });

  it("exposes a stable public operation id", () => {
    const spec = createApp().getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "platform", version: "test" },
    });
    const operation = (spec.paths?.["/api/v1/platform"] as Record<string, { operationId?: string }> | undefined)?.get;

    expect(operation?.operationId).toBe("storefront.platform.get");
  });
});
