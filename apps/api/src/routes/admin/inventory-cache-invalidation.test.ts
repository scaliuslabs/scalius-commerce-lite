import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi, afterEach } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getInventoryOverview: vi.fn(),
  getInventoryLabelVariants: vi.fn(),
  listInventoryMovements: vi.fn(),
  adjustInventory: vi.fn(),
  adjustStock: vi.fn(),
  setStock: vi.fn(),
  lookupByBarcodeOrSku: vi.fn(),
  acknowledgeLowStockAlert: vi.fn(),
  findStockMutationAvailabilityTransitions: vi.fn(),
  invalidateProductAvailabilityCaches: vi.fn(),
  invalidateCatalogCaches: vi.fn(),
}));

vi.mock("@scalius/core/modules/inventory", async () => {
  const { z } = await import("@hono/zod-openapi");
  return {
    getInventoryOverview: mocks.getInventoryOverview,
    getInventoryLabelVariants: mocks.getInventoryLabelVariants,
    listInventoryMovements: mocks.listInventoryMovements,
    adjustInventory: mocks.adjustInventory,
    adjustStock: mocks.adjustStock,
    setStock: mocks.setStock,
    lookupByBarcodeOrSku: mocks.lookupByBarcodeOrSku,
    inventoryOperationKeySchema: z.string().min(16).max(128),
    INVENTORY_LABEL_VARIANT_LIMIT: 150,
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
  findStockMutationAvailabilityTransitions:
    mocks.findStockMutationAvailabilityTransitions,
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
    pageInfo: { limit: 20, hasMore: false, nextCursor: null },
  });
  mocks.listInventoryMovements.mockResolvedValue({
    movements: [],
    pageInfo: { limit: 100, hasMore: false, nextCursor: null },
  });
  mocks.acknowledgeLowStockAlert.mockResolvedValue(true);
  mocks.findStockMutationAvailabilityTransitions.mockResolvedValue(["var_1"]);
  mocks.invalidateProductAvailabilityCaches.mockResolvedValue(undefined);
  mocks.getInventoryLabelVariants.mockResolvedValue({
    variants: [],
    missingVariantIds: [],
  });

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

  it("returns a read-only exact-SKU label projection without cache invalidation", async () => {
    const { app, db, env } = createTestApp();
    const variantIds = ["var_2", "var_1"];
    const response = await postJson(app, env, "/labels/preview", { variantIds });

    expect(response.status).toBe(200);
    expect(mocks.getInventoryLabelVariants).toHaveBeenCalledWith(db, variantIds);
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
  });

  it("documents the buyer-effective price used by barcode label artwork", () => {
    const { app } = createTestApp();
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Inventory label contract", version: "1.0.0" },
    });
    const operation = spec.paths?.["/api/v1/admin/inventory/labels/preview"]?.post;

    expect(operation).toBeDefined();
    expect(JSON.stringify(operation)).toContain('"effectivePrice"');
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
    expect(mocks.findStockMutationAvailabilityTransitions).toHaveBeenCalledWith(
      db,
      [expect.objectContaining({ variantId: "var_1" })],
    );
    expect(mocks.invalidateProductAvailabilityCaches).toHaveBeenCalledWith(
      db,
      { variantIds: ["var_1"] },
      expect.objectContaining({ env }),
    );
    expect(mocks.invalidateCatalogCaches).not.toHaveBeenCalled();
  });

  it("keeps caches hot when a regular-stock write stays in the same availability band", async () => {
    const { app, env } = createTestApp();
    mocks.findStockMutationAvailabilityTransitions.mockResolvedValueOnce([]);

    const response = await postJson(app, env, "/stock-adjust", {
      operationKey: "invop_api_same_band_01",
      variantId: "var_1",
      adjustment: 3,
    });

    expect(response.status).toBe(200);
    expect(mocks.findStockMutationAvailabilityTransitions).toHaveBeenCalledOnce();
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
  });

  it("does not inspect or purge buyer caches for preorder-only stock", async () => {
    const { app, env } = createTestApp();

    const response = await postJson(app, env, "/var_1/adjust", {
      operationKey: "invop_api_preorder_001",
      delta: 2,
      reason: "received",
      pool: "preorderStock",
    });

    expect(response.status).toBe(200);
    expect(mocks.findStockMutationAvailabilityTransitions).not.toHaveBeenCalled();
    expect(mocks.invalidateProductAvailabilityCaches).not.toHaveBeenCalled();
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

  it("forwards bounded movement filters and a stable cursor to the inventory service", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/inventory?section=movements&search=SKU-1&movementType=deducted&movementOrderId=ord_exact&movementStartDate=2026-07-01&movementEndDate=2026-07-02&movementCursor=1720000000%7Cmove_20&limit=20",
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
        movementOrderId: "ord_exact",
        movementStartDate: new Date("2026-06-30T18:00:00.000Z"),
        movementEndDate: new Date("2026-07-02T17:59:59.999Z"),
        movementCursor: "1720000000|move_20",
        limit: 20,
      }),
    );
  });

  it("streams bounded, formula-safe movement CSV through sequential cursor pages", async () => {
    const { app, env } = createTestApp();
    const movement = {
      id: "move_1",
      variantId: "var_1",
      orderId: "ord_1",
      type: "adjusted",
      quantity: 2,
      previousStock: 3,
      newStock: 5,
      notes: "+warehouse note",
      createdBy: "admin_1",
      actorName: "Admin One",
      actorType: "admin",
      ledgerVersion: 2,
      pool: "regular",
      reservationGeneration: 1,
      stockVersionBefore: 4,
      stockVersionAfter: 5,
      stockDelta: 2,
      previousReservedStock: 0,
      newReservedStock: 0,
      reservedStockDelta: 0,
      previousPreorderStock: 0,
      newPreorderStock: 0,
      preorderStockDelta: 0,
      createdAt: 1_720_000_000,
      variantSku: "=SKU-FORMULA",
      productName: "Product One",
    };
    mocks.listInventoryMovements
      .mockResolvedValueOnce({
        movements: [movement],
        pageInfo: { limit: 1, hasMore: true, nextCursor: "1720000000|move_1" },
      })
      .mockResolvedValueOnce({
        movements: [{ ...movement, id: "move_0", variantSku: "SKU-2" }],
        pageInfo: { limit: 1, hasMore: false, nextCursor: null },
      });

    const response = await app.request(
      "/api/v1/admin/inventory?section=movements&format=csv&maxRows=2&movementOrderId=ord_1",
      undefined,
      env,
    );
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("inventory-movements-");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(csv).toContain('"\'=SKU-FORMULA"');
    expect(csv).toContain('"\'+warehouse note"');
    expect(csv).toContain('"Admin One"');
    expect(mocks.listInventoryMovements).toHaveBeenCalledTimes(2);
    expect(mocks.listInventoryMovements.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      cursor: "1720000000|move_1",
      limit: 1,
      orderId: "ord_1",
    }));
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
