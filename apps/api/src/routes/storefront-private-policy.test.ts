import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storefrontTemplateTheme } from "@scalius/shared/storefront-theme";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  resolveThemePreviewSession: vi.fn(),
}));

vi.mock("@scalius/core/modules/storefront", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/storefront")>()),
  getHomepageData: vi.fn(),
  getLayoutData: vi.fn(),
  getPageRenderData: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/settings")>()),
  resolveThemePreviewSession: mocks.resolveThemePreviewSession,
}));

import { getHomepageData } from "@scalius/core/modules/storefront";
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
      theme: storefrontTemplateTheme("marketplace"),
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
      data: { draftRevision: 7, theme: storefrontTemplateTheme("marketplace") },
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

  it("rejects malformed or extra cookie-bridge authority before resolution", async () => {
    for (const body of [
      { token: "tpv_short" },
      { token: `tpv_${"a".repeat(48)}`, unexpected: true },
    ]) {
      const response = await createTestApp().request(
        "/api/v1/storefront/theme-preview/resolve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.resolveThemePreviewSession).not.toHaveBeenCalled();
  });

  it("keeps the public homepage read to one fixed contract", async () => {
    vi.mocked(getHomepageData).mockResolvedValue({ sections: { lists: [], media: [] } } as never);
    const plain = await createTestApp().request("/api/v1/storefront/homepage");
    expect(plain.status).toBe(200);
    expect(getHomepageData).toHaveBeenCalledWith({});

    // Named reads (or any other query) never reach the database or the cache.
    vi.mocked(getHomepageData).mockClear();
    for (const query of ["?product=36~newest", "?media=m1", "?utm_source=ads"]) {
      const response = await createTestApp().request(`/api/v1/storefront/homepage${query}`);
      expect(response.status).toBe(400);
    }
    expect(getHomepageData).not.toHaveBeenCalled();
  });

  it("reads a preview draft's homepage sections behind its token, privately", async () => {
    const token = `tpv_${"a".repeat(48)}`;
    const draft = storefrontTemplateTheme("marketplace");
    mocks.resolveThemePreviewSession.mockResolvedValue({
      theme: draft,
      draftRevision: 7,
      basePublishedRevision: 4,
      expiresAt: 1_900_000_000,
    });
    const sections = { lists: [{ key: "on-sale", products: [], category: null, collection: null }], media: [] };
    vi.mocked(getHomepageData).mockResolvedValue({ sections } as never);

    const response = await createTestApp().request("/api/v1/storefront/theme-preview/homepage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
    await expect(response.json()).resolves.toMatchObject({ data: sections });
    // The reads come from the stored draft, never from the caller.
    const [, options] = vi.mocked(getHomepageData).mock.calls[0]!;
    expect(options?.requests?.lists.map((list) => list.key)).toEqual(["on-sale", "newest"]);

    mocks.resolveThemePreviewSession.mockResolvedValue(null);
    const expired = await createTestApp().request("/api/v1/storefront/theme-preview/homepage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(expired.status).toBe(404);
    const extra = await createTestApp().request("/api/v1/storefront/theme-preview/homepage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, product: ["36~newest"] }),
    });
    expect(extra.status).toBe(400);
  });
});
