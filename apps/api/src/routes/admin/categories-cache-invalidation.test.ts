import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  listCategories: vi.fn(),
  getCategoryById: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
  updateCategoryStatus: vi.fn(),
  getCategoryPublishReadiness: vi.fn(),
  deleteCategory: vi.fn(),
  bulkDeleteCategories: vi.fn(),
  restoreCategories: vi.fn(),
  permanentlyDeleteCategory: vi.fn(),
  invalidateCatalogCaches: vi.fn(),
}));

vi.mock("@scalius/core/modules/categories", async () => {
  const actual = await vi.importActual<typeof import("@scalius/core/modules/categories")>(
    "@scalius/core/modules/categories",
  );
  return {
    ...actual,
    listCategories: mocks.listCategories,
    getCategoryById: mocks.getCategoryById,
    createCategory: mocks.createCategory,
    updateCategory: mocks.updateCategory,
    updateCategoryStatus: mocks.updateCategoryStatus,
    getCategoryPublishReadiness: mocks.getCategoryPublishReadiness,
    deleteCategory: mocks.deleteCategory,
    bulkDeleteCategories: mocks.bulkDeleteCategories,
    restoreCategories: mocks.restoreCategories,
    permanentlyDeleteCategory: mocks.permanentlyDeleteCategory,
  };
});

vi.mock("../../utils/cache-invalidation", async () => {
  const actual = await vi.importActual<typeof import("../../utils/cache-invalidation")>(
    "../../utils/cache-invalidation",
  );
  return {
    ...actual,
    invalidateCatalogCaches: mocks.invalidateCatalogCaches,
  };
});

import { adminCategoryRoutes } from "./categories";

function createCategoryBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Fresh Fish",
    description: null,
    slug: "fresh-fish",
    metaTitle: null,
    metaDescription: null,
    image: null,
    ...overrides,
  };
}

function createDb() {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => Promise.resolve([{ slug: "old-fish" }])),
  };

  return {
    select: vi.fn(() => query),
  };
}

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = createDb();
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;

  mocks.getCategoryById.mockResolvedValue({ id: "cat_1", slug: "old-fish" });
  mocks.createCategory.mockResolvedValue({ id: "cat_1", revision: 1, status: "draft" });
  mocks.updateCategory.mockResolvedValue({ revision: 2, status: "published" });
  mocks.updateCategoryStatus.mockResolvedValue({ revision: 2, status: "published" });
  mocks.getCategoryPublishReadiness.mockResolvedValue({
    ready: true,
    eligibleProductCount: 1,
    blockers: [],
    warnings: [],
  });
  mocks.deleteCategory.mockResolvedValue(undefined);
  mocks.bulkDeleteCategories.mockResolvedValue(undefined);
  mocks.restoreCategories.mockResolvedValue(undefined);
  mocks.permanentlyDeleteCategory.mockResolvedValue(undefined);
  mocks.invalidateCatalogCaches.mockResolvedValue(undefined);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/categories", adminCategoryRoutes);

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
    `/api/v1/admin/categories${path}`,
    {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

describe("admin category cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates catalog caches without warming a new draft category page", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(
      app,
      env,
      "",
      "POST",
      createCategoryBody({ slug: "fresh-fish" }),
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith(
      "categories",
      expect.objectContaining({ env }),
    );
  });

  it("warms old and new category pages after slug updates", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(
      app,
      env,
      "/cat_1",
      "PUT",
      createCategoryBody({
        slug: "new-fish",
        expectedRevision: 1,
        status: "published",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith(
      "categories",
      expect.objectContaining({ env }),
      { htmlPaths: ["/categories/old-fish", "/categories/new-fish"] },
    );
  });
});
