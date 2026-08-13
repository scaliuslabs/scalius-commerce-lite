import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
}));

vi.mock("../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

import { checkoutLanguageRoutes, publicCheckoutLanguageRoutes } from "./checkout-languages";

const languageRecord = {
  id: "cl_1",
  name: "English",
  code: "en",
  languageData: "{}",
  fieldVisibility: "{}",
  isActive: true,
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

function createTestApp(options: {
  selectedRows?: Array<typeof languageRecord | null>;
  batchError?: Error;
} = {}) {
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const selectedRows = [...(options.selectedRows ?? [])];
  const insertReturning = vi.fn().mockResolvedValue([languageRecord]);
  const updateReturning = vi.fn().mockResolvedValue([languageRecord]);
  const batch = vi.fn(async (statements: unknown[]) => {
    if (options.batchError) throw options.batchError;
    if (statements.length === 2) return [[], [languageRecord]];
    if (statements.length === 3) return [[], [], [languageRecord]];
    throw new Error(`Unexpected batch length ${statements.length}`);
  });
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => c.json(
    { message: error.message },
    (error as { status?: number }).status === 409 ? 409 : 500,
  ));
  app.use("*", async (c, next) => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            get: async () => selectedRows.shift() ?? null,
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: updateReturning,
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: insertReturning,
        }),
      }),
      batch,
    } as unknown as Database;
    c.set("db", db);
    await next();
  });
  app.route("/checkout-languages", publicCheckoutLanguageRoutes);
  app.route("/admin/settings/checkout-languages", checkoutLanguageRoutes);
  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
  return { app, env, batch, insertReturning, updateReturning };
}

describe("checkout language route boundaries", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps public checkout-language mutations unregistered", async () => {
    const { app } = createTestApp();

    const createResponse = await app.request("/api/v1/checkout-languages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const updateResponse = await app.request("/api/v1/checkout-languages/cl_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "English" }),
    });
    const deleteResponse = await app.request("/api/v1/checkout-languages/cl_1", {
      method: "DELETE",
    });
    const restoreResponse = await app.request(
      "/api/v1/checkout-languages/cl_1/restore",
      { method: "POST" },
    );

    expect(createResponse.status).toBe(404);
    expect(updateResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expect(restoreResponse.status).toBe(404);
  });

  it("leaves admin checkout-language mutations registered", async () => {
    const { app } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(400);
  });

  it("keeps the active checkout language public read available", async () => {
    const { app } = createTestApp();

    const response = await app.request("/api/v1/checkout-languages/active");
    const body = await response.json() as {
      success: boolean;
      data?: { language?: { id?: string } };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.language?.id).toBe("fallback");
  });

  it("publishes distinct surface-qualified identities for public and admin active reads", () => {
    const { app } = createTestApp();
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Checkout language identity", version: "test" },
    });
    const publicOperation = spec.paths?.["/api/v1/checkout-languages/active"]?.get;
    const adminOperation = spec.paths?.["/api/v1/admin/settings/checkout-languages/active"]?.get;

    expect(publicOperation?.operationId).toBe("storefront.checkout_language.get_active");
    expect(adminOperation?.operationId).toBe("dashboard.checkout_languages.active_get");
    expect(publicOperation?.operationId).not.toBe(adminOperation?.operationId);
    expect(publicOperation?.operationId).toMatch(/^storefront(\.[a-z][a-z0-9_]*){2,}$/);
    expect(adminOperation?.operationId).toMatch(/^dashboard(\.[a-z][a-z0-9_]*){2,}$/);
  });

  it("publishes bounded stable identities for the complete admin language lifecycle", () => {
    const { app } = createTestApp();
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Checkout language lifecycle", version: "test" },
    }) as unknown as {
      paths: Record<string, Record<string, {
        operationId?: string;
        requestBody?: { required?: boolean };
        parameters?: Array<{ name?: string; schema?: { maximum?: number } }>;
        responses?: Record<string, { content?: Record<string, { schema?: {
          properties?: { data?: { properties?: { languages?: { maxItems?: number } } } };
        } }> }>;
      }>>;
    };
    const base = "/api/v1/admin/settings/checkout-languages";
    const operations = [
      ["get", base, "dashboard.checkout_languages.list"],
      ["post", base, "dashboard.checkout_languages.create"],
      ["get", `${base}/{id}`, "dashboard.checkout_languages.get"],
      ["put", `${base}/{id}`, "dashboard.checkout_languages.update"],
      ["patch", `${base}/{id}`, "dashboard.checkout_languages.trash"],
      ["delete", `${base}/{id}`, "dashboard.checkout_languages.delete_permanently"],
      ["post", `${base}/{id}/restore`, "dashboard.checkout_languages.restore"],
    ] as const;

    for (const [method, path, operationId] of operations) {
      expect(spec.paths[path]?.[method]?.operationId, `${method} ${path}`).toBe(operationId);
    }
    expect(spec.paths[base]?.post?.requestBody?.required).toBe(true);
    expect(spec.paths[`${base}/{id}`]?.put?.requestBody?.required).toBe(true);
    expect(spec.paths[base]?.get?.parameters?.find(({ name }) => name === "limit")?.schema?.maximum).toBe(10);
    expect(
      spec.paths[base]?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema?.properties?.data?.properties?.languages?.maxItems,
    ).toBe(10);
  });

  it("invalidates checkout caches after admin checkout-language saves", async () => {
    const { app, env, batch } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "English",
          code: "en",
          languageData: {},
          fieldVisibility: {},
          isActive: true,
          isDefault: true,
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });

  it("promotes an updated active/default language in one atomic batch", async () => {
    const { app, env, batch } = createTestApp({
      selectedRows: [languageRecord],
    });

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages/cl_1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true, isDefault: true }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it("does not reset another winner when an update only turns flags off", async () => {
    const { app, env, batch, updateReturning } = createTestApp({
      selectedRows: [languageRecord],
    });

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages/cl_1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false, isDefault: false }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(batch).not.toHaveBeenCalled();
    expect(updateReturning).toHaveBeenCalledTimes(1);
  });

  it("returns a conflict when a concurrent promotion reaches the unique fence", async () => {
    const { app, env } = createTestApp({
      batchError: new Error(
        "UNIQUE constraint failed: checkout_languages.is_active",
      ),
    });

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bangla",
          code: "bn",
          isActive: true,
        }),
      },
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Another checkout language selection was saved at the same time. Reload and try again.",
    });
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
  });
});
