// Admin purchasing and transfer routes (migration 0109) on the migrated
// schema: suppliers, purchase orders through receiving under an
// Idempotency-Key, CSV export, transfers ship/receive/cancel, SKU costs and
// valuation, plus the runtime family and RBAC of every path.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

import { errorResponseFromError } from "../../utils/api-response";
import { classifyAdminRuntimePath } from "../../runtime/admin-app";
import { adminInventoryRoutes } from "./inventory";
import { adminPurchaseOrderRoutes, adminSupplierRoutes, adminTransferRoutes } from "./inventory-purchasing";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
  permissions = COSTED;
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_a', 'Panjabi', 'panjabi', 150000, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
      VALUES ('var_a', 'prod_a', 'PANJABI-M', 150000, 8, 0, 1, 1, 1);
    INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position)
      VALUES ('loc_shop', 'Dhanmondi shop', 'DHN', 'store', 0, 'active', 1);
  `);
});
afterEach(() => sqlite.close());

/** A staff member who runs purchasing and sees costs (the route map is checked separately). */
const COSTED = [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.PRODUCTS_VIEW_COSTS, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.INVENTORY_MANAGE];
/** The same staff member without "View product costs". */
const UNCOSTED = COSTED.filter((permission) => permission !== PERMISSIONS.PRODUCTS_VIEW_COSTS);
let permissions: readonly string[] = COSTED;

function app() {
  const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  router.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user" as never, { id: "usr_staff" } as never);
    c.set("adminPermissions", new Set(permissions));
    await next();
  });
  router.route("/inventory/suppliers", adminSupplierRoutes);
  router.route("/inventory/purchase-orders", adminPurchaseOrderRoutes);
  router.route("/inventory/transfers", adminTransferRoutes);
  router.route("/inventory", adminInventoryRoutes);
  router.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  return router;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await app().request(`/api/v1/admin${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const type = response.headers.get("content-type") ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON body freely
  const parsed: any = type.includes("json") ? await response.json() : await response.text();
  return { status: response.status, headers: response.headers, body: parsed };
}

describe("purchase order routes", () => {
  it("creates a supplier and a purchase order, orders it, receives under a key and exports it", async () => {
    const supplier = await call("POST", "/inventory/suppliers", { name: "Dhaka Textiles", phone: "+8801711111111" });
    expect(supplier.status).toBe(200);
    const created = await call("POST", "/inventory/purchase-orders", {
      supplierId: supplier.body.data.id,
      destinationLocationId: "loc_shop",
      lines: [{ variantId: "var_a", quantity: 12, unitCost: 700 }],
    });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ status: "draft", displayNumber: "PO1001", subtotal: 8400, createdBy: "usr_staff" });
    const id = created.body.data.id as string;
    const ordered = await call("POST", `/inventory/purchase-orders/${id}/order`, { expectedRevision: 1 });
    expect(ordered.body.data.status).toBe("ordered");
    const stale = await call("POST", `/inventory/purchase-orders/${id}/cancel`, { expectedRevision: 1 });
    expect(stale.status).toBe(409);

    const lineId = ordered.body.data.lines[0].id as string;
    const missingKey = await call("POST", `/inventory/purchase-orders/${id}/receive`, { lines: [{ lineId, quantity: 5 }] });
    expect(missingKey.status).toBe(400);
    const mismatch = await call("POST", `/inventory/purchase-orders/${id}/receive`,
      { operationKey: "receipt-key-0000000001", lines: [{ lineId, quantity: 5 }] },
      { "idempotency-key": "receipt-key-0000000002" });
    expect(mismatch.status).toBe(400);
    const headers = { "idempotency-key": "receipt-key-0000000003" };
    const received = await call("POST", `/inventory/purchase-orders/${id}/receive`, { lines: [{ lineId, quantity: 5 }], updateCost: true }, headers);
    expect(received.status).toBe(200);
    expect(received.body.data).toMatchObject({ status: "partially_received", costUpdated: true, lines: [{ quantity: 5, unitCost: 700, costBefore: null, costAfter: 700, stockAfter: 13 }] });
    const replay = await call("POST", `/inventory/purchase-orders/${id}/receive`, { lines: [{ lineId, quantity: 5 }], updateCost: true }, headers);
    expect(replay.body.data).toEqual(received.body.data);
    const changed = await call("POST", `/inventory/purchase-orders/${id}/receive`, { lines: [{ lineId, quantity: 6 }] }, headers);
    expect(changed.status).toBe(409);
    expect(sqlite.prepare("SELECT stock, cost_minor FROM product_variants WHERE id = 'var_a'").get()).toEqual({ stock: 13, cost_minor: 70000 });

    const list = await call("GET", "/inventory/purchase-orders?status=open&q=PANJABI");
    expect(list.body.data.purchaseOrders.map((row: { displayNumber: string }) => row.displayNumber)).toEqual(["PO1001"]);
    const csv = await call("GET", `/inventory/purchase-orders/${id}/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="purchase-order-PO1001.csv"');
    expect(csv.body).toContain('"PANJABI-M","Panjabi","","","12","5","7","700","8400"');

    const inventory = await call("GET", "/inventory?section=variants&locationId=loc_shop");
    expect(inventory.body.data.variants[0]).toMatchObject({ id: "var_a", cost: 700, incoming: 7, locationOnHand: 5 });
  });
});

describe("transfer routes", () => {
  it("ships, receives in part and cancels the rest back to the origin", async () => {
    const created = await call("POST", "/inventory/transfers", {
      originLocationId: "loc_default",
      destinationLocationId: "loc_shop",
      lines: [{ variantId: "var_a", quantity: 5 }],
    });
    const id = created.body.data.id as string;
    const shipped = await call("POST", `/inventory/transfers/${id}/ship`, { expectedRevision: 1 }, { "idempotency-key": "transfer-ship-000001" });
    expect(shipped.body.data).toMatchObject({ kind: "ship", status: "in_transit", lines: [{ quantity: 5, stockAfter: 3 }] });
    const lineId = (await call("GET", `/inventory/transfers/${id}`)).body.data.lines[0].id as string;
    const part = await call("POST", `/inventory/transfers/${id}/receive`, { lines: [{ lineId, quantity: 2 }] }, { "idempotency-key": "transfer-recv-000001" });
    expect(part.body.data).toMatchObject({ kind: "receive", status: "partially_received" });
    const cancelled = await call("POST", `/inventory/transfers/${id}/cancel`, { expectedRevision: 3 }, { "idempotency-key": "transfer-cncl-000001" });
    expect(cancelled.body.data).toMatchObject({ kind: "return", status: "cancelled", lines: [{ quantity: 3, stockAfter: 8 }] });
    const detail = await call("GET", `/inventory/transfers/${id}`);
    expect(detail.body.data.activity.map((entry: { kind: string; actorName: string }) => entry.kind)).toEqual(["ship", "receive", "return"]);
    expect(sqlite.prepare("SELECT location_id, on_hand FROM inventory_levels WHERE variant_id = 'var_a' ORDER BY location_id").all())
      .toEqual([{ location_id: "loc_default", on_hand: 6 }, { location_id: "loc_shop", on_hand: 2 }]);
  });
});

describe("costs and valuation routes", () => {
  it("sets SKU costs (refusing a stale expected cost) and values stock per location", async () => {
    const saved = await call("PUT", "/inventory/costs", { items: [{ variantId: "var_a", cost: 450.25, expectedCost: null }] });
    expect(saved.body.data).toEqual({ items: [{ variantId: "var_a", cost: 450.25 }] });
    const stale = await call("PUT", "/inventory/costs", { items: [{ variantId: "var_a", cost: 1, expectedCost: 400 }] });
    expect(stale.status).toBe(409);
    const valuation = await call("GET", "/inventory/valuation");
    expect(valuation.body.data.total).toEqual({ units: 8, value: 3602, unitsWithoutCost: 0, skusWithoutCost: 0 });
  });
});

describe("without View product costs", () => {
  /** Every cost-bearing key anywhere in a response body. */
  function costKeys(value: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((entry) => costKeys(entry, found));
    else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (["cost", "costMinor", "unitCost", "lineTotal", "currentCost", "costBefore", "costAfter", "subtotal", "shipping", "otherCosts", "tax"].includes(key)) found.add(key);
        costKeys(entry, found);
      }
    }
    return found;
  }

  it("leaves every unit cost and purchase-order amount out, and refuses cost writes", async () => {
    sqlite.exec("UPDATE product_variants SET cost_minor = 70000 WHERE id = 'var_a'");
    const created = await call("POST", "/inventory/purchase-orders", {
      destinationLocationId: "loc_shop",
      lines: [{ variantId: "var_a", quantity: 4, unitCost: 650 }],
    });
    const id = created.body.data.id as string;
    await call("POST", `/inventory/purchase-orders/${id}/order`, { expectedRevision: 1 });
    const lineId = (await call("GET", `/inventory/purchase-orders/${id}`)).body.data.lines[0].id as string;

    permissions = UNCOSTED;
    const detail = await call("GET", `/inventory/purchase-orders/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ displayNumber: "PO1001", quantity: 4, lines: [{ sku: "PANJABI-M", quantity: 4 }] });
    expect([...costKeys(detail.body.data)]).toEqual([]);
    expect(detail.body.data.total).toBeUndefined();
    const list = await call("GET", "/inventory/purchase-orders");
    expect(list.body.data.purchaseOrders[0]).not.toHaveProperty("total");
    expect(list.body.data.purchaseOrders[0]).not.toHaveProperty("subtotal");
    expect(list.body.data.pagination.total).toBe(1);
    const inventory = await call("GET", "/inventory?section=variants");
    expect(inventory.body.data.variants[0]).toMatchObject({ id: "var_a", stock: 8 });
    expect(inventory.body.data.variants[0]).not.toHaveProperty("cost");

    // Receiving works; moving the unit cost would write one, so it is refused.
    const moving = await call("POST", `/inventory/purchase-orders/${id}/receive`, { lines: [{ lineId, quantity: 1 }], updateCost: true }, { "idempotency-key": "receipt-key-0000000010" });
    expect(moving.status).toBe(403);
    const received = await call("POST", `/inventory/purchase-orders/${id}/receive`, { lines: [{ lineId, quantity: 1 }] }, { "idempotency-key": "receipt-key-0000000011" });
    expect(received.status).toBe(200);
    expect([...costKeys(received.body.data)]).toEqual([]);
    expect(sqlite.prepare("SELECT stock, cost_minor FROM product_variants WHERE id = 'var_a'").get()).toEqual({ stock: 9, cost_minor: 70000 });
  });
});

describe("locations", () => {
  it("lists names for stock screens and addresses only for inventory or settings staff", async () => {
    sqlite.exec("UPDATE inventory_locations SET address_line1 = 'House 4, Road 7', phone = '+8801711000000' WHERE id = 'loc_shop'");
    permissions = [PERMISSIONS.PRODUCTS_VIEW];
    const viewer = await call("GET", "/inventory/locations");
    const shop = viewer.body.data.locations.find((location: { id: string }) => location.id === "loc_shop");
    expect(shop).toMatchObject({ id: "loc_shop", name: "Dhanmondi shop", status: "active" });
    expect(shop).not.toHaveProperty("addressLine1");
    expect(shop).not.toHaveProperty("phone");

    for (const detailed of [[PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW], [PERMISSIONS.SETTINGS_GENERAL_VIEW]]) {
      permissions = detailed;
      const full = await call("GET", "/inventory/locations");
      expect(full.body.data.locations.find((location: { id: string }) => location.id === "loc_shop"))
        .toMatchObject({ addressLine1: "House 4, Road 7", phone: "+8801711000000" });
    }
  });
});

describe("routing and RBAC", () => {
  it("serves every path from the catalog family with inventory.view reads and inventory.manage writes", () => {
    for (const path of [
      "/api/v1/admin/inventory/suppliers",
      "/api/v1/admin/inventory/purchase-orders/po_1/receive",
      "/api/v1/admin/inventory/transfers/trf_1/ship",
      "/api/v1/admin/inventory/valuation",
      "/api/v1/admin/inventory/costs",
    ]) expect(classifyAdminRuntimePath(path), path).toBe("catalog");
    expect(getRoutePermission("/api/v1/admin/inventory/purchase-orders/po_1", "GET")).toEqual({ permission: "inventory.view" });
    expect(getRoutePermission("/api/v1/admin/inventory/purchase-orders/po_1/receive", "POST")).toEqual({ permission: "inventory.manage" });
    expect(getRoutePermission("/api/v1/admin/inventory/valuation", "GET")).toEqual({ permission: "products.view_costs" });
  });
});
