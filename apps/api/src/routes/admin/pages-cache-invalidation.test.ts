import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
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
  const actual = await vi.importActual<
    typeof import("@scalius/core/modules/pages")
  >("@scalius/core/modules/pages");
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
  invalidateApiAndScheduleStorefrontGroups:
    mocks.invalidateApiAndScheduleStorefrontGroups,
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

function createTestApp(
  permissions = new Set([PERMISSIONS.PAGES_PUBLISH]),
) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = { id: "db" };
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;

  mocks.createPage.mockResolvedValue({ id: "page_1", revision: 1 });
  mocks.updatePage.mockResolvedValue({ revision: 2 });
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
    c.set("adminPermissions", permissions);
    await next();
  });
  app.route("/admin/pages", adminPageRoutes);
  return { app, env };
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
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
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
    { label: "published create", path: "", method: "POST", body: createPageBody(), status: 201 },
    { label: "draft create", path: "", method: "POST", body: createPageBody({ isPublished: false }), status: 201 },
    { label: "update", path: "/page_1", method: "PUT", body: { expectedRevision: 1, title: "About Scalius" }, status: 200 },
    { label: "bulk publish", path: "/bulk-publish", method: "POST", body: { pages: [{ id: "page_1", expectedRevision: 1 }] }, status: 204 },
    { label: "bulk unpublish", path: "/bulk-unpublish", method: "POST", body: { pages: [{ id: "page_1", expectedRevision: 1 }] }, status: 204 },
    { label: "bulk restore", path: "/bulk-restore", method: "POST", body: { pages: [{ id: "page_1", expectedRevision: 1 }] }, status: 204 },
    { label: "restore", path: "/page_1/restore", method: "POST", body: { expectedRevision: 1 }, status: 200 },
    { label: "soft delete", path: "/page_1", method: "DELETE", body: { expectedRevision: 1 }, status: 204 },
    { label: "permanent delete", path: "/page_1/permanent", method: "DELETE", body: { expectedRevision: 1 }, status: 204 },
    { label: "bulk delete", path: "/bulk-delete", method: "POST", body: { pages: [{ id: "page_1", expectedRevision: 1 }], permanent: false }, status: 204 },
  ])("purges the semantic page projection after $label", async ({ path, method, body, status }) => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, path, method, body);

    expect(response.status).toBe(status);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["pages"],
      expect.objectContaining({ env }),
    );
  });

  it("passes the caller's publication authority into create and edit services", async () => {
    const { app, env } = createTestApp(new Set());

    await requestJson(app, env, "", "POST", createPageBody({ isPublished: false }));
    await requestJson(app, env, "/page_1", "PUT", {
      expectedRevision: 1,
      title: "Still a draft",
      isPublished: false,
    });

    expect(mocks.createPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isPublished: false }),
      { canPublish: false },
    );
    expect(mocks.updatePage).toHaveBeenCalledWith(
      expect.anything(),
      "page_1",
      expect.objectContaining({ isPublished: false }),
      { canPublish: false },
    );
  });
});
