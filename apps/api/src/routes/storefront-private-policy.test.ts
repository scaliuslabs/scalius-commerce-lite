import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  resolveThemePreviewSession: vi.fn(),
}));

vi.mock("@scalius/core/modules/storefront/storefront.service", () => ({
  getHomepageData: vi.fn(),
  getLayoutData: vi.fn(),
  getPageRenderData: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/site-settings.service", () => ({
  resolveThemePreviewSession: mocks.resolveThemePreviewSession,
}));

import { storefrontRoutes } from "./storefront";

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/storefront", storefrontRoutes);
  return app;
}

describe("storefront private cache policy", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves an exact theme preview snapshot without public caching", async () => {
    const token = `tpv_${"a".repeat(48)}`;
    mocks.resolveThemePreviewSession.mockResolvedValue({
      theme: { density: "compact", colors: {} },
      draftRevision: 7,
      basePublishedRevision: 4,
      expiresAt: 1_900_000_000,
    });

    const response = await createTestApp().request(
      "/api/v1/storefront/theme-preview/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { draftRevision: 7, theme: { density: "compact" } },
    });
    expect(mocks.resolveThemePreviewSession).toHaveBeenCalledWith({}, token);
  });

  it("fails an expired theme preview closed and keeps the miss private", async () => {
    mocks.resolveThemePreviewSession.mockResolvedValue(null);

    const response = await createTestApp().request(
      "/api/v1/storefront/theme-preview/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: `tpv_${"b".repeat(48)}` }),
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-cache, no-store, must-revalidate",
    );
  });
});
