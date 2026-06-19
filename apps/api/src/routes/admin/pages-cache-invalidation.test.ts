import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  listPages: vi.fn(),
  getPageById: vi.fn(),
  createPage: vi.fn(),
  updatePage: vi.fn(),
  deletePage: vi.fn(),
  bulkDeletePages: vi.fn(),
  bulkPublishPages: vi.fn(),
  bulkUnpublishPages: vi.fn(),
  restorePages: vi.fn(),
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("@scalius/core/modules/pages", async () => {
  const actual = await vi.importActual<typeof import("@scalius/core/modules/pages")>(
    "@scalius/core/modules/pages",
  );
  return {
    ...actual,
    listPages: mocks.listPages,
    getPageById: mocks.getPageById,
    createPage: mocks.createPage,
    updatePage: mocks.updatePage,
    deletePage: mocks.deletePage,
    bulkDeletePages: mocks.bulkDeletePages,
    bulkPublishPages: mocks.bulkPublishPages,
    bulkUnpublishPages: mocks.bulkUnpublishPages,
    restorePages: mocks.restorePages,
  };
});

vi.mock("../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
  MAX_STOREFRONT_EXACT_HTML_PATHS: 20,
}));

import { adminPageRoutes } from "./pages";

function createPageBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "About Us",
    slug: "about-us",
    content: "<p>About Scalius</p>",
    metaTitle: null,
    metaDescription: null,
    isPublished: true,
    sortOrder: 0,
    hideHeader: false,
    hideFooter: false,
    hideTitle: false,
    ...overrides,
  };
}

function createDb(publicRows = [{ slug: "about-us" }]) {
  return {
    select: vi.fn(() => {
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => Promise.resolve(publicRows)),
      };
      return query;
    }),
  };
}

function createTestApp(publicRows = [{ slug: "about-us" }]) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = createDb(publicRows);
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;

  mocks.createPage.mockResolvedValue({ id: "page_1" });
  mocks.updatePage.mockResolvedValue(undefined);
  mocks.deletePage.mockResolvedValue(undefined);
  mocks.bulkDeletePages.mockResolvedValue(undefined);
  mocks.bulkPublishPages.mockResolvedValue(undefined);
  mocks.bulkUnpublishPages.mockResolvedValue(undefined);
  mocks.restorePages.mockResolvedValue(undefined);
  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/pages", adminPageRoutes);
  return { app, db, env };
}

async function requestJson(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  path: string,
  method: string,
  body?: unknown,
) {
  return app.request(
    `/api/v1/admin/pages${path}`,
    {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

describe("admin page cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { label: "create published page", path: "", method: "POST", body: createPageBody(), status: 201 },
    { label: "update public page", path: "/page_1", method: "PUT", body: { title: "About Scalius" }, status: 200 },
    { label: "bulk publish pages", path: "/bulk-publish", method: "POST", body: { ids: ["page_1"] }, status: 204 },
    { label: "bulk restore pages", path: "/bulk-restore", method: "POST", body: { ids: ["page_1"] }, status: 204 },
    { label: "restore page", path: "/page_1/restore", method: "POST", status: 200 },
  ])("warms exact public CMS paths after $label", async ({ path, method, body, status }) => {
    const { app, env } = createTestApp([{ slug: "about-us" }]);

    const response = await requestJson(app, env, path, method, body);

    expect(response.status).toBe(status);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["pages", "layout"],
      expect.objectContaining({ env }),
      { htmlPaths: ["/about-us"] },
    );
  });

  it("does not exact-warm unpublished create/update results", async () => {
    const { app, env } = createTestApp([]);

    const response = await requestJson(
      app,
      env,
      "",
      "POST",
      createPageBody({ slug: "draft-page", isPublished: false }),
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["pages", "layout"],
      expect.objectContaining({ env }),
      { htmlPaths: [] },
    );
  });

  it.each([
    { label: "soft delete", path: "/page_1", method: "DELETE", status: 204 },
    { label: "permanent delete", path: "/page_1/permanent", method: "DELETE", status: 204 },
    { label: "bulk delete", path: "/bulk-delete", method: "POST", body: { pageIds: ["page_1"], permanent: false }, status: 204 },
    { label: "bulk unpublish", path: "/bulk-unpublish", method: "POST", body: { ids: ["page_1"] }, status: 204 },
  ])("keeps freshness invalidation but skips warming now-hidden pages after $label", async ({ path, method, body, status }) => {
    const { app, env, db } = createTestApp([{ slug: "about-us" }]);

    const response = await requestJson(app, env, path, method, body);

    expect(response.status).toBe(status);
    expect(db.select).not.toHaveBeenCalled();
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["pages", "layout"],
      expect.objectContaining({ env }),
      {},
    );
  });
});
