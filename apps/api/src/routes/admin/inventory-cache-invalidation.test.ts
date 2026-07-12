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
    inventoryOperationKeySchema: z.string().min(16).max(128),
    adjustInventorySchema: z.object({
      operationKey: z.string().min(16),
      delta: z.number().int().refine((value) => value !== 0),
      reason: z.enum(["received", "correction", "damage", "theft", "return", "other"]),
      notes: z.string().optional(),
      pool: z.enum(["stock", "preorderStock"]).optional().default("stock"),
    }).superRefine((value, context) => {
      if ((value.reason === "received" || value.reason === "return") && value.delta < 0) {
        context.addIssue({ code: "custom", path: ["reason"], message: "positive adjustment required" });
      }
      if ((value.reason === "damage" || value.reason === "theft") && value.delta > 0) {
        context.addIssue({ code: "custom", path: ["reason"], message: "negative adjustment required" });
      }
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
  mocks.getInventoryOverview.mockResolvedValue({
    movements: [],
    pagination: { page: 2, limit: 20, total: 0, totalPages: 0 },
  });
  mocks.acknowledgeLowStockAlert.mockResolvedValue(true);
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
      body: { operationKey: "invop_api_adjust_0001", delta: 2, reason: "received" },
      coreCall: () => mocks.adjustInventory,
      operationKey: "invop_api_adjust_0001",
    },
    {
      label: "scanner stock adjust",
      path: "/stock-adjust",
      body: { operationKey: "invop_api_scanner_001", variantId: "var_1", adjustment: 3, reason: "cycle count" },
      coreCall: () => mocks.adjustStock,
      operationKey: "invop_api_scanner_001",
    },
    {
      label: "scanner stock set",
      path: "/stock-set",
      body: { operationKey: "invop_api_stocktake_01", variantId: "var_1", newStock: 10, reason: "stocktake" },
      coreCall: () => mocks.setStock,
      operationKey: "invop_api_stocktake_01",
    },
  ])("uses targeted product availability invalidation after $label", async ({ path, body, coreCall, operationKey }) => {
    const { app, db, env } = createTestApp();

    const response = await postJson(app, env, path, body);

    expect(response.status).toBe(200);
    expect(coreCall()).toHaveBeenCalled();
    expect(JSON.stringify(coreCall().mock.calls[0])).toContain(operationKey);
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
      operationKey: "invop_api_missing_0001",
      delta: 2,
      reason: "received",
    });

    expect(response.status).toBe(404);
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
    expect(mocks.invalidateCatalogCaches).not.toHaveBeenCalled();
  });

  it.each([
    ["/var_1/adjust", { operationKey: "invop_api_invalid_0001", delta: -2, reason: "received" }, () => mocks.adjustInventory],
    ["/stock-adjust", { operationKey: "invop_api_invalid_0002", variantId: "var_1", adjustment: 1.5 }, () => mocks.adjustStock],
    ["/stock-set", { operationKey: "invop_api_invalid_0003", variantId: "var_1", newStock: 1.5 }, () => mocks.setStock],
  ] as const)("rejects invalid stock semantics before calling the core write at %s", async (path, body, coreCall) => {
    const { app, env } = createTestApp();

    const response = await postJson(app, env, path, body);

    expect(response.status).toBe(400);
    expect(coreCall()).not.toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
  });

  it.each([
    ["/var_1/adjust", { delta: 2, reason: "received" }, () => mocks.adjustInventory],
    ["/stock-adjust", { variantId: "var_1", adjustment: 2 }, () => mocks.adjustStock],
    ["/stock-set", { variantId: "var_1", newStock: 7 }, () => mocks.setStock],
  ] as const)("requires a merchant operation key before inventory work at %s", async (path, body, coreCall) => {
    const { app, env } = createTestApp();

    const response = await postJson(app, env, path, body);

    expect(response.status).toBe(400);
    expect(coreCall()).not.toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
  });

  it("forwards bounded movement filters and pagination to the inventory service", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/inventory?section=movements&search=SKU-1&movementType=deducted&page=2&limit=20",
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.getInventoryOverview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      expect.objectContaining({
        section: "movements",
        search: "SKU-1",
        movementType: "deducted",
        page: 2,
        limit: 20,
      }),
    );
  });

  it("forwards bounded alert filters, search, and pagination to the inventory service", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/inventory?section=alerts&search=SKU-LOW&alertStatus=resolved&page=3&limit=10",
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.getInventoryOverview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db" }),
      expect.objectContaining({
        section: "alerts",
        search: "SKU-LOW",
        alertStatus: "resolved",
        page: 3,
        limit: 10,
      }),
    );
  });

  it("acknowledges only an active low-stock alert", async () => {
    const { app, db, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/inventory/alerts",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId: "variant_low" }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.acknowledgeLowStockAlert).toHaveBeenCalledWith(db, "variant_low");
  });

  it("returns not found when the alert is no longer active", async () => {
    const { app, env } = createTestApp();
    mocks.acknowledgeLowStockAlert.mockResolvedValueOnce(false);

    const response = await app.request(
      "/api/v1/admin/inventory/alerts",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId: "variant_stale" }),
      },
      env,
    );

    expect(response.status).toBe(404);
  });

  it.each([
    "?page=0",
    "?limit=0",
    "?status=unknown",
    "?movementType=unknown",
  ])("rejects an invalid overview query before database work: %s", async (query) => {
    const { app, env } = createTestApp();

    const response = await app.request(`/api/v1/admin/inventory${query}`, undefined, env);

    expect(response.status).toBe(400);
    expect(mocks.getInventoryOverview).not.toHaveBeenCalled();
  });
});
