import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi, afterEach } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getInventoryOverview: vi.fn(),
  getInventoryLabelVariants: vi.fn(),
  buildInventoryLabelArtifact: vi.fn(),
  buildInventoryMovementCsvArtifact: vi.fn(),
  getCurrencyConfig: vi.fn(),
  listInventoryMovements: vi.fn(),
  adjustInventory: vi.fn(),
  adjustStock: vi.fn(),
  setStock: vi.fn(),
  lookupByBarcodeOrSku: vi.fn(),
  acknowledgeLowStockAlert: vi.fn(),
  setLowStockThreshold: vi.fn(),
  setDefaultLowStockThreshold: vi.fn(),
  listInventoryLocations: vi.fn(),
  createInventoryLocation: vi.fn(),
  updateInventoryLocation: vi.fn(),
  archiveInventoryLocation: vi.fn(),
  unarchiveInventoryLocation: vi.fn(),
  setDefaultInventoryLocation: vi.fn(),
  getVariantInventoryLevels: vi.fn(),
  getProductInventoryLevels: vi.fn(),
  readLocationOnHand: vi.fn(),
  resolveActiveInventoryLocation: vi.fn(),
}));

vi.mock("@scalius/core/modules/inventory", async () => {
  const { z } = await import("@hono/zod-openapi");
  const locations = await vi.importActual<typeof import("@scalius/core/modules/inventory")>("@scalius/core/modules/inventory");
  return {
    listInventoryLocations: mocks.listInventoryLocations,
    createInventoryLocation: mocks.createInventoryLocation,
    updateInventoryLocation: mocks.updateInventoryLocation,
    archiveInventoryLocation: mocks.archiveInventoryLocation,
    unarchiveInventoryLocation: mocks.unarchiveInventoryLocation,
    setDefaultInventoryLocation: mocks.setDefaultInventoryLocation,
    getVariantInventoryLevels: mocks.getVariantInventoryLevels,
    getProductInventoryLevels: mocks.getProductInventoryLevels,
    readLocationOnHand: mocks.readLocationOnHand,
    resolveActiveInventoryLocation: mocks.resolveActiveInventoryLocation,
    inventoryLocationInputSchema: locations.inventoryLocationInputSchema,
    updateInventoryLocationSchema: locations.updateInventoryLocationSchema,
    setSkuCostsSchema: locations.setSkuCostsSchema,
    setSkuCosts: vi.fn(),
    // Who sees costs and location details: the real rules.
    canViewCosts: locations.canViewCosts,
    canViewLocationDetails: locations.canViewLocationDetails,
    locationWithoutDetails: locations.locationWithoutDetails,
    withoutSkuCost: locations.withoutSkuCost,
    getInventoryValuation: vi.fn(),
    getInventoryOverview: mocks.getInventoryOverview,
    getInventoryLabelVariants: mocks.getInventoryLabelVariants,
    buildInventoryLabelArtifact: mocks.buildInventoryLabelArtifact,
    buildInventoryMovementCsvArtifact: mocks.buildInventoryMovementCsvArtifact,
    listInventoryMovements: mocks.listInventoryMovements,
    adjustInventory: mocks.adjustInventory,
    adjustStock: mocks.adjustStock,
    setStock: mocks.setStock,
    lookupByBarcodeOrSku: mocks.lookupByBarcodeOrSku,
    acknowledgeLowStockAlert: mocks.acknowledgeLowStockAlert,
    setLowStockThreshold: mocks.setLowStockThreshold,
    setDefaultLowStockThreshold: mocks.setDefaultLowStockThreshold,
    inventoryOperationKeySchema: z.string().min(16).max(128),
    INVENTORY_LABEL_VARIANT_LIMIT: 150,
    INVENTORY_LABEL_ARTIFACT_MAX_COPIES: 1_000,
    INVENTORY_LABEL_ARTIFACT_MAX_BYTES: 16 * 1024 * 1024,
    INVENTORY_MOVEMENT_EXPORT_MAX_ROWS: 5_000,
    INVENTORY_MOVEMENT_EXPORT_MAX_BYTES: 16 * 1024 * 1024,
    adjustInventoryRequestSchema: z.object({
      delta: z.number().int().refine((value) => value !== 0),
      reason: z.enum(["received", "correction", "damage", "theft", "return", "other"]),
      notes: z.string().optional(),
      pool: z.enum(["stock", "preorderStock"]).optional().default("stock"),
      locationId: z.string().min(1).optional(),
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

vi.mock("@scalius/core/modules/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/settings")>()),
  getCurrencyConfig: mocks.getCurrencyConfig,
}));



import { adminInventoryRoutes } from "./inventory";

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = { id: "db" };
  const env = {
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
  mocks.getInventoryLabelVariants.mockResolvedValue({
    variants: [],
    missingVariantIds: [],
  });
  mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT", symbol: "৳" });
  mocks.setLowStockThreshold.mockImplementation(async (_db, variantId, lowStockThreshold) => ({ variantId, lowStockThreshold }));
  mocks.setDefaultLowStockThreshold.mockImplementation(async (_db, defaultLowStockThreshold) => ({ defaultLowStockThreshold }));
  mocks.buildInventoryLabelArtifact.mockReturnValue({
    body: "artifact-body",
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
    copyCount: 1,
    pageCount: 1,
    byteLength: 13,
  });
  mocks.buildInventoryMovementCsvArtifact.mockResolvedValue({
    body: "movement-artifact\n",
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
    rowCount: 2,
    byteLength: 18,
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
  headers?: Record<string, string>,
) {
  return app.request(
    `/api/v1/admin/inventory${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("admin inventory write behavior", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([5, null])("saves alert level %s", async (lowStockThreshold) => {
    const { app, db, env } = createTestApp();
    const response = await app.request("/api/v1/admin/inventory/var_1/alert-level", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lowStockThreshold }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { variantId: "var_1", lowStockThreshold } });
    expect(mocks.setLowStockThreshold).toHaveBeenCalledWith(db, "var_1", lowStockThreshold);

  });

  it.each([5, null])("saves store alert level %s", async (defaultLowStockThreshold) => {
    const { app, db, env } = createTestApp();
    const response = await app.request("/api/v1/admin/inventory/default-alert-level", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultLowStockThreshold }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { defaultLowStockThreshold } });
    expect(mocks.setDefaultLowStockThreshold).toHaveBeenCalledWith(db, defaultLowStockThreshold);

  });

  it("rejects a store alert level that is not a whole number before writing", async () => {
    const { app, env } = createTestApp();
    const response = await app.request("/api/v1/admin/inventory/default-alert-level", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultLowStockThreshold: 2.5 }),
    }, env);

    expect(response.status).toBe(400);
    expect(mocks.setDefaultLowStockThreshold).not.toHaveBeenCalled();

  });

  it.each([-1, 2.5, 1_000_001, "5"])("rejects alert level %s with a field error before writing", async (lowStockThreshold) => {
    const { app, env } = createTestApp();
    const response = await app.request("/api/v1/admin/inventory/var_1/alert-level", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lowStockThreshold }),
    }, env);

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("lowStockThreshold");
    expect(mocks.setLowStockThreshold).not.toHaveBeenCalled();

  });

  it("returns a read-only exact-SKU label projection without write behavior", async () => {
    const { app, db, env } = createTestApp();
    const variantIds = ["var_2", "var_1"];
    const response = await postJson(app, env, "/labels/preview", { variantIds });

    expect(response.status).toBe(200);
    expect(mocks.getInventoryLabelVariants).toHaveBeenCalledWith(db, variantIds);

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

  it("documents the Idempotency-Key header; only the scanner's route keeps a body key", () => {
    const { app } = createTestApp();
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Inventory idempotency contract", version: "1.0.0" },
    });
    for (const [path, method] of [
      ["/api/v1/admin/inventory/{variantId}/adjust", "post"],
      ["/api/v1/admin/inventory/stock-adjust", "post"],
      ["/api/v1/admin/inventory/stock-set", "post"],
    ] as const) {
      const operation = spec.paths?.[path]?.[method];
      const serialized = JSON.stringify(operation);
      expect(serialized).toContain('"name":"idempotency-key"');
      expect(serialized.includes('"operationKey"'), path).toBe(path.endsWith("/stock-adjust"));
    }
  });

  it("generates a bounded artifact from a fresh authoritative SKU projection", async () => {
    const { app, db, env } = createTestApp();
    const variant = {
      id: "var_1",
      productName: "Product One",
      sku: "SKU-1",
      optionLabel: null,
      effectivePrice: 125,
      barcode: "036000291452",
      barcodeType: "upc",
    };
    mocks.getInventoryLabelVariants.mockResolvedValueOnce({
      variants: [variant],
      missingVariantIds: [],
    });

    const response = await postJson(app, env, "/labels/artifact", {
      format: "csv",
      mode: "job",
      variantIds: ["var_1"],
      quantities: { var_1: 1 },
      order: "selected",
      preset: {
        pageWidthMm: 210,
        pageHeightMm: 297,
        columns: 3,
        rows: 8,
        marginXmm: 8,
        marginYmm: 8,
        gapXmm: 2,
        gapYmm: 2,
        cropMarks: true,
      },
      startOffset: 0,
      alignment: { xMm: 0, yMm: 0 },
      content: {
        showProduct: true,
        showVariant: true,
        showSku: true,
        showPrice: true,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("artifact-body");
    expect(response.headers.get("content-disposition")).toContain("attachment; filename=\"barcode-labels-");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-label-copy-count")).toBe("1");
    expect(response.headers.get("content-length")).toBe("13");
    expect(response.headers.get("x-artifact-max-bytes")).toBe(String(16 * 1024 * 1024));
    expect(mocks.getInventoryLabelVariants).toHaveBeenCalledWith(db, ["var_1"]);
    expect(mocks.buildInventoryLabelArtifact).toHaveBeenCalledWith([variant], expect.objectContaining({
      quantities: { var_1: 1 },
    }), { code: "BDT", symbol: "৳" });
  });

  it.each([
    ["csv", "text/csv; charset=utf-8"],
    ["html", "text/html; charset=utf-8"],
    ["pdf", "application/pdf"],
  ] as const)("serves %s label artifacts as one attachment transport", async (format, contentType) => {
    const { app, env } = createTestApp();
    mocks.getInventoryLabelVariants.mockResolvedValueOnce({
      variants: [{
        id: "var_1",
        productName: "Product One",
        sku: "SKU-1",
        optionLabel: null,
        effectivePrice: 125,
        barcode: "036000291452",
        barcodeType: "upc",
      }],
      missingVariantIds: [],
    });
    mocks.buildInventoryLabelArtifact.mockReturnValueOnce({
      body: "artifact-body",
      contentType,
      extension: format,
      copyCount: 1,
      pageCount: 1,
      byteLength: 13,
    });

    const response = await postJson(app, env, "/labels/artifact", {
      format,
      mode: "job",
      variantIds: ["var_1"],
      quantities: { var_1: 1 },
      order: "selected",
      preset: {
        pageWidthMm: 210,
        pageHeightMm: 297,
        columns: 3,
        rows: 8,
        marginXmm: 8,
        marginYmm: 8,
        gapXmm: 2,
        gapYmm: 2,
        cropMarks: true,
      },
      startOffset: 0,
      alignment: { xMm: 0, yMm: 0 },
      content: {
        showProduct: true,
        showVariant: true,
        showSku: true,
        showPrice: true,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(
      new RegExp(`^attachment; filename="barcode-labels-\\d{4}-\\d{2}-\\d{2}\\.${format}"$`),
    );
    expect(response.headers.get("content-type")).toContain(contentType.split(";")[0]!);
  });

  it("rejects oversized label artifacts before reading SKU facts", async () => {
    const { app, env } = createTestApp();
    const response = await postJson(app, env, "/labels/artifact", {
      format: "pdf",
      mode: "job",
      variantIds: ["var_1"],
      quantities: { var_1: 1_001 },
      order: "selected",
      preset: {
        pageWidthMm: 210,
        pageHeightMm: 297,
        columns: 3,
        rows: 8,
        marginXmm: 8,
        marginYmm: 8,
        gapXmm: 2,
        gapYmm: 2,
        cropMarks: true,
      },
      startOffset: 0,
      alignment: { xMm: 0, yMm: 0 },
      content: {
        showProduct: true,
        showVariant: true,
        showSku: true,
        showPrice: true,
      },
    });

    expect(response.status).toBe(400);
    expect(mocks.getInventoryLabelVariants).not.toHaveBeenCalled();
    expect(mocks.buildInventoryLabelArtifact).not.toHaveBeenCalled();
  });

  it("forwards the scanner's own operation key", async () => {
    const { app, env } = createTestApp();
    const response = await postJson(app, env, "/stock-adjust", { operationKey: "invop_api_scanner_001", variantId: "var_1", adjustment: 3, reason: "cycle count" });
    expect(response.status).toBe(200);
    expect(JSON.stringify(mocks.adjustStock.mock.calls[0])).toContain("invop_api_scanner_001");
  });

  it.each([
    { label: "adjust inventory", path: "/var_1/adjust", body: { delta: 2, reason: "received" }, coreCall: () => mocks.adjustInventory },
    { label: "stock set", path: "/stock-set", body: { variantId: "var_1", newStock: 10, reason: "stocktake" }, coreCall: () => mocks.setStock },
  ])("derives the ledger key of $label from the Idempotency-Key header, the same on a retry", async ({ path, body, coreCall }) => {
    const { app, env } = createTestApp();
    const headers = { "Idempotency-Key": "erp sync 2026-10-19 #42" };

    expect((await postJson(app, env, path, body, headers)).status).toBe(200);
    expect((await postJson(app, env, path, body, headers)).status).toBe(200);
    // A body key is not part of the stable contract: it is never the ledger key.
    expect((await postJson(app, env, path, { ...body, operationKey: "invop_ignored_body_01" }, { "Idempotency-Key": "another key 0001" })).status).toBe(200);

    const keys = coreCall().mock.calls.map((call) => JSON.stringify(call).match(/api-[0-9a-f]{48}/u)?.[0]);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(JSON.stringify(coreCall().mock.calls)).not.toContain("invop_ignored_body_01");
  });

  it("returns a regular-stock write within the same availability band", async () => {
    const { app, env } = createTestApp();

    const response = await postJson(app, env, "/stock-adjust", {
      operationKey: "invop_api_same_band_01",
      variantId: "var_1",
      adjustment: 3,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { variantId: "var_1", previousStock: 5, newStock: 8, delta: 3 } });

  });

  it("returns a preorder write while capacity stays available", async () => {
    const { app, env } = createTestApp();

    const response = await postJson(app, env, "/var_1/adjust", {
      delta: 2,
      reason: "received",
      pool: "preorderStock",
    }, { "Idempotency-Key": "invop_api_preorder_001" });

    expect(response.status).toBe(200);
    expect(mocks.adjustInventory).toHaveBeenCalledWith(expect.anything(), "var_1", expect.objectContaining({ pool: "preorderStock", delta: 2 }), expect.anything());
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { variantId: "var_1", previousStock: 5, newStock: 7, delta: 2 } });

  });

  it("reports a stock write failure", async () => {
    const { app, env } = createTestApp();
    mocks.adjustInventory.mockRejectedValueOnce(new Error("Variant not found"));

    const response = await postJson(app, env, "/missing_variant/adjust", {
      delta: 2,
      reason: "received",
    }, { "Idempotency-Key": "invop_api_missing_0001" });

    expect(response.status).toBe(404);

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

  });

  it.each([
    ["/stock-adjust", { operationKey: "invop_body_mismatch_02", variantId: "var_1", adjustment: 2 }, () => mocks.adjustStock],
  ] as const)("rejects mismatched standard and legacy idempotency keys at %s", async (path, body, coreCall) => {
    const { app, env } = createTestApp();

    const response = await postJson(app, env, path, body, {
      "Idempotency-Key": "invop_header_mismatch_01",
    });

    expect(response.status).toBe(400);
    expect(coreCall()).not.toHaveBeenCalled();
  });

  it("forwards one standard header key unchanged across inventory retries", async () => {
    const { app, env } = createTestApp();
    const body = { variantId: "var_1", adjustment: 2, reason: "retry proof" };
    const headers = { "Idempotency-Key": "invop_header_retry_0001" };

    const first = await postJson(app, env, "/stock-adjust", body, headers);
    const retry = await postJson(app, env, "/stock-adjust", body, headers);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(mocks.adjustStock).toHaveBeenCalledTimes(2);
    expect(mocks.adjustStock.mock.calls.map((call) => call[3])).toEqual([
      "invop_header_retry_0001",
      "invop_header_retry_0001",
    ]);
  });

  it("accepts matching standard and legacy keys as one canonical operation", async () => {
    const { app, env } = createTestApp();
    const operationKey = "invop_equal_keys_00001";

    const response = await postJson(app, env, "/stock-adjust", {
      operationKey,
      variantId: "var_1",
      adjustment: 2,
    }, { "Idempotency-Key": operationKey });

    expect(response.status).toBe(200);
    expect(mocks.adjustStock.mock.calls[0]?.[3]).toBe(operationKey);
  });

  it("forwards bounded movement filters and a stable cursor to the inventory service", async () => {
    const { app, db, env } = createTestApp();

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

  it("serves the dedicated bounded movement artifact with equivalent filters", async () => {
    const { app, env } = createTestApp();
    const response = await postJson(app, env, "/movements/export", {
      search: "SKU",
      movementType: "adjusted",
      movementOrderId: "ord_1",
      movementStartDate: "2026-08-01",
      movementEndDate: "2026-08-02",
      maxRows: 2,
    });
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("inventory-movements-");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBe("18");
    expect(response.headers.get("x-export-row-count")).toBe("2");
    expect(response.headers.get("x-artifact-max-bytes")).toBe(String(16 * 1024 * 1024));
    expect(csv).toBe("movement-artifact\n");
    expect(mocks.buildInventoryMovementCsvArtifact).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      search: "SKU",
      movementType: "adjusted",
      orderId: "ord_1",
      maxRows: 2,
      startDate: expect.any(Date),
      endDate: expect.any(Date),
    }));
  });

  it("keeps inventory.list JSON-only after splitting movement exports", async () => {
    const { app, env } = createTestApp();
    const response = await app.request(
      "/api/v1/admin/inventory?section=movements&format=csv&maxRows=2",
      undefined,
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(mocks.buildInventoryMovementCsvArtifact).not.toHaveBeenCalled();
  });

  it("forwards bounded alert filters, search, and pagination to the inventory service", async () => {
    const { app, db, env } = createTestApp();

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

describe("admin inventory locations", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const location = {
    id: "loc_branch",
    name: "Branch",
    code: "BR",
    kind: "store",
    addressLine1: null,
    addressLine2: null,
    city: "Chattogram",
    postalCode: null,
    countryCode: "BD",
    phone: null,
    isDefault: false,
    status: "active",
    position: 1,
    version: 1,
    onHand: 0,
    stockedSkus: 0,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
  };

  it("lists active locations, and archived ones only when asked", async () => {
    const { app, db, env } = createTestApp();
    mocks.listInventoryLocations.mockResolvedValue([location]);

    const active = await app.request("/api/v1/admin/inventory/locations", {}, env);
    const everything = await app.request("/api/v1/admin/inventory/locations?includeArchived=true", {}, env);

    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({ success: true, data: { locations: [{ id: "loc_branch" }] } });
    expect(everything.status).toBe(200);
    expect(mocks.listInventoryLocations.mock.calls).toEqual([
      [db, { includeArchived: false }],
      [db, { includeArchived: true }],
    ]);
  });

  it("creates a location and rejects an invalid code before writing", async () => {
    const { app, db, env } = createTestApp();
    mocks.createInventoryLocation.mockResolvedValue(location);

    const created = await postJson(app, env, "/locations", { name: "Branch", code: "BR", kind: "store", city: "Chattogram" });
    const invalid = await postJson(app, env, "/locations", { name: "Branch", code: "has space" });

    expect(created.status).toBe(200);
    expect(mocks.createInventoryLocation).toHaveBeenCalledTimes(1);
    expect(mocks.createInventoryLocation).toHaveBeenCalledWith(db, expect.objectContaining({ name: "Branch", code: "BR", kind: "store" }));
    expect(invalid.status).toBe(400);
  });

  it("edits a location against its version and surfaces archive conflicts", async () => {
    const { app, db, env } = createTestApp();
    const { ConflictError } = await import("@scalius/core/errors");
    mocks.updateInventoryLocation.mockResolvedValue({ ...location, name: "CTG", version: 2 });
    mocks.archiveInventoryLocation.mockRejectedValue(new ConflictError("Branch still holds 3 units. Move or adjust that stock to zero first."));
    mocks.setDefaultInventoryLocation.mockResolvedValue({ ...location, isDefault: true });

    const updated = await app.request("/api/v1/admin/inventory/locations/loc_branch", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CTG", code: "BR", expectedVersion: 1 }),
    }, env);
    const missingVersion = await app.request("/api/v1/admin/inventory/locations/loc_branch", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CTG", code: "BR" }),
    }, env);
    const archived = await postJson(app, env, "/locations/loc_branch/archive", {});
    const madeDefault = await postJson(app, env, "/locations/loc_branch/default", {});

    expect(updated.status).toBe(200);
    expect(mocks.updateInventoryLocation).toHaveBeenCalledWith(db, "loc_branch", expect.objectContaining({ expectedVersion: 1 }));
    expect(missingVersion.status).toBe(400);
    expect(archived.status).toBe(409);
    expect(madeDefault.status).toBe(200);
    expect(mocks.setDefaultInventoryLocation).toHaveBeenCalledWith(db, "loc_branch");
  });

  it("reads one SKU's per-location levels", async () => {
    const { app, db, env } = createTestApp();
    mocks.getVariantInventoryLevels.mockResolvedValue({
      variantId: "var_1",
      stock: 5,
      reservedStock: 0,
      levels: [{ locationId: "loc_default", name: "Main location", code: "MAIN", isDefault: true, status: "active", onHand: 5 }],
    });

    const response = await app.request("/api/v1/admin/inventory/var_1/levels", {}, env);

    expect(response.status).toBe(200);
    expect(mocks.getVariantInventoryLevels).toHaveBeenCalledWith(db, "var_1");
  });

  it("forwards the location of a manual adjustment, a scanner count and the variant list", async () => {
    const { app, env } = createTestApp();
    mocks.getInventoryOverview.mockResolvedValue({ variants: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } });

    await postJson(app, env, "/var_1/adjust", { delta: 2, reason: "received", locationId: "loc_branch" }, { "Idempotency-Key": "invop_api_location_001" });
    await postJson(app, env, "/stock-set", { variantId: "var_1", newStock: 4, locationId: "loc_branch" }, { "Idempotency-Key": "invop_api_location_002" });
    await app.request("/api/v1/admin/inventory?section=variants&locationId=loc_branch", {}, env);

    expect(mocks.adjustInventory).toHaveBeenCalledWith(expect.anything(), "var_1", expect.objectContaining({ locationId: "loc_branch" }), "user_1");
    expect(mocks.setStock).toHaveBeenCalledWith(expect.anything(), "var_1", 4, expect.stringMatching(/^api-[0-9a-f]{48}$/u), undefined, "user_1", "loc_branch", { expectedStockVersion: undefined });
    expect(mocks.getInventoryOverview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ locationId: "loc_branch" }));
  });

  it("reads a product's SKU levels in one call", async () => {
    const { app, db, env } = createTestApp();
    mocks.getProductInventoryLevels.mockResolvedValue({
      productId: "prod_1",
      levels: [{ variantId: "var_1", locationId: "loc_default", onHand: 5 }],
    });

    const response = await app.request("/api/v1/admin/inventory/levels?productId=prod_1", {}, env);

    expect(response.status).toBe(200);
    expect(mocks.getProductInventoryLevels).toHaveBeenCalledWith(db, "prod_1");
    expect((await app.request("/api/v1/admin/inventory/levels", {}, env)).status).toBe(400);
  });

  it("filters and exports movement history by location", async () => {
    const { app, env } = createTestApp();

    await app.request("/api/v1/admin/inventory?section=movements&movementLocationId=loc_branch", {}, env);
    await postJson(app, env, "/movements/export", { movementLocationId: "loc_branch", maxRows: 10 });

    expect(mocks.getInventoryOverview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ section: "movements", movementLocationId: "loc_branch" }),
    );
    expect(mocks.buildInventoryMovementCsvArtifact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locationId: "loc_branch", maxRows: 10 }),
    );
  });

  it("gives the scanner a scanned SKU's on-hand at the location it counts", async () => {
    const { app, db, env } = createTestApp();
    mocks.lookupByBarcodeOrSku.mockResolvedValue({
      variant: { id: "var_1", sku: "SKU-1", optionLabel: null, price: 10, stock: 7, reservedStock: 1, available: 6, barcode: null, barcodeType: null, lowStockThreshold: null },
      product: { id: "prod_1", name: "Kurta", slug: "kurta", price: 10, isActive: true, imageUrl: null, imageMediaId: null },
    });
    mocks.resolveActiveInventoryLocation.mockResolvedValue({ id: "loc_branch", name: "Branch" });
    mocks.readLocationOnHand.mockResolvedValue(new Map([["var_1", 3]]));

    const at = await app.request("/api/v1/admin/inventory/scanner/lookup?code=SKU-1&locationId=loc_branch", {}, env);
    const anywhere = await app.request("/api/v1/admin/inventory/scanner/lookup?code=SKU-1", {}, env);

    expect(at.status).toBe(200);
    expect(((await at.json()) as { data: { variant: { locationOnHand: number | null } } }).data.variant.locationOnHand).toBe(3);
    expect(mocks.resolveActiveInventoryLocation).toHaveBeenCalledWith(db, "loc_branch");
    expect(mocks.readLocationOnHand).toHaveBeenCalledWith(db, "loc_branch", ["var_1"]);
    expect(((await anywhere.json()) as { data: { variant: { locationOnHand: number | null } } }).data.variant.locationOnHand).toBeNull();
  });
});
