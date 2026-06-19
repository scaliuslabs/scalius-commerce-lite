import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  listAttributes: vi.fn(),
  createAttribute: vi.fn(),
  updateAttribute: vi.fn(),
  deleteAttribute: vi.fn(),
  permanentlyDeleteAttribute: vi.fn(),
  bulkDeleteAttributes: vi.fn(),
  bulkRestoreAttributes: vi.fn(),
  restoreAttribute: vi.fn(),
  listAttributeValues: vi.fn(),
  addAttributeValue: vi.fn(),
  renameAttributeValue: vi.fn(),
  deleteAttributeValue: vi.fn(),
}));

vi.mock("../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/core/modules/attributes/attributes.service", () => ({
  listAttributes: mocks.listAttributes,
  createAttribute: mocks.createAttribute,
  updateAttribute: mocks.updateAttribute,
  deleteAttribute: mocks.deleteAttribute,
  permanentlyDeleteAttribute: mocks.permanentlyDeleteAttribute,
  bulkDeleteAttributes: mocks.bulkDeleteAttributes,
  bulkRestoreAttributes: mocks.bulkRestoreAttributes,
  restoreAttribute: mocks.restoreAttribute,
  listAttributeValues: mocks.listAttributeValues,
  addAttributeValue: mocks.addAttributeValue,
  renameAttributeValue: mocks.renameAttributeValue,
  deleteAttributeValue: mocks.deleteAttributeValue,
}));

import { adminAttributesRoutes } from "./attributes";

function createTestApp() {
  const db = { id: "db" };
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
  mocks.createAttribute.mockResolvedValue({
    attribute: {
      id: "attr_1",
      name: "Color",
      slug: "color",
      filterable: true,
      options: [],
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    },
  });
  mocks.renameAttributeValue.mockResolvedValue(undefined);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/attributes", adminAttributesRoutes);
  return { app, env };
}

describe("admin attribute cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates attribute and product caches after attribute metadata writes", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/attributes",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Color",
          slug: "color",
          filterable: true,
          options: ["Blue"],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["attributes", "products"],
      expect.objectContaining({ env }),
      { htmlPaths: ["/search"] },
    );
  });

  it("invalidates attribute and product caches after attribute value renames", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/attributes/attr_1/values",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldValue: "Blue", newValue: "Navy" }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["attributes", "products"],
      expect.objectContaining({ env }),
      { htmlPaths: ["/search"] },
    );
  });
});
