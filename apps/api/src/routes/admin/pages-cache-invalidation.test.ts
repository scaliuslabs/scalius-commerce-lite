import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

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
  invalidateApiAndStorefrontGroups: vi.fn(),
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
  invalidateApiAndStorefrontGroups: mocks.invalidateApiAndStorefrontGroups,
  invalidateApiAndScheduleStorefrontGroups:
    mocks.invalidateApiAndScheduleStorefrontGroups,
  getOptionalExecutionContext: vi.fn(() => undefined),
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

function createDb(
  publicRows: Array<{
    slug: string;
    contentType?: "page" | "article";
  }> = [{ slug: "about-us" }],
  subsequentPublicRows: Array<
    Array<{ slug: string; contentType?: "page" | "article" }>
  > = [],
) {
  const rowBatches = [publicRows, ...subsequentPublicRows];
  let selectCall = 0;
  return {
    select: vi.fn(() => {
      const rows =
        rowBatches[Math.min(selectCall, rowBatches.length - 1)] ?? [];
      selectCall += 1;
      const query = {
        from: vi.fn(),
        where: vi.fn(() => Promise.resolve(rows)),
      };
      query.from.mockReturnValue(query);
      return query;
    }),
  };
}

function createTestApp(
  publicRows: Array<{
    slug: string;
    contentType?: "page" | "article";
  }> = [{ slug: "about-us" }],
  permissions = new Set([PERMISSIONS.PAGES_PUBLISH]),
  subsequentPublicRows: Array<
    Array<{ slug: string; contentType?: "page" | "article" }>
  > = [],
) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = createDb(publicRows, subsequentPublicRows);
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
  mocks.invalidateApiAndStorefrontGroups.mockResolvedValue({
    attempted: true,
    ok: true,
    status: 200,
  });
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
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

describe("admin page cache invalidation", () => {
  const discoveryPaths = [
    "/sitemap-pages.xml",
    "/blog",
    "/blog/feed.xml",
    "/sitemap-articles.xml",
  ];
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      label: "create published page",
      path: "",
      method: "POST",
      body: createPageBody(),
      status: 201,
    },
    {
      label: "update public page",
      path: "/page_1",
      method: "PUT",
      body: { expectedRevision: 1, title: "About Scalius" },
      status: 200,
    },
    {
      label: "bulk publish pages",
      path: "/bulk-publish",
      method: "POST",
      body: { pages: [{ id: "page_1", expectedRevision: 1 }] },
      status: 204,
    },
  ])(
    "warms exact public CMS paths after $label",
    async ({ path, method, body, status }) => {
      const { app, env } = createTestApp([{ slug: "about-us" }]);

      const response = await requestJson(app, env, path, method, body);

      expect(response.status).toBe(status);
      expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(
        ["pages"],
        env,
        { htmlPaths: [...discoveryPaths, "/about-us"] },
      );
    },
  );

  it.each([
    {
      label: "draft create",
      path: "",
      method: "POST",
      body: createPageBody({ slug: "draft-page", isPublished: false }),
      status: 201,
    },
    {
      label: "bulk restore",
      path: "/bulk-restore",
      method: "POST",
      body: { pages: [{ id: "page_1", expectedRevision: 1 }] },
      status: 204,
    },
    {
      label: "restore",
      path: "/page_1/restore",
      method: "POST",
      body: { expectedRevision: 1 },
      status: 200,
    },
  ])(
    "skips public cache work after $label because no buyer-visible path changed",
    async ({ path, method, body, status }) => {
      const { app, env } = createTestApp([]);

      const response = await requestJson(app, env, path, method, body);

      expect(response.status).toBe(status);
      expect(
        mocks.invalidateApiAndScheduleStorefrontGroups,
      ).not.toHaveBeenCalled();
      expect(mocks.invalidateApiAndStorefrontGroups).not.toHaveBeenCalled();
    },
  );

  it("purges both the previous and current public paths after a slug update", async () => {
    const { app, env } = createTestApp(
      [{ slug: "about-us" }],
      new Set([PERMISSIONS.PAGES_PUBLISH]),
      [[{ slug: "our-story" }]],
    );

    const response = await requestJson(app, env, "/page_1", "PUT", {
      expectedRevision: 1,
      slug: "our-story",
    });

    expect(response.status).toBe(200);
    expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(
      ["pages"],
      env,
      {
        htmlPaths: [...discoveryPaths, "/about-us", "/our-story"],
      },
    );
  });

  it("warms the public blog path after creating a published article", async () => {
    const { app, env } = createTestApp([
      { slug: "summer-care-guide", contentType: "article" },
    ]);

    const response = await requestJson(
      app,
      env,
      "",
      "POST",
      createPageBody({
        contentType: "article",
        title: "Summer care guide",
        slug: "summer-care-guide",
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(
      ["pages"],
      env,
      {
        htmlPaths: [...discoveryPaths, "/blog/summer-care-guide"],
      },
    );
  });

  it("passes the caller's publication authority into create and edit services", async () => {
    const { app, env } = createTestApp([], new Set());

    const createResponse = await requestJson(
      app,
      env,
      "",
      "POST",
      createPageBody({ isPublished: false }),
    );
    const updateResponse = await requestJson(app, env, "/page_1", "PUT", {
      expectedRevision: 1,
      title: "Still a draft",
      isPublished: false,
    });

    expect(createResponse.status).toBe(201);
    expect(updateResponse.status).toBe(200);
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

  it("queues a durable fallback without failing the committed mutation when the immediate purge fails", async () => {
    const { app, env } = createTestApp([{ slug: "about-us" }]);
    mocks.invalidateApiAndStorefrontGroups.mockRejectedValueOnce(
      new Error("storefront unavailable"),
    );

    const response = await requestJson(app, env, "", "POST", createPageBody());

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["pages"],
      expect.objectContaining({ env }),
      { htmlPaths: [...discoveryPaths, "/about-us"] },
    );
  });

  it.each([
    {
      label: "soft delete",
      path: "/page_1",
      method: "DELETE",
      body: { expectedRevision: 1 },
      status: 204,
    },
    {
      label: "permanent delete",
      path: "/page_1/permanent",
      method: "DELETE",
      body: { expectedRevision: 1 },
      status: 204,
    },
    {
      label: "bulk delete",
      path: "/bulk-delete",
      method: "POST",
      body: {
        pages: [{ id: "page_1", expectedRevision: 1 }],
        permanent: false,
      },
      status: 204,
    },
    {
      label: "bulk unpublish",
      path: "/bulk-unpublish",
      method: "POST",
      body: { pages: [{ id: "page_1", expectedRevision: 1 }] },
      status: 204,
    },
  ])(
    "purges the previously public path after $label",
    async ({ path, method, body, status }) => {
      const { app, env, db } = createTestApp([{ slug: "about-us" }]);

      const response = await requestJson(app, env, path, method, body);

      expect(response.status).toBe(status);
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(
        ["pages"],
        env,
        { htmlPaths: [...discoveryPaths, "/about-us"] },
      );
    },
  );
});
