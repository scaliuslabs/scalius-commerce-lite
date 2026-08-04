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
