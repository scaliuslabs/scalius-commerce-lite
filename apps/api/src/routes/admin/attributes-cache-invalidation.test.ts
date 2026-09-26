import { OpenAPIHono } from "@hono/zod-openapi";
import { ConflictError } from "@scalius/core/errors";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({

  listAttributes: vi.fn(),
  listAttributeAgentSummaries: vi.fn(),
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
  convertAttributeValueType: vi.fn(),
  createAttributeGroup: vi.fn(),
  trashAttributeGroup: vi.fn(),
  replaceCategoryAttributeSet: vi.fn(),
  getCategoryAttributeSet: vi.fn(),
  updateAttributeValueRow: vi.fn(),
  deleteAttributeValueRow: vi.fn(),
}));

vi.mock("@scalius/core/modules/attributes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/attributes")>()),
  listAttributes: mocks.listAttributes,
  listAttributeAgentSummaries: mocks.listAttributeAgentSummaries,
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
  convertAttributeValueType: mocks.convertAttributeValueType,
  createAttributeGroup: mocks.createAttributeGroup,
  trashAttributeGroup: mocks.trashAttributeGroup,
  replaceCategoryAttributeSet: mocks.replaceCategoryAttributeSet,
  getCategoryAttributeSet: mocks.getCategoryAttributeSet,
  updateAttributeValueRow: mocks.updateAttributeValueRow,
  deleteAttributeValueRow: mocks.deleteAttributeValueRow,
}));

import { adminAttributesRoutes } from "./attributes";

function createTestApp() {
  const db = { id: "db" };
  const env = {
    CACHE: { id: "api-cache-kv" },
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

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
  mocks.listAttributeAgentSummaries.mockResolvedValue({
    attributes: [{
      id: "attr_1",
      name: "Color",
      slug: "color",
      filterable: true,
      deletedAt: null,
    }],
    pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
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

describe("admin attribute write behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns success after attribute metadata writes", async () => {
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

  });

  it("returns success after attribute value renames", async () => {
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

  it("passes the projection refresh to committed value rewrites", async () => {
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
    expect(mocks.renameAttributeValue).toHaveBeenCalledWith({ id: "db" }, "attr_1", "Blue", "Navy", expect.any(Function));
  });

  it("commits typed-attribute writes: groups, category sets, value rows", async () => {
    const { app, env } = createTestApp();
    const group = { id: "atg_display01", name: "Display", sortOrder: 0, createdAt: 1, updatedAt: 1, attributeCount: 0 };
    mocks.createAttributeGroup.mockResolvedValue({ group });
    mocks.trashAttributeGroup.mockResolvedValue(undefined);
    mocks.replaceCategoryAttributeSet.mockResolvedValue({ categoryId: "cat_1", attributes: [] });
    mocks.updateAttributeValueRow.mockResolvedValue({
      value: { id: "atv_red_0001", value: "Crimson", normalizedValue: "crimson", sortOrder: 0, swatchHex: null },
      productsUpdated: 3,
    });
    const json = (method: string, body: unknown) => ({
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await app.request("/api/v1/admin/attributes/groups", json("POST", { name: "Display" }), env)).status).toBe(201);
    expect((await app.request("/api/v1/admin/attributes/groups/atg_display01", { method: "DELETE" }, env)).status).toBe(204);
    expect((await app.request(
      "/api/v1/admin/attributes/category-sets/cat_1",
      json("PUT", { attributes: [{ attributeId: "attr_1" }] }),
      env,
    )).status).toBe(200);
    expect((await app.request(
      "/api/v1/admin/attributes/attr_1/normalized-values/atv_red_0001",
      json("PATCH", { value: "Crimson" }),
      env,
    )).status).toBe(200);

    expect(mocks.replaceCategoryAttributeSet).toHaveBeenCalledWith({ id: "db" }, "cat_1", [{ attributeId: "attr_1" }]);
    expect(mocks.updateAttributeValueRow).toHaveBeenCalledWith(
      { id: "db" }, "attr_1", "atv_red_0001", { value: "Crimson" }, expect.any(Function),
    );
  });

  it("rejects category sets over 90 attributes and unknown body keys before the service", async () => {
    const { app, env } = createTestApp();
    const tooMany = Array.from({ length: 91 }, (_, index) => ({ attributeId: `attr_${index}` }));
    const oversized = await app.request("/api/v1/admin/attributes/category-sets/cat_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attributes: tooMany }),
    }, env);
    const unknownKey = await app.request("/api/v1/admin/attributes/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Display", colour: "red" }),
    }, env);
    expect(oversized.status).toBe(400);
    expect(unknownKey.status).toBe(400);
    expect(mocks.replaceCategoryAttributeSet).not.toHaveBeenCalled();
    expect(mocks.createAttributeGroup).not.toHaveBeenCalled();
  });

  it("returns conversion outcomes and reports a partially committed failure", async () => {
    const { app, env } = createTestApp();
    const result = {
      attributeId: "attr_1", fromType: "text", valueType: "number", facetDisplay: "range", unit: "inch",
      dryRun: true, rows: 2, distinctValues: 2, newValues: 0, unconvertibleCount: 0, unconvertibleSamples: [],
      converted: 0, skipped: 0, skippedSamples: [], changed: false,
    };
    const convert = (body: unknown) => app.request("/api/v1/admin/attributes/attr_1/convert-type", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, env);

    mocks.convertAttributeValueType.mockResolvedValueOnce(result);
    expect((await convert({ valueType: "number", unit: "inch", dryRun: true })).status).toBe(200);

    mocks.convertAttributeValueType.mockResolvedValueOnce({ ...result, dryRun: false, converted: 2, changed: true });
    expect((await convert({ valueType: "number", unit: "inch" })).status).toBe(200);

    mocks.convertAttributeValueType.mockRejectedValueOnce(new Error("interrupted"));
    expect((await convert({ valueType: "number" })).status).toBe(500);

    expect(mocks.convertAttributeValueType).toHaveBeenLastCalledWith(
      { id: "db" }, { attributeId: "attr_1", valueType: "number", dryRun: false }, expect.any(Function),
    );

    expect((await convert({ valueType: "text", unit: "inch" })).status).toBe(400);
  });
});
