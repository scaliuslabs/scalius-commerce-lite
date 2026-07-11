import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  getHomepageData: vi.fn(),
  getLayoutData: vi.fn(),
  getPageRenderData: vi.fn(),
}));

vi.mock("@scalius/core/modules/storefront/storefront.service", () => ({
  getHomepageData: mocks.getHomepageData,
  getLayoutData: mocks.getLayoutData,
  getPageRenderData: mocks.getPageRenderData,
}));

import { storefrontRoutes } from "./storefront";

function createKvMock() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(
      async (
        key: string,
        value: string,
        _options?: { expirationTtl?: number },
      ) => {
        store.set(key, value);
      },
    ),
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
      keys: Array.from(store.keys())
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    })),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };

  return { kv, store };
}

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

describe("storefront consolidated route caching", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("caches consolidated homepage data through API KV", async () => {
    const app = createTestApp();
    const { kv, store } = createKvMock();

    mocks.getHomepageData.mockResolvedValue({
      seo: { homepageTitle: "Summer Deals" },
      hero: {},
      collections: [],
    });

    const first = await app.request(
      "/api/v1/storefront/homepage",
      {},
      { CACHE: kv } as unknown as Env,
    );
    const firstBody = await first.json();

    mocks.getHomepageData.mockResolvedValue({
      seo: { homepageTitle: "Should not be read on cache hit" },
      hero: {},
      collections: [],
    });

    const second = await app.request(
      "/api/v1/storefront/homepage",
      {},
      { CACHE: kv } as unknown as Env,
    );
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(first.headers.get("Cache-Control")).toBe(
      "public, max-age=0, stale-while-revalidate=120, stale-if-error=300",
    );
    expect(first.headers.get("Cache-Control")).not.toContain("no-store");
    expect(secondBody).toEqual(firstBody);
    expect(mocks.getHomepageData).toHaveBeenCalledTimes(1);
    expect([...store.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^sc:api:storefront:homepage:\/api\/v1\/storefront\/homepage#f:[0-9a-f]+$/,
        ),
      ]),
    );
  });

  it("caches CMS page render data by slug through the exact page prefix", async () => {
    const app = createTestApp();
    const { kv, store } = createKvMock();

    mocks.getPageRenderData.mockResolvedValue({
      page: { id: "page_1", slug: "about-us", title: "About Us" },
    });

    const first = await app.request(
      "/api/v1/storefront/pages/slug/about-us",
      {},
      { CACHE: kv } as unknown as Env,
    );
    await first.text();

    mocks.getPageRenderData.mockResolvedValue({
      page: { id: "page_1", slug: "about-us", title: "Changed" },
    });

    const second = await app.request(
      "/api/v1/storefront/pages/slug/about-us",
      {},
      { CACHE: kv } as unknown as Env,
    );
    const secondBody = await second.json() as {
      data?: { page?: { title?: string } };
    };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(second.headers.get("Cache-Control")).not.toContain("no-store");
    expect(secondBody.data?.page?.title).toBe("About Us");
    expect(mocks.getPageRenderData).toHaveBeenCalledTimes(1);
    expect(mocks.getPageRenderData).toHaveBeenCalledWith({}, "about-us");
    expect([...store.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^sc:api:storefront:page:\/api\/v1\/storefront\/pages\/slug\/about-us#f:[0-9a-f]+$/,
        ),
      ]),
    );
  });

  it("does not cache missing CMS page render responses", async () => {
    const app = createTestApp();
    const { kv, store } = createKvMock();

    mocks.getPageRenderData.mockResolvedValue(null);

    const response = await app.request(
      "/api/v1/storefront/pages/slug/missing-page",
      {},
      { CACHE: kv } as unknown as Env,
    );
    const body = await response.json() as { success?: boolean };

    expect(response.status).toBe(404);
    expect(response.headers.get("X-Cache")).toBe("MISS");
    expect(body.success).toBe(false);
    expect([...store.keys()]).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^sc:api:storefront:page:\/api\/v1\/storefront\/pages\/slug\/missing-page#f:[0-9a-f]+$/,
        ),
      ]),
    );
  });
});
