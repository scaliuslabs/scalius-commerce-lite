import { OpenAPIHono } from "@hono/zod-openapi";
import { ConflictError } from "@scalius/core/errors";
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
  mocks.listAttributeValues.mockResolvedValue({
    attributeId: "attr_1",
    attributeName: "Color",
    values: [
      {
        value: "Navy",
        productCount: 12,
        createdAt: 1,
        isPreset: true,
        sampleProducts: ["Product A"],
      },
    ],
    totalValues: 41,
    totalProducts: 75,
    page: 2,
    limit: 20,
    totalPages: 3,
  });

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
    );
  });

  it("returns a documented conflict when a value rename targets an existing preset", async () => {
    const { app, env } = createTestApp();
    mocks.renameAttributeValue.mockRejectedValueOnce(
      new ConflictError('Value "Red" already exists for this attribute'),
    );

    const response = await app.request(
      "/api/v1/admin/attributes/attr_1/values",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldValue: "Blue", newValue: "Red" }),
      },
      env,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "CONFLICT",
        message: 'Value "Red" already exists for this attribute',
      },
    });
  });

  it("passes pagination and search to attribute values and returns global totals", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/attributes/attr_1/values?page=2&limit=20&search=navy&sort=asc",
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.listAttributeValues).toHaveBeenCalledWith(
      { id: "db" },
      "attr_1",
      { page: 2, limit: 20, search: "navy", sort: "asc" },
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        totalValues: 41,
        totalProducts: 75,
        page: 2,
        limit: 20,
        totalPages: 3,
      },
    });
  });

  it("rejects attribute value pages that could exceed the D1 lookup budget", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/attributes/attr_1/values?page=1&limit=101",
      undefined,
      env,
    );

    expect(response.status).toBe(400);
    expect(mocks.listAttributeValues).not.toHaveBeenCalled();
  });
});
