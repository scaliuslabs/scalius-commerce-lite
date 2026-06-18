import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi, afterEach } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getInventoryOverview: vi.fn(),
  adjustInventory: vi.fn(),
  adjustStock: vi.fn(),
  setStock: vi.fn(),
  lookupByBarcodeOrSku: vi.fn(),
  acknowledgeLowStockAlert: vi.fn(),
  invalidateProductAvailabilityCaches: vi.fn(),
  invalidateCatalogCaches: vi.fn(),
}));

vi.mock("@scalius/core/modules/inventory", async () => {
  const { z } = await import("@hono/zod-openapi");
  return {
    getInventoryOverview: mocks.getInventoryOverview,
    adjustInventory: mocks.adjustInventory,
    adjustStock: mocks.adjustStock,
    setStock: mocks.setStock,
    lookupByBarcodeOrSku: mocks.lookupByBarcodeOrSku,
    adjustInventorySchema: z.object({
      delta: z.number(),
      reason: z.enum(["received", "correction", "damage", "theft", "return", "other"]),
      notes: z.string().optional(),
      pool: z.enum(["stock", "preorderStock"]).optional().default("stock"),
    }),
  };
});

vi.mock("@scalius/core/modules/inventory/alerts", () => ({
  acknowledgeLowStockAlert: mocks.acknowledgeLowStockAlert,
}));

vi.mock("../../utils/cache-invalidation", () => ({
  invalidateProductAvailabilityCaches: mocks.invalidateProductAvailabilityCaches,
  invalidateCatalogCaches: mocks.invalidateCatalogCaches,
}));

import { adminInventoryRoutes } from "./inventory";

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = { id: "db" };
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;

  mocks.adjustInventory.mockResolvedValue({
    variantId: "var_1",
    previousStock: 5,
    newStock: 7,
    delta: 2,
  });
  mocks.adjustStock.mockResolvedValue({
    variantId: "var_1",
    previousStock: 5,
    newStock: 8,
    delta: 3,
  });
  mocks.setStock.mockResolvedValue({
    variantId: "var_1",
    previousStock: 5,
    newStock: 10,
    delta: 5,
  });
  mocks.invalidateProductAvailabilityCaches.mockResolvedValue(undefined);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "user_1" } as never);
    await next();
  });
  app.route("/admin/inventory", adminInventoryRoutes);

  return { app, db, env };
}

async function postJson(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  path: string,
  body: unknown,
) {
  return app.request(
    `/api/v1/admin/inventory${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("admin inventory cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      label: "adjust inventory",
      path: "/var_1/adjust",
      body: { delta: 2, reason: "received" },
      coreCall: () => mocks.adjustInventory,
    },
    {
      label: "scanner stock adjust",
      path: "/stock-adjust",
      body: { variantId: "var_1", adjustment: 3, reason: "cycle count" },
      coreCall: () => mocks.adjustStock,
    },
    {
      label: "scanner stock set",
      path: "/stock-set",
      body: { variantId: "var_1", newStock: 10, reason: "stocktake" },
      coreCall: () => mocks.setStock,
    },
  ])("uses targeted product availability invalidation after $label", async ({ path, body, coreCall }) => {
    const { app, db, env } = createTestApp();

    const response = await postJson(app, env, path, body);

    expect(response.status).toBe(200);
    expect(coreCall()).toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      db,
      { variantIds: ["var_1"] },
      expect.objectContaining({ env }),
    );
    expect(mocks.invalidateCatalogCaches).not.toHaveBeenCalled();
  });

  it("does not invalidate caches when the stock write fails", async () => {
    const { app, env } = createTestApp();
    mocks.adjustInventory.mockRejectedValueOnce(new Error("Variant not found"));

    const response = await postJson(app, env, "/missing_variant/adjust", {
      delta: 2,
      reason: "received",
    });

    expect(response.status).toBe(404);
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    expect(mocks.invalidateCatalogCaches).not.toHaveBeenCalled();
  });
});
