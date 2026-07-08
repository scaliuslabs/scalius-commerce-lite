import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertBrowserSmokeWorkerStartupPolicy,
  buildCategoryFixturePayload,
  buildProductFixturePayload,
  ensureCategoryFixture,
  ensureProductFixture,
  findItemBySlug,
  getAdminBrowserSmokeConfig,
  isAdminReady,
  normalizeBrowserSmokeOrigin,
} from "./dev-admin-browser-smoke.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local admin product rich-text browser smoke CLI", () => {
  it("rejects production and non-local mutation targets", () => {
    expect(() => getAdminBrowserSmokeConfig(["--api", "https://api.scalius.com"], {})).toThrow(
      /known production/,
    );
    expect(() => getAdminBrowserSmokeConfig(["--admin", "https://dashboard.scalius.com"], {})).toThrow(
      /known production/,
    );
    expect(() => getAdminBrowserSmokeConfig(["--api", "https://staging.example.com"], {})).toThrow(
      /non-local/,
    );
  });

  it("accepts loopback targets and defaults to disposable smoke state", () => {
    const config = getAdminBrowserSmokeConfig([
      "smoke",
      "--api",
      "http://127.0.0.1:8787/",
      "--admin",
      "http://localhost:4323/",
      "--email",
      "admin@example.test",
      "--password",
      "ExamplePassword123!",
      "--name",
      "Example Admin",
      "--category-slug",
      "browser-smoke-category",
      "--product-slug",
      "browser-smoke-product",
      "--no-start",
      "--skip-setup",
      "--reset-admin",
      "--headed",
    ], {});

    expect(config).toMatchObject({
      command: "smoke",
      apiBaseUrl: "http://127.0.0.1:8787",
      adminBaseUrl: "http://localhost:4323",
      email: "admin@example.test",
      password: "ExamplePassword123!",
      name: "Example Admin",
      categorySlug: "browser-smoke-category",
      productSlug: "browser-smoke-product",
      noStart: true,
      skipSetup: true,
      resetAdmin: true,
      headless: false,
    });
    expect(config.wranglerState).toContain("scalius-admin-browser-smoke-state");
    expect(config.wranglerState).not.toContain(".wrangler");
  });

  it("rejects path-bearing base URLs before worker work", () => {
    expect(() => normalizeBrowserSmokeOrigin("http://localhost:4323/admin", "admin URL")).toThrow(
      /without a path/,
    );
    expect(() => normalizeBrowserSmokeOrigin("http://localhost:8787?x=1", "API URL")).toThrow(
      /without a path/,
    );
  });

  it("rejects value-style flags without values and short passwords", () => {
    expect(() => getAdminBrowserSmokeConfig(["--browser"], {})).toThrow(
      /Option --browser requires a value/,
    );
    expect(() => getAdminBrowserSmokeConfig(["--password", "short"], {})).toThrow(
      /at least 12 characters/,
    );
  });

  it("does not treat arbitrary services on the admin port as ready", async () => {
    const fetchMock = vi.fn(async () => new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(isAdminReady({ adminBaseUrl: "http://localhost:4323" })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts only JSON responses from the exact Better Auth session route", async () => {
    const fetchMock = vi.fn(async () => new Response("null", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(isAdminReady({ adminBaseUrl: "http://localhost:4323" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4323/api/auth/get-session",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("accepts an unauthenticated JSON session denial from the admin worker", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(isAdminReady({ adminBaseUrl: "http://localhost:4323" })).resolves.toBe(true);
  });

  it("rejects non-JSON session responses before sign-in", async () => {
    const fetchMock = vi.fn(async () => new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(isAdminReady({ adminBaseUrl: "http://localhost:4323" })).resolves.toBe(false);
  });

  it("refuses to reuse running local workers unless explicitly requested", () => {
    const base = {
      apiBaseUrl: "http://localhost:8787",
      adminBaseUrl: "http://localhost:4323",
    };

    expect(() => assertBrowserSmokeWorkerStartupPolicy({
      ...base,
      apiWasRunning: true,
      adminWasRunning: false,
      noStart: false,
    })).toThrow(/Refusing to reuse already-running API/);
    expect(() => assertBrowserSmokeWorkerStartupPolicy({
      ...base,
      apiWasRunning: true,
      adminWasRunning: true,
      noStart: true,
    })).not.toThrow();
    expect(() => assertBrowserSmokeWorkerStartupPolicy({
      ...base,
      apiWasRunning: true,
      adminWasRunning: false,
      noStart: true,
    })).toThrow(/admin at http:\/\/localhost:4323 is not running/);
  });

  it("builds non-discoverable disposable fixture payloads", () => {
    const category = buildCategoryFixturePayload({ slug: "smoke-category" });
    expect(category).toMatchObject({
      slug: "smoke-category",
      noIndex: true,
      excludeFromSitemap: true,
      image: null,
    });

    const product = buildProductFixturePayload({
      slug: "smoke-product",
      categoryId: "cat_1",
    });
    expect(product).toMatchObject({
      slug: "smoke-product",
      categoryId: "cat_1",
      isActive: false,
      noIndex: true,
      excludeFromSitemap: true,
      excludeFromProductFeed: true,
      productCondition: "new",
    });
    expect(product.images).toEqual([]);
    expect(product.additionalInfo).toEqual([]);
  });

  it("requires categoryId for product fixture payloads", () => {
    expect(() => buildProductFixturePayload({ slug: "smoke-product" })).toThrow(
      /categoryId/,
    );
  });

  it("finds exact fixture slugs only", () => {
    expect(findItemBySlug([{ slug: "a", id: "1" }, { slug: "b", id: "2" }], "b")).toEqual({
      slug: "b",
      id: "2",
    });
    expect(findItemBySlug([{ slug: "almost", id: "1" }], "al")).toBeNull();
  });

  it("reuses an existing category fixture before creating", async () => {
    const calls = [];
    const requestAdmin = async (...args) => {
      calls.push(args);
      return {
        status: 200,
        body: {
          success: true,
          data: {
            categories: [{ id: "cat_existing", slug: "smoke-category", name: "Smoke" }],
          },
        },
      };
    };

    const result = await ensureCategoryFixture({
      config: { categorySlug: "smoke-category" },
      cookieHeader: "cookie=1",
      requestAdmin,
    });

    expect(result).toEqual({ id: "cat_existing", slug: "smoke-category", created: false });
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("GET");
  });

  it("creates a product fixture when no exact slug exists", async () => {
    const calls = [];
    const requestAdmin = async (config, method, path, body, cookieHeader, expectedStatuses) => {
      calls.push({ method, path, body, cookieHeader, expectedStatuses });
      if (method === "GET") {
        return {
          status: 200,
          body: { success: true, data: { products: [] } },
        };
      }
      return {
        status: 201,
        body: { success: true, data: { id: "prod_created" } },
      };
    };

    const result = await ensureProductFixture({
      config: { productSlug: "smoke-product" },
      cookieHeader: "cookie=1",
      categoryId: "cat_1",
      requestAdmin,
    });

    expect(result).toEqual({ id: "prod_created", slug: "smoke-product", created: true });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[1].path).toBe("/api/v1/admin/products");
    expect(calls[1].body).toMatchObject({
      slug: "smoke-product",
      categoryId: "cat_1",
      isActive: false,
    });
    expect(calls[1].expectedStatuses).toEqual([201, 409]);
  });
});
