// Purchasing and transfers on real migrated SQLite (migration 0109):
// suppliers, purchase order lifecycle and receiving (partial, replayed,
// conflicting, cancelled), the weighted-average cost policy and its cost
// history, transfers (ship, partial receive, cancel back to the origin,
// shortfall and committed-stock refusals), incoming stock and valuation.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import {
  archiveSupplier,
  createSupplier,
  listSuppliers,
  unarchiveSupplier,
  updateSupplier,
} from "./suppliers";
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  deletePurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  markPurchaseOrderOrdered,
  receivePurchaseOrder,
  updatePurchaseOrder,
  buildPurchaseOrderCsv,
} from "./purchase-orders";
import {
  cancelTransfer,
  createTransfer,
  getTransfer,
  receiveTransfer,
  shipTransfer,
} from "./transfers";
import { weightedAverageCostMinor } from "./stock-commands";
import { getInventoryValuation, readIncomingStock } from "./inventory-insights";
import { setSkuCosts } from "./unit-costs";
import { archiveInventoryLocation, getProductInventoryLevels } from "./locations";
import { reserveStockBatch } from "./reserve";
import { executeInventoryOperation } from "./inventory-operations";
import { foldInventoryLedgerV2 } from "./ledger-v2";
import { InventoryLocationShortfallError } from "./locations";

let sqlite: DatabaseSync;
let db: Database;

const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number | null>) =>
  sqlite.prepare(query).get(...params) as T;
const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number | null>) =>
  sqlite.prepare(query).all(...params) as T[];
const level = (variantId: string, locationId: string) =>
  one<{ on_hand: number } | undefined>("SELECT on_hand FROM inventory_levels WHERE variant_id = ? AND location_id = ?", variantId, locationId)?.on_hand ?? 0;
const stock = (variantId: string) => one<{ stock: number }>("SELECT stock FROM product_variants WHERE id = ?", variantId).stock;
const cost = (variantId: string) => one<{ cost_minor: number | null }>("SELECT cost_minor FROM product_variants WHERE id = ?", variantId).cost_minor;
let keySeq = 0;
const key = (label: string) => `test-op-${label}-${String(++keySeq).padStart(6, "0")}`;

function seedSku(id: string, units: number, costMinor: number | null = null, kind = "physical") {
  sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, is_active) VALUES (?, ?, ?, 120000, 1)")
    .run(`prod_${id}`, `Product ${id}`, `product-${id}`);
  sqlite.prepare(`
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, cost_minor, fulfillment_kind)
    VALUES (?, ?, ?, 120000, ?, 0, 1, 1, 1, ?, ?)
  `).run(id, `prod_${id}`, `SKU-${id}`, units, costMinor, kind);
}

function seedLocation(id: string, name: string) {
  sqlite.prepare(`INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position) VALUES (?, ?, ?, 'store', 0, 'active', 1)`)
    .run(id, name, id.toUpperCase());
}

/** sum(levels) = stock for every SKU, no level below zero, and every v2 SKU ledger folds without a gap. */
function expectInvariants() {
  for (const variant of all<{ id: string; stock: number; stock_version: number }>("SELECT id, stock, stock_version FROM product_variants")) {
    const sum = one<{ total: number }>("SELECT COALESCE(SUM(on_hand), 0) AS total FROM inventory_levels WHERE variant_id = ?", variant.id).total;
    expect(sum, `sum(levels) of ${variant.id}`).toBe(variant.stock);
    const edges = all<{ stock_version_before: number; stock_version_after: number; previous_stock: number; new_stock: number }>(`
      SELECT stock_version_before, stock_version_after, previous_stock, new_stock FROM inventory_movements
      WHERE variant_id = ? AND ledger_version = 2 ORDER BY stock_version_after`, variant.id);
    for (let index = 1; index < edges.length; index += 1) {
      expect(edges[index]!.stock_version_before, `${variant.id} edge ${index}`).toBe(edges[index - 1]!.stock_version_after);
      expect(edges[index]!.previous_stock, `${variant.id} stock ${index}`).toBe(edges[index - 1]!.new_stock);
    }
    if (edges.length > 0) {
      expect(edges.at(-1)!.stock_version_after).toBe(variant.stock_version);
      expect(edges.at(-1)!.new_stock).toBe(variant.stock);
    }
  }
  expect(one<{ n: number }>("SELECT count(*) AS n FROM inventory_levels WHERE on_hand < 0").n).toBe(0);
}

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  seedLocation("loc_shop", "Dhanmondi shop");
  seedSku("var_a", 10, 40000);
  seedSku("var_b", 0, null);
});

afterEach(() => sqlite.close());

describe("weighted average cost", () => {
  it("averages on-hand and received units, half up, and falls back to the receipt cost", () => {
    expect(weightedAverageCostMinor({ onHand: 10, currentCostMinor: 40000, receivedQuantity: 10, unitCostMinor: 50000 })).toBe(45000);
    expect(weightedAverageCostMinor({ onHand: 2, currentCostMinor: 100, receivedQuantity: 1, unitCostMinor: 101 })).toBe(100); // 100.33
    expect(weightedAverageCostMinor({ onHand: 1, currentCostMinor: 100, receivedQuantity: 1, unitCostMinor: 101 })).toBe(101); // 100.5 → 101
    expect(weightedAverageCostMinor({ onHand: 0, currentCostMinor: 100, receivedQuantity: 5, unitCostMinor: 70 })).toBe(70);
    expect(weightedAverageCostMinor({ onHand: 9, currentCostMinor: null, receivedQuantity: 5, unitCostMinor: 70 })).toBe(70);
    // Exact beyond 2^53 intermediate products.
    expect(weightedAverageCostMinor({ onHand: 1_000_000_000, currentCostMinor: 9_000_000_000, receivedQuantity: 1, unitCostMinor: 0 })).toBe(8_999_999_991);
  });
});

describe("suppliers", () => {
  it("creates, edits at the current version, and archives only without open purchase orders", async () => {
    const supplier = await createSupplier(db, { name: "Dhaka Textiles", phone: "+8801711111111", email: "sales@example.com" });
    expect(supplier).toMatchObject({ name: "Dhaka Textiles", status: "active", version: 1, openPurchaseOrders: 0 });
    await expect(updateSupplier(db, supplier.id, { name: "X", expectedVersion: 9 })).rejects.toThrow(/changed/);
    const edited = await updateSupplier(db, supplier.id, { name: "Dhaka Textiles Ltd", contactName: "Karim", expectedVersion: 1 });
    expect(edited).toMatchObject({ name: "Dhaka Textiles Ltd", contactName: "Karim", version: 2 });
    await expect(createSupplier(db, { name: "Bad", email: "not-an-email" })).rejects.toThrow(/valid email/);

    const order = await createPurchaseOrder(db, { supplierId: supplier.id, lines: [{ variantId: "var_a", quantity: 1, unitCost: 400 }] });
    await markPurchaseOrderOrdered(db, order.id, order.revision);
    await expect(archiveSupplier(db, supplier.id)).rejects.toThrow(/still expected/);
    expect((await listSuppliers(db, { q: "textiles" })).suppliers.map((row) => row.openPurchaseOrders)).toEqual([1]);
    await cancelPurchaseOrder(db, order.id, order.revision + 1);
    expect((await archiveSupplier(db, supplier.id)).status).toBe("archived");
    await expect(createPurchaseOrder(db, { supplierId: supplier.id })).rejects.toThrow(/archived/);
    expect((await unarchiveSupplier(db, supplier.id)).status).toBe("active");
  });
});

describe("purchase orders", () => {
  it("edits a draft, locks its lines once ordered, and receives in parts into the destination", async () => {
    // Outbox facts are emitted only for subscribed topics.
    sqlite.exec(`INSERT INTO webhook_subscriptions (id, url, topics, api_version, secret_ciphertext, secret_hint)
      VALUES ('whs_inventory', 'https://hooks.example.test/inventory', '["variant.*", "purchase_order.*", "inventory_transfer.*"]', '2026-10', 'enc:test', 'test')`);
    const draft = await createPurchaseOrder(db, {
      destinationLocationId: "loc_shop",
      expectedOn: "2026-10-20",
      reference: "INV-77",
      shipping: 150,
      lines: [
        { variantId: "var_a", quantity: 10, unitCost: 500 },
        { variantId: "var_b", quantity: 4, unitCost: 250.5 },
      ],
    });
    expect(draft).toMatchObject({ status: "draft", displayNumber: "PO1001", subtotal: 6002, total: 6152, revision: 1 });
    await expect(createPurchaseOrder(db, { lines: [{ variantId: "var_a", quantity: 1, unitCost: 1 }, { variantId: "var_a", quantity: 1, unitCost: 1 }] }))
      .rejects.toThrow(/appears once/);
    const edited = await updatePurchaseOrder(db, draft.id, {
      expectedRevision: 1,
      lines: [{ variantId: "var_a", quantity: 10, unitCost: 500 }, { variantId: "var_b", quantity: 6, unitCost: 250 }],
    });
    expect(edited.lines.map((line) => [line.sku, line.quantity, line.unitCost])).toEqual([["SKU-var_a", 10, 500], ["SKU-var_b", 6, 250]]);
    await expect(updatePurchaseOrder(db, draft.id, { expectedRevision: 1, notes: "stale" })).rejects.toThrow(/changed/);
    // Not incoming while a draft.
    expect(await readIncomingStock(db, ["var_a"])).toEqual([]);
    const ordered = await markPurchaseOrderOrdered(db, draft.id, edited.revision);
    expect(ordered.status).toBe("ordered");
    await expect(updatePurchaseOrder(db, draft.id, { expectedRevision: ordered.revision, lines: [] })).rejects.toThrow(/lines can't change/);
    const headerEdit = await updatePurchaseOrder(db, draft.id, { expectedRevision: ordered.revision, reference: "INV-78", tax: 90 });
    expect(headerEdit).toMatchObject({ reference: "INV-78", tax: 90, subtotal: 6500, total: 6740 });
    expect(await readIncomingStock(db, ["var_a", "var_b"])).toEqual([
      { variantId: "var_a", locationId: "loc_shop", purchaseOrders: 10, transfers: 0 },
      { variantId: "var_b", locationId: "loc_shop", purchaseOrders: 6, transfers: 0 },
    ]);

    const lineA = headerEdit.lines.find((line) => line.variantId === "var_a")!;
    const lineB = headerEdit.lines.find((line) => line.variantId === "var_b")!;
    const opKey = key("receive");
    const first = await receivePurchaseOrder(db, draft.id, { operationKey: opKey, lines: [{ lineId: lineA.id, quantity: 4 }] });
    expect(first).toMatchObject({ status: "partially_received", displayNumber: "PO1001", costUpdated: false });
    expect([stock("var_a"), level("var_a", "loc_shop"), level("var_a", "loc_default")]).toEqual([14, 4, 10]);
    expect(cost("var_a")).toBe(40000);
    const movement = one<{ type: string; quantity: number; stock_delta: number; location_id: string }>(
      "SELECT type, quantity, stock_delta, location_id FROM inventory_movements WHERE id = ?", first.lines[0]!.movementId);
    expect(movement).toEqual({ type: "received", quantity: 4, stock_delta: 4, location_id: "loc_shop" });

    // An exact retry replays; the same key with another request is refused.
    expect(await receivePurchaseOrder(db, draft.id, { operationKey: opKey, lines: [{ lineId: lineA.id, quantity: 4 }] })).toEqual(first);
    await expect(receivePurchaseOrder(db, draft.id, { operationKey: opKey, lines: [{ lineId: lineA.id, quantity: 5 }] })).rejects.toThrow(/different/);
    expect(stock("var_a")).toBe(14);
    await expect(receivePurchaseOrder(db, draft.id, { operationKey: key("over"), lines: [{ lineId: lineA.id, quantity: 7 }] }))
      .rejects.toThrow(/Only 6/);

    const rest = await receivePurchaseOrder(db, draft.id, {
      operationKey: key("rest"),
      updateCost: true,
      lines: [{ lineId: lineA.id, quantity: 6 }, { lineId: lineB.id, quantity: 6 }],
    });
    expect(rest.status).toBe("received");
    // (14 × 400 + 6 × 500) / 20 = 430 taka; var_b had no cost: the receipt cost.
    expect([cost("var_a"), cost("var_b")]).toEqual([43000, 25000]);
    expect(rest.lines.map((line) => [line.sku, line.costBefore, line.costAfter])).toEqual([["SKU-var_a", 400, 430], ["SKU-var_b", null, 250]]);
    const detail = await getPurchaseOrder(db, draft.id);
    expect(detail.receipts.map((receipt) => receipt.lines.map((line) => [line.sku, line.quantity, line.unitCost, line.costUpdated]))).toEqual([
      [["SKU-var_a", 4, 500, false]],
      [["SKU-var_a", 6, 500, true], ["SKU-var_b", 6, 250, true]],
    ]);
    expect(detail.receivedAt).not.toBeNull();
    expect(await readIncomingStock(db, ["var_a", "var_b"])).toEqual([]);
    await expect(receivePurchaseOrder(db, draft.id, { operationKey: key("late"), lines: [{ lineId: lineA.id, quantity: 1 }] }))
      .rejects.toThrow(/is received/);
    await expect(cancelPurchaseOrder(db, draft.id, detail.revision)).rejects.toThrow(/can't be cancelled/);
    expect((await listPurchaseOrders(db, { q: "PO1001" })).purchaseOrders.map((row) => row.status)).toEqual(["received"]);
    expectInvariants();
    // Every receipt emitted its document event and a level event per SKU.
    expect(all<{ topic: string }>("SELECT topic FROM event_outbox WHERE topic IN ('purchase_order.updated', 'variant.inventory_changed') ORDER BY rowid").map((row) => row.topic))
      .toEqual(expect.arrayContaining(["purchase_order.updated", "variant.inventory_changed"]));
  });

  it("cancels the rest of a partially received order, deletes only drafts, and exports CSV", async () => {
    const order = await createPurchaseOrder(db, { lines: [{ variantId: "var_a", quantity: 5, unitCost: 410 }] });
    await expect(markPurchaseOrderOrdered(db, (await createPurchaseOrder(db, {})).id, 1)).rejects.toThrow(/at least one product/);
    const ordered = await markPurchaseOrderOrdered(db, order.id, 1);
    const receipt = await receivePurchaseOrder(db, order.id, { operationKey: key("p"), lines: [{ lineId: ordered.lines[0]!.id, quantity: 2 }] });
    await expect(deletePurchaseOrder(db, order.id, receipt.revision)).rejects.toThrow(/can't be deleted/);
    const cancelled = await cancelPurchaseOrder(db, order.id, receipt.revision);
    expect(cancelled.status).toBe("cancelled");
    expect(stock("var_a")).toBe(12);
    expect(await readIncomingStock(db, ["var_a"])).toEqual([]);
    const csv = await buildPurchaseOrderCsv(db, order.id);
    expect(csv.body.startsWith("﻿")).toBe(true);
    expect(csv.body).toContain('"SKU-var_a","Product var_a","","","5","2","3","410","2050"');
    const draft = await createPurchaseOrder(db, { lines: [{ variantId: "var_b", quantity: 1, unitCost: 1 }] });
    expect(await deletePurchaseOrder(db, draft.id, 1)).toEqual({ id: draft.id, deleted: true });
    expect(one("SELECT count(*) AS n FROM purchase_order_lines WHERE purchase_order_id = ?", draft.id)).toEqual({ n: 0 });
  });

  it("names the admin behind a receipt, including one made from a scanner session", async () => {
    sqlite.exec("INSERT INTO user (id, name, email, email_verified, role) VALUES ('usr_karim', 'Karim', 'karim@shop.test', 1, 'admin')");
    const order = await createPurchaseOrder(db, { lines: [{ variantId: "var_a", quantity: 4, unitCost: 400 }] });
    const ordered = await markPurchaseOrderOrdered(db, order.id, 1);
    const lineId = ordered.lines[0]!.id;
    await receivePurchaseOrder(db, order.id, { operationKey: key("desk"), lines: [{ lineId, quantity: 1 }] }, "usr_karim");
    await receivePurchaseOrder(db, order.id, { operationKey: key("scan"), lines: [{ lineId, quantity: 1 }] }, "scanner:usr_karim");
    await receivePurchaseOrder(db, order.id, { operationKey: key("gone"), lines: [{ lineId, quantity: 1 }] }, "usr_removed");
    await receivePurchaseOrder(db, order.id, { operationKey: key("system"), lines: [{ lineId, quantity: 1 }] });
    expect((await getPurchaseOrder(db, order.id)).receipts.map((receipt) => receipt.actorName))
      .toEqual(["Karim", "Karim", "Former admin", "System"]);
  });

  it("refuses non-physical SKUs and archiving a destination with open orders", async () => {
    seedSku("var_key", 3, null, "digital");
    seedSku("var_service", 0, null, "service");
    // A digital SKU's stock is its licence keys (digital-stock.d1.test.ts covers every path).
    await expect(createPurchaseOrder(db, { lines: [{ variantId: "var_key", quantity: 1, unitCost: 1 }] }))
      .rejects.toMatchObject({ details: { reason: "digital_stock_is_keys", field: "lines.0.variantId" } });
    await expect(createPurchaseOrder(db, { lines: [{ variantId: "var_service", quantity: 1, unitCost: 1 }] })).rejects.toThrow(/not a physical item/);
    const order = await createPurchaseOrder(db, { destinationLocationId: "loc_shop", lines: [{ variantId: "var_b", quantity: 1, unitCost: 1 }] });
    await markPurchaseOrderOrdered(db, order.id, 1);
    await expect(archiveInventoryLocation(db, "loc_shop")).rejects.toThrow(/Purchase orders or transfers/);
  });
});

describe("transfers", () => {
  it("ships out of the origin and stock, receives in parts, and keeps sum(levels) = stock", async () => {
    const draft = await createTransfer(db, { originLocationId: "loc_default", destinationLocationId: "loc_shop", lines: [{ variantId: "var_a", quantity: 6 }] });
    await expect(createTransfer(db, { originLocationId: "loc_shop", destinationLocationId: "loc_shop" })).rejects.toThrow(/other than the origin/);
    expect(draft).toMatchObject({ status: "draft", displayNumber: "T1001", inTransitQuantity: 0 });
    const shipKey = key("ship");
    const shipped = await shipTransfer(db, draft.id, { operationKey: shipKey, expectedRevision: 1 });
    expect(shipped).toMatchObject({ kind: "ship", status: "in_transit", revision: 2 });
    // In transit: out of the origin and out of stock; nothing at the destination yet.
    expect([stock("var_a"), level("var_a", "loc_default"), level("var_a", "loc_shop")]).toEqual([4, 4, 0]);
    expect(await shipTransfer(db, draft.id, { operationKey: shipKey, expectedRevision: 1 })).toEqual(shipped);
    expect(stock("var_a")).toBe(4);
    expect(await readIncomingStock(db, ["var_a"])).toEqual([{ variantId: "var_a", locationId: "loc_shop", purchaseOrders: 0, transfers: 6 }]);
    expectInvariants();

    const line = (await getTransfer(db, draft.id)).lines[0]!;
    const part = await receiveTransfer(db, draft.id, { operationKey: key("in"), lines: [{ lineId: line.id, quantity: 4 }] });
    expect(part.status).toBe("partially_received");
    expect([stock("var_a"), level("var_a", "loc_default"), level("var_a", "loc_shop")]).toEqual([8, 4, 4]);
    await expect(receiveTransfer(db, draft.id, { operationKey: key("in2"), lines: [{ lineId: line.id, quantity: 3 }] })).rejects.toThrow(/Only 2/);
    const done = await receiveTransfer(db, draft.id, { operationKey: key("in3"), lines: [{ lineId: line.id, quantity: 2 }] });
    expect(done.status).toBe("received");
    expect([stock("var_a"), level("var_a", "loc_default"), level("var_a", "loc_shop")]).toEqual([10, 4, 6]);
    const detail = await getTransfer(db, draft.id);
    expect(detail.activity.map((entry) => [entry.kind, entry.lines.map((row) => row.quantity)])).toEqual([["ship", [6]], ["receive", [4]], ["receive", [2]]]);
    expect(all<{ type: string; stock_delta: number; location_id: string }>(
      "SELECT type, stock_delta, location_id FROM inventory_movements WHERE variant_id = 'var_a' ORDER BY stock_version_after",
    )).toEqual([
      { type: "transfer_out", stock_delta: -6, location_id: "loc_default" },
      { type: "transfer_in", stock_delta: 4, location_id: "loc_shop" },
      { type: "transfer_in", stock_delta: 2, location_id: "loc_shop" },
    ]);
    expectInvariants();
  });

  it("cancels in transit back to the origin and refuses a shortfall or committed units before writing", async () => {
    const transfer = await createTransfer(db, { originLocationId: "loc_default", destinationLocationId: "loc_shop", lines: [{ variantId: "var_a", quantity: 5 }] });
    await shipTransfer(db, transfer.id, { operationKey: key("s"), expectedRevision: 1 });
    const line = (await getTransfer(db, transfer.id)).lines[0]!;
    await receiveTransfer(db, transfer.id, { operationKey: key("r"), lines: [{ lineId: line.id, quantity: 1 }] });
    const cancelled = await cancelTransfer(db, transfer.id, { operationKey: key("c"), expectedRevision: 3 });
    expect(cancelled).toMatchObject({ kind: "return", status: "cancelled", locationId: "loc_default", lines: [{ quantity: 4 }] });
    expect([stock("var_a"), level("var_a", "loc_default"), level("var_a", "loc_shop")]).toEqual([10, 9, 1]);
    expect((await getTransfer(db, transfer.id)).lines[0]).toMatchObject({ receivedQuantity: 1, returnedQuantity: 4, inTransitQuantity: 0 });

    // The shop holds 1: shipping 3 from it is refused and nothing is written.
    const short = await createTransfer(db, { originLocationId: "loc_shop", destinationLocationId: "loc_default", lines: [{ variantId: "var_a", quantity: 3 }] });
    const movements = one<{ n: number }>("SELECT count(*) AS n FROM inventory_movements").n;
    await expect(shipTransfer(db, short.id, { operationKey: key("short"), expectedRevision: 1 })).rejects.toBeInstanceOf(InventoryLocationShortfallError);
    expect(one<{ n: number }>("SELECT count(*) AS n FROM inventory_movements").n).toBe(movements);
    expect((await getTransfer(db, short.id)).status).toBe("draft");

    // Units committed to an order stay put.
    const reserved = await reserveStockBatch(db, [{ variantId: "var_a", quantity: 8, orderId: "ord_hold" }], "regular", { salesChannelId: "sc_online_store" });
    expect(reserved.success).toBe(true);
    const committed = await createTransfer(db, { originLocationId: "loc_default", destinationLocationId: "loc_shop", lines: [{ variantId: "var_a", quantity: 3 }] });
    await expect(shipTransfer(db, committed.id, { operationKey: key("committed"), expectedRevision: 1 })).rejects.toThrow(/committed to orders/);
    // A draft cancels without moving stock.
    expect((await cancelTransfer(db, committed.id, { operationKey: key("draft"), expectedRevision: 1 })).status).toBe("cancelled");
    expectInvariants();
  });

  it("reports incoming stock in the product editor read and values inventory per location", async () => {
    await setSkuCosts(db, { items: [{ variantId: "var_b", cost: 99.5, expectedCost: null }] });
    await expect(setSkuCosts(db, { items: [{ variantId: "var_b", cost: 1, expectedCost: 5 }] })).rejects.toThrow(/cost changed/);
    const order = await createPurchaseOrder(db, { destinationLocationId: "loc_shop", lines: [{ variantId: "var_b", quantity: 3, unitCost: 100 }] });
    const ordered = await markPurchaseOrderOrdered(db, order.id, 1);
    await receivePurchaseOrder(db, order.id, { operationKey: key("v"), lines: [{ lineId: ordered.lines[0]!.id, quantity: 2 }] });
    const transfer = await createTransfer(db, { originLocationId: "loc_default", destinationLocationId: "loc_shop", lines: [{ variantId: "var_a", quantity: 2 }] });
    await shipTransfer(db, transfer.id, { operationKey: key("t"), expectedRevision: 1 });
    const levels = await getProductInventoryLevels(db, "prod_var_b");
    expect(levels.incoming).toEqual([{ variantId: "var_b", locationId: "loc_shop", purchaseOrders: 1, transfers: 0 }]);
    const valuation = await getInventoryValuation(db);
    expect(valuation.locations.map((row) => [row.locationId, row.units, row.value])).toEqual([
      ["loc_default", 8, 3200],
      ["loc_shop", 2, 199],
    ]);
    expect(valuation.total).toEqual({ units: 10, value: 3399, unitsWithoutCost: 0, skusWithoutCost: 0 });
    expect(valuation.inTransit).toEqual({ units: 2, value: 800, unitsWithoutCost: 0 });
  });
});

describe("batch shape and races", () => {
  it("receives a 100-line purchase order in one batch, every statement within D1's parameter limit", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `var_bulk_${String(index).padStart(3, "0")}`);
    for (const id of ids) seedSku(id, 1, 1000);
    const order = await createPurchaseOrder(db, { lines: ids.map((variantId) => ({ variantId, quantity: 2, unitCost: 12.5 })) });
    const ordered = await markPurchaseOrderOrdered(db, order.id, 1);
    const batches: number[] = [];
    const observed = createSqliteD1Database({ sqlite, beforeBatch: (_sqlite, statements) => { batches.push(statements.length); } }).db;
    const result = await receivePurchaseOrder(observed, order.id, {
      operationKey: key("bulk"),
      updateCost: true,
      lines: ordered.lines.map((line) => ({ lineId: line.id, quantity: 2 })),
    });
    expect(result.status).toBe("received");
    // The harness throws above 100 bound values a statement; the one stock batch:
    // 100 × (claim + CAS) + guards + command + 1 progress update + 8 receipt inserts + header + buyer state.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toBeLessThanOrEqual(230);
    // (1 × 10.00 + 2 × 12.50) / 3 = 11.666… → 11.67 (half up, in paisa).
    expect(cost("var_bulk_000")).toBe(1167);
    expectInvariants();
  });

  it("re-plans after a lost compare-and-set and never commits part of a receipt", async () => {
    const order = await createPurchaseOrder(db, { lines: [{ variantId: "var_a", quantity: 3, unitCost: 450 }, { variantId: "var_b", quantity: 2, unitCost: 300 }] });
    const ordered = await markPurchaseOrderOrdered(db, order.id, 1);
    let raced = false;
    const racing = createSqliteD1Database({
      sqlite,
      beforeBatch: (target) => {
        if (raced) return;
        raced = true;
        // Another writer sells var_a's counters forward (a valid ledger edge) after the receipt read them.
        const sku = target.prepare("SELECT stock, stock_version FROM product_variants WHERE id = 'var_a'").get() as { stock: number; stock_version: number };
        target.prepare(`INSERT INTO inventory_movements (id, variant_id, type, quantity, previous_stock, new_stock, ledger_version, pool,
          stock_version_before, stock_version_after, stock_delta, previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
          previous_preorder_stock, new_preorder_stock, preorder_stock_delta, location_id)
          VALUES ('mv_race', 'var_a', 'adjusted', -1, ?, ?, 2, 'regular', ?, ?, -1, 0, 0, 0, 0, 0, 0, 'loc_default')`)
          .run(sku.stock, sku.stock - 1, sku.stock_version, sku.stock_version + 1);
        target.prepare("UPDATE product_variants SET stock = stock - 1, stock_version = stock_version + 1 WHERE id = 'var_a'").run();
      },
    }).db;
    const result = await receivePurchaseOrder(racing, order.id, {
      operationKey: key("race"),
      updateCost: true,
      lines: ordered.lines.map((line) => ({ lineId: line.id, quantity: line.quantity })),
    });
    expect(raced).toBe(true);
    expect(result.status).toBe("received");
    // 10 − 1 sold + 3 received; the average saw the fresh on-hand (9 × 400 + 3 × 450) / 12 = 412.5.
    expect([stock("var_a"), stock("var_b"), cost("var_a")]).toEqual([12, 2, 41250]);
    expect(one<{ n: number }>("SELECT count(*) AS n FROM purchase_order_receipt_lines").n).toBe(2);
    expect(one<{ n: number }>("SELECT count(*) AS n FROM inventory_commands").n).toBe(1);
    expectInvariants();
  });
});

describe("random command sequences", () => {
  /** Every SKU's v2 ledger folds from its seeded counters to its current counters without a gap. */
  function expectLedgerFolds(initial: Record<string, number>) {
    for (const variant of all<{ id: string; stock: number; reserved_stock: number; preorder_stock: number; stock_version: number }>(
      "SELECT id, stock, reserved_stock, preorder_stock, stock_version FROM product_variants",
    )) {
      const events = all<Record<string, number | string | null>>(`
        SELECT id, variant_id, order_id, type, pool, reservation_generation, stock_version_before, stock_version_after,
          previous_stock, new_stock, stock_delta, previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
          previous_preorder_stock, new_preorder_stock, preorder_stock_delta
        FROM inventory_movements WHERE variant_id = ? AND ledger_version = 2 ORDER BY stock_version_after`, variant.id)
        .map((row) => ({
          id: String(row.id), variantId: String(row.variant_id), orderId: row.order_id as string | null, type: String(row.type),
          pool: row.pool as "regular", reservationGeneration: row.reservation_generation as number | null,
          stockVersionBefore: Number(row.stock_version_before), stockVersionAfter: Number(row.stock_version_after),
          previousStock: Number(row.previous_stock), newStock: Number(row.new_stock), stockDelta: Number(row.stock_delta),
          previousReservedStock: Number(row.previous_reserved_stock), newReservedStock: Number(row.new_reserved_stock),
          reservedStockDelta: Number(row.reserved_stock_delta), previousPreorderStock: Number(row.previous_preorder_stock),
          newPreorderStock: Number(row.new_preorder_stock), preorderStockDelta: Number(row.preorder_stock_delta),
        }));
      expect(foldInventoryLedgerV2({ stock: initial[variant.id] ?? 0, reservedStock: 0, preorderStock: 0, stockVersion: 1 }, events))
        .toEqual({ stock: variant.stock, reservedStock: variant.reserved_stock, preorderStock: variant.preorder_stock, stockVersion: variant.stock_version });
    }
  }

  it.each([20261003, 7, 424242])("keep every ledger invariant through receipts, transfers, adjustments, holds and replays (seed %i)", async (initialSeed) => {
    seedLocation("loc_c", "Chittagong");
    const locations = ["loc_default", "loc_shop", "loc_c"];
    const skus = ["var_a", "var_b"];
    let seed = initialSeed;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const attempt = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        // Refusals (shortfall, committed units, nothing in transit, stale) are expected; they must write nothing partial.
        if (!(error instanceof Error) || !/(has|have|holds|enough|Only|nothing|in transit|changed|received|cancelled|committed|can't|reserved|at most)/i.test(error.message)) throw error;
      }
    };
    let manualDelta = 0;
    for (let step = 0; step < 45; step += 1) {
      const variantId = skus[random(skus.length)]!;
      const action = random(7);
      if (action === 0 || action === 1) {
        const order = await createPurchaseOrder(db, { destinationLocationId: locations[random(3)], lines: [{ variantId, quantity: 1 + random(5), unitCost: 100 + random(50) }] });
        const ordered = await markPurchaseOrderOrdered(db, order.id, 1);
        const receiptKey = key("rand-po");
        const updateCost = random(2) === 1;
        const receive = () => receivePurchaseOrder(db, order.id, { operationKey: receiptKey, updateCost, lines: [{ lineId: ordered.lines[0]!.id, quantity: 1 }] });
        await attempt(receive);
        // An exact retry of the same receipt replays; nothing moves twice.
        if (random(2) === 0) await attempt(receive);
      } else if (action === 2) {
        const delta = random(2) === 0 ? 1 + random(3) : -(1 + random(3));
        const applied = await executeInventoryOperation(db, {
          operationKey: key("rand-adjust"), operationType: "manual_adjustment", variantId, pool: "stock",
          mode: "relative", delta, reason: delta > 0 ? "received" : "correction", locationId: locations[random(3)],
        }).then((result) => result.delta, () => 0);
        manualDelta += applied;
      } else if (action === 3) {
        await reserveStockBatch(db, [{ variantId, quantity: 1, orderId: `ord_rand_${step}` }], "regular", { salesChannelId: "sc_online_store" });
      } else {
        const origin = locations[random(3)]!;
        const destination = locations.filter((location) => location !== origin)[random(2)]!;
        const transfer = await createTransfer(db, { originLocationId: origin, destinationLocationId: destination, lines: [{ variantId, quantity: 1 + random(4) }] });
        const shipKey = key("rand-ship");
        await attempt(() => shipTransfer(db, transfer.id, { operationKey: shipKey, expectedRevision: 1 }));
        if (random(3) === 0) await attempt(() => shipTransfer(db, transfer.id, { operationKey: shipKey, expectedRevision: 1 }));
        const current = await getTransfer(db, transfer.id);
        if (current.status === "in_transit") {
          const line = current.lines[0]!;
          if (random(2) === 0) await attempt(() => receiveTransfer(db, transfer.id, { operationKey: key("rand-in"), lines: [{ lineId: line.id, quantity: 1 + random(line.inTransitQuantity) }] }));
          const latest = await getTransfer(db, transfer.id);
          if (latest.inTransitQuantity > 0 && random(2) === 0) {
            await attempt(() => cancelTransfer(db, transfer.id, { operationKey: key("rand-cancel"), expectedRevision: latest.revision }));
          }
        }
      }
      expectInvariants();
      // Committed units never ship: stock stays at or above what orders hold.
      expect(one<{ n: number }>("SELECT count(*) AS n FROM product_variants WHERE stock < reserved_stock").n).toBe(0);
    }
    expectLedgerFolds({ var_a: 10, var_b: 0 });
    // Conservation: on hand + in transit = seeded + received + manual changes.
    const inTransit = one<{ n: number }>("SELECT COALESCE(SUM(shipped_quantity - received_quantity - returned_quantity), 0) AS n FROM inventory_transfer_lines").n;
    const received = one<{ n: number }>("SELECT COALESCE(SUM(quantity), 0) AS n FROM purchase_order_receipt_lines").n;
    const total = one<{ n: number }>("SELECT SUM(stock) AS n FROM product_variants").n;
    expect(total + inTransit).toBe(10 + received + manualDelta);
  });
});
