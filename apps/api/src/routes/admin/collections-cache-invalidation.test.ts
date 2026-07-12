import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  listCollections: vi.fn(),
  getCollectionById: vi.fn(),
  getCollectionCategoryOptions: vi.fn(),
  getCollectionsByIds: vi.fn(),
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
  bulkDeleteCollections: vi.fn(),
  bulkActivateCollections: vi.fn(),
  bulkDeactivateCollections: vi.fn(),
  restoreCollections: vi.fn(),
  reorderCollections: vi.fn(),
  invalidateCatalogCaches: vi.fn(),
}));

vi.mock("@scalius/core/modules/collections", async () => {
  const actual = await vi.importActual<typeof import("@scalius/core/modules/collections")>(
    "@scalius/core/modules/collections",
  );
  return {
    ...actual,
    listCollections: mocks.listCollections,
    getCollectionById: mocks.getCollectionById,
    getCollectionCategoryOptions: mocks.getCollectionCategoryOptions,
    getCollectionsByIds: mocks.getCollectionsByIds,
    createCollection: mocks.createCollection,
    updateCollection: mocks.updateCollection,
    deleteCollection: mocks.deleteCollection,
    bulkDeleteCollections: mocks.bulkDeleteCollections,
    bulkActivateCollections: mocks.bulkActivateCollections,
    bulkDeactivateCollections: mocks.bulkDeactivateCollections,
    restoreCollections: mocks.restoreCollections,
    reorderCollections: mocks.reorderCollections,
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

import { adminCollectionRoutes } from "./collections";

function createCollectionBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Homepage Deals",
    presentation: "grid",
    isActive: true,
    config: {
      source: "manual",
      categoryIds: [],
      productIds: ["prod_1"],
      maxProducts: 8,
    },
    ...overrides,
  };
}

function createDb() {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(() => Promise.resolve([])),
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

  mocks.createCollection.mockResolvedValue({
    id: "col_1",
    ...createCollectionBody(),
  });
  mocks.updateCollection.mockResolvedValue({
    id: "col_1",
    ...createCollectionBody({ name: "Updated Deals" }),
  });
  mocks.deleteCollection.mockResolvedValue(undefined);
  mocks.bulkDeleteCollections.mockResolvedValue(undefined);
  mocks.bulkActivateCollections.mockResolvedValue(undefined);
  mocks.bulkDeactivateCollections.mockResolvedValue(undefined);
  mocks.restoreCollections.mockResolvedValue(undefined);
  mocks.reorderCollections.mockResolvedValue(undefined);
  mocks.invalidateCatalogCaches.mockResolvedValue(undefined);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/collections", adminCollectionRoutes);

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
    `/api/v1/admin/collections${path}`,
    {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

describe("admin collection cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates homepage collection caches after collection creation", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(
      app,
      env,
      "",
      "POST",
      createCollectionBody(),
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith(
      "collections",
      expect.objectContaining({ env }),
    );
  });

  it("invalidates homepage collection caches after collection activation changes", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(
      app,
      env,
      "/bulk-activate",
      "POST",
      { ids: ["col_1"] },
    );

    expect(response.status).toBe(204);
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith(
      "collections",
      expect.objectContaining({ env }),
    );
  });

  it("rejects bulk collection writes above the D1-safe boundary", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(
      app,
      env,
      "/bulk-delete",
      "POST",
      {
        collectionIds: Array.from({ length: 91 }, (_, index) => `col_${index}`),
        permanent: false,
      },
    );

    expect(response.status).toBe(400);
    expect(mocks.bulkDeleteCollections).not.toHaveBeenCalled();
    expect(mocks.invalidateCatalogCaches).not.toHaveBeenCalled();
  });
});
