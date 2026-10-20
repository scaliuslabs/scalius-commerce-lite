// Inventory locations on real migrated SQLite (commerce hook H1): the level
// triggers, the location records, location-aware stock operations and order
// transitions, and a fold property proving sum(levels) = stock.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { productVariants } from "@scalius/database/schema";
import { and, eq } from "drizzle-orm";

import { executeInventoryOperation } from "./inventory-operations";
import { applyClaimedInventoryEntryBatchWithImpact, applyInventoryForStatusChange } from "./inventory-transitions";
import { reserveStockBatch } from "./reserve";
import { buildStockMovementClaim } from "./stock-movement-claims";
import {
    archiveInventoryLocation,
    createInventoryLocation,
    getProductInventoryLevels,
    getVariantInventoryLevels,
    InventoryLocationShortfallError,
    listInventoryLocations,
    setDefaultInventoryLocation,
    unarchiveInventoryLocation,
    updateInventoryLocation,
} from "./locations";
import { setOrderFulfillmentLocation } from "../orders/admin/fulfillment-location";
import { getInventoryOverview, listInventoryMovements, movementLocationCounts } from "./inventory.service";

let sqlite: DatabaseSync;
let db: Database;

const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number | null>) =>
    sqlite.prepare(query).get(...params) as T;
const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number | null>) =>
    sqlite.prepare(query).all(...params) as T[];
const level = (variantId: string, locationId: string) =>
    one<{ on_hand: number } | undefined>(
        "SELECT on_hand FROM inventory_levels WHERE variant_id = ? AND location_id = ?",
        variantId,
        locationId,
    )?.on_hand ?? 0;

/** One simple product (its default SKU) per variant id. */
function seedCatalog(stock: Record<string, number>) {
    for (const [id, units] of Object.entries(stock)) {
        sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, is_active) VALUES (?, ?, ?, 80000, 1)")
            .run(`prod_${id}`, `Product ${id}`, `product-${id}`);
        sqlite.prepare(`
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
            VALUES (?, ?, ?, 80000, ?, 0, 1, 1, 1)
        `).run(id, `prod_${id}`, `SKU-${id}`, units);
    }
}

function seedLocation(id: string, name: string, status: "active" | "archived" = "active") {
    sqlite.prepare(`
        INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position)
        VALUES (?, ?, ?, 'warehouse', 0, ?, 1)
    `).run(id, name, id.toUpperCase(), status);
}

function seedOrder(id: string, lines: Array<{ variantId: string; quantity: number }>, locationId: string | null = null) {
    sqlite.prepare(`
        INSERT INTO orders (
          id, customer_name, customer_phone, shipping_address, city, zone, currency_code, currency_decimal_places,
          subtotal_amount_minor, total_amount_minor, status, payment_method, payment_status, fulfillment_status,
          inventory_pool, inventory_action, version, fulfillment_location_id
        ) VALUES (?, 'Rahim', '+8801712345601', 'House 1', 'Dhaka', 'North', 'BDT', 2, 0, 0, 'confirmed', 'cod',
          'unpaid', 'pending', 'regular', 'none', 1, ?)
    `).run(id, locationId);
    lines.forEach((line, index) => {
        sqlite.prepare(`
            INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name, inventory_tracked,
              unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor)
            VALUES (?, ?, ?, ?, ?, 'Kurta', 1, 80000, 0, 0, 0, 0)
        `).run(`${id}_item_${index}`, id, `prod_${line.variantId}`, line.variantId, line.quantity);
    });
}

async function reserveOrder(id: string, lines: Array<{ variantId: string; quantity: number }>) {
    const result = await reserveStockBatch(db, lines.map((line) => ({ ...line, orderId: id })), "regular", { salesChannelId: "sc_online_store" });
    if (!result.success) return false;
    sqlite.prepare("UPDATE orders SET inventory_action = 'reserved' WHERE id = ?").run(id);
    return true;
}

const adjust = (variantId: string, delta: number, locationId?: string, key: string = crypto.randomUUID()) =>
    executeInventoryOperation(db, {
        operationKey: `invop_${key}`,
        operationType: "manual_adjustment",
        variantId,
        pool: "stock",
        mode: "relative",
        delta,
        reason: delta > 0 ? "received" : "correction",
        ...(locationId ? { locationId } : {}),
    });

const stocktake = (variantId: string, newStock: number, locationId?: string) =>
    executeInventoryOperation(db, {
        operationKey: `invop_${crypto.randomUUID()}`,
        operationType: "stocktake",
        variantId,
        pool: "stock",
        mode: "stocktake",
        newStock,
        reason: "cycle count",
        ...(locationId ? { locationId } : {}),
    });

/** Every live SKU's levels sum to its stock, and each level is the fold of its movements. */
function expectLevelsFold(initial: Record<string, number>) {
    for (const variant of all<{ id: string; stock: number }>("SELECT id, stock FROM product_variants")) {
        const sum = one<{ total: number }>(
            "SELECT COALESCE(SUM(on_hand), 0) AS total FROM inventory_levels WHERE variant_id = ?",
            variant.id,
        ).total;
        expect(sum, `sum(levels) of ${variant.id}`).toBe(variant.stock);
    }
    const levels = all<{ variant_id: string; location_id: string; on_hand: number }>(
        "SELECT variant_id, location_id, on_hand FROM inventory_levels",
    );
    for (const row of levels) {
        expect(row.on_hand).toBeGreaterThanOrEqual(0);
        const moved = one<{ total: number }>(`
            SELECT COALESCE(SUM(stock_delta), 0) AS total FROM inventory_movements
            WHERE ledger_version = 2 AND variant_id = ? AND location_id = ?
        `, row.variant_id, row.location_id).total;
        const seeded = row.location_id === "loc_default" ? initial[row.variant_id] ?? 0 : 0;
        expect(row.on_hand, `${row.variant_id}@${row.location_id}`).toBe(seeded + moved);
    }
    const unbooked = one<{ n: number }>(`
        SELECT count(*) AS n FROM inventory_movements
        WHERE ledger_version = 2 AND stock_delta <> 0 AND location_id IS NULL
    `).n;
    expect(unbooked).toBe(0);
}

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
});

afterEach(() => sqlite.close());

describe("inventory level triggers", () => {
    it("creates the default location and books a SKU's insert stock there", () => {
        expect(all("SELECT id, name, code, is_default, status FROM inventory_locations")).toEqual([
            { id: "loc_default", name: "Main location", code: "MAIN", is_default: 1, status: "active" },
        ]);
        seedCatalog({ var_a: 7, var_b: 0 });
        expect(all("SELECT variant_id, location_id, on_hand FROM inventory_levels ORDER BY variant_id")).toEqual([
            { variant_id: "var_a", location_id: "loc_default", on_hand: 7 },
        ]);
    });

    it("refuses a v2 stock movement without an active location", () => {
        seedCatalog({ var_a: 5 });
        seedLocation("loc_old", "Old shop", "archived");
        const insert = (id: string, location: string | null) => sqlite.prepare(`
            INSERT INTO inventory_movements (
              id, variant_id, type, quantity, previous_stock, new_stock, ledger_version, pool,
              stock_version_before, stock_version_after, stock_delta, previous_reserved_stock, new_reserved_stock,
              reserved_stock_delta, previous_preorder_stock, new_preorder_stock, preorder_stock_delta, location_id
            ) VALUES (?, 'var_a', 'adjusted', 2, 5, 7, 2, 'regular', 1, 2, 2, 0, 0, 0, 0, 0, 0, ?)
        `).run(id, location);
        expect(() => insert("mv_1", null)).toThrow(/INVENTORY_LOCATION_REQUIRED/);
        expect(() => insert("mv_2", "loc_old")).toThrow(/INVENTORY_LOCATION_REQUIRED/);
        expect(one("SELECT count(*) AS n FROM inventory_movements")).toEqual({ n: 0 });
        expect(level("var_a", "loc_default")).toBe(5);
    });

    it("aborts the whole batch when a location would go below zero", async () => {
        seedCatalog({ var_a: 5 });
        seedLocation("loc_b", "Branch");
        const before = { stock: 5, reservedStock: 0, preorderStock: 0, stockVersion: 1 };
        await expect(safeBatch(db, [
            buildStockMovementClaim(db, {
                movementId: "mv_overdraw",
                variantId: "var_a",
                pool: "regular",
                quantity: -2,
                before,
                after: { ...before, stock: 3, stockVersion: 2 },
                notes: "test",
                locationId: "loc_b",
            }),
            db.update(productVariants)
                .set({ stock: 3, stockVersion: 2 })
                .where(and(eq(productVariants.id, "var_a"), eq(productVariants.stockVersion, 1))),
        ] as never)).rejects.toThrow(/INVENTORY_LEVEL_SHORTFALL/);
        // Nothing of the batch committed.
        expect(one("SELECT stock, stock_version FROM product_variants WHERE id = 'var_a'")).toEqual({ stock: 5, stock_version: 1 });
        expect(one("SELECT count(*) AS n FROM inventory_movements")).toEqual({ n: 0 });
        expect(all("SELECT location_id, on_hand FROM inventory_levels")).toEqual([{ location_id: "loc_default", on_hand: 5 }]);
    });

    it("reverses a compensating movement delete and keeps movements immutable", async () => {
        seedCatalog({ var_a: 5 });
        const before = { stock: 5, reservedStock: 0, preorderStock: 0, stockVersion: 1 };
        await safeBatch(db, [
            buildStockMovementClaim(db, {
                movementId: "mv_in",
                variantId: "var_a",
                pool: "regular",
                quantity: 3,
                before,
                after: { ...before, stock: 8, stockVersion: 2 },
                notes: "test",
            }),
            db.update(productVariants).set({ stock: 8, stockVersion: 2 }).where(eq(productVariants.id, "var_a")),
        ] as never);
        expect(level("var_a", "loc_default")).toBe(8);
        const movement = one<{ id: string }>("SELECT id FROM inventory_movements");
        expect(() => sqlite.prepare("UPDATE inventory_movements SET location_id = NULL WHERE id = ?").run(movement.id))
            .toThrow(/immutable/);
        sqlite.prepare("DELETE FROM inventory_movements WHERE id = ?").run(movement.id);
        expect(level("var_a", "loc_default")).toBe(5);
    });
});

describe("location records", () => {
    it("creates, edits and lists locations with unique codes", async () => {
        const branch = await createInventoryLocation(db, { name: "Chattogram branch", code: "CTG", kind: "store", city: "Chattogram" });
        expect(branch).toMatchObject({ name: "Chattogram branch", code: "CTG", kind: "store", isDefault: false, status: "active", onHand: 0 });
        await expect(createInventoryLocation(db, { name: "Duplicate", code: " ctg " })).rejects.toThrow(/already uses this code/);
        const renamed = await updateInventoryLocation(db, branch.id, {
            name: "CTG store",
            code: "CTG-1",
            kind: "store",
            expectedVersion: branch.version,
        });
        expect(renamed).toMatchObject({ name: "CTG store", code: "CTG-1", version: branch.version + 1 });
        await expect(updateInventoryLocation(db, branch.id, { name: "Stale", code: "CTG-1", expectedVersion: branch.version }))
            .rejects.toThrow(/changed/);
        expect((await listInventoryLocations(db)).map((location) => location.id)).toEqual(["loc_default", branch.id]);
    });

    it("keeps exactly one active default", async () => {
        const branch = await createInventoryLocation(db, { name: "Branch", code: "BR" });
        await setDefaultInventoryLocation(db, branch.id);
        expect(all("SELECT id FROM inventory_locations WHERE is_default = 1")).toEqual([{ id: branch.id }]);
        await archiveInventoryLocation(db, "loc_default");
        await expect(setDefaultInventoryLocation(db, "loc_default")).rejects.toThrow(/archived/);
        expect(all("SELECT id FROM inventory_locations WHERE is_default = 1")).toEqual([{ id: branch.id }]);
        await unarchiveInventoryLocation(db, "loc_default");
        await setDefaultInventoryLocation(db, "loc_default");
        expect(all("SELECT id FROM inventory_locations WHERE is_default = 1")).toEqual([{ id: "loc_default" }]);
    });

    it("archives only a location that holds nothing and ships nothing", async () => {
        seedCatalog({ var_a: 4 });
        const branch = await createInventoryLocation(db, { name: "Branch", code: "BR" });
        await expect(archiveInventoryLocation(db, "loc_default")).rejects.toThrow(/default location can't be archived/);

        await adjust("var_a", 2, branch.id);
        await expect(archiveInventoryLocation(db, branch.id)).rejects.toThrow(/still holds 2 units/);
        await adjust("var_a", -2, branch.id);

        seedOrder("ord_1", [{ variantId: "var_a", quantity: 1 }], branch.id);
        await expect(archiveInventoryLocation(db, branch.id)).rejects.toThrow(/Open orders are set to ship from Branch/);
        sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_1'");

        await expect(archiveInventoryLocation(db, branch.id)).resolves.toMatchObject({ status: "archived" });
        // An archived location takes no stock.
        await expect(adjust("var_a", 1, branch.id)).rejects.toThrow(/archived/);
    });
});

describe("location-aware stock operations", () => {
    it("adjusts and counts one location, part of the replay identity", async () => {
        seedCatalog({ var_a: 5 });
        const branch = await createInventoryLocation(db, { name: "Branch", code: "BR" });
        await expect(adjust("var_a", 4, branch.id, "fixed-key-000001")).resolves.toMatchObject({
            previousStock: 5,
            newStock: 9,
            locationId: branch.id,
            locationPreviousStock: 0,
            locationNewStock: 4,
        });
        await expect(adjust("var_a", 4, undefined, "fixed-key-000001")).rejects.toThrow(/different request/);

        // A stocktake counts only that location.
        await expect(stocktake("var_a", 1, branch.id)).resolves.toMatchObject({
            previousStock: 9,
            newStock: 6,
            delta: -3,
            locationPreviousStock: 4,
            locationNewStock: 1,
        });
        expect(level("var_a", "loc_default")).toBe(5);
        expect(level("var_a", branch.id)).toBe(1);

        // Removing more than the location holds fails before any write.
        await expect(adjust("var_a", -2, branch.id)).rejects.toThrow(/Branch has 1 on hand/);
        const levels = await getVariantInventoryLevels(db, "var_a");
        expect(levels.levels.map(({ locationId, onHand, isDefault }) => ({ locationId, onHand, isDefault }))).toEqual([
            { locationId: "loc_default", onHand: 5, isDefault: true },
            { locationId: branch.id, onHand: 1, isDefault: false },
        ]);
        const overview = await getInventoryOverview(db, {
            section: "variants", search: "", status: "all", page: 1, limit: 10, locationId: branch.id,
        });
        const variants = "variants" in overview ? overview.variants ?? [] : [];
        expect(variants.map((row) => [row.id, row.stock, row.locationOnHand])).toEqual([["var_a", 6, 1]]);
    });
});

describe("per-location reads", () => {
    it("reads a product's SKU levels in one call and filters movement history by location", async () => {
        seedCatalog({ var_a: 5, var_b: 2 });
        const branch = await createInventoryLocation(db, { name: "Branch", code: "BR" });
        await adjust("var_a", 3, branch.id);
        await adjust("var_b", -2);

        expect(await getProductInventoryLevels(db, "prod_var_a")).toEqual({
            productId: "prod_var_a",
            levels: [
                { variantId: "var_a", locationId: "loc_default", onHand: 5 },
                { variantId: "var_a", locationId: branch.id, onHand: 3 },
            ],
            // Nothing is on order or in transit.
            incoming: [],
        });
        // A location the SKU holds nothing at is left out.
        expect((await getProductInventoryLevels(db, "prod_var_b")).levels).toEqual([]);

        const atBranch = await listInventoryMovements(db, { locationId: branch.id, limit: 10 });
        expect(atBranch.movements.map((row) => [row.variantId, row.stockDelta, row.locationName])).toEqual([
            ["var_a", 3, "Branch"],
        ]);
        // History names both scopes: the branch went 0 → 3 while the SKU went 5 → 8 in all.
        expect(atBranch.movements[0]).toMatchObject({
            previousStock: 5, newStock: 8, locationPreviousStock: 0, locationNewStock: 3,
        });
        const atDefault = await listInventoryMovements(db, { locationId: "loc_default", limit: 10 });
        expect(atDefault.movements.map((row) => [row.variantId, row.stockDelta, row.locationName])).toEqual([
            ["var_b", -2, "Main location"],
        ]);
        expect(atDefault.movements[0]).toMatchObject({ locationPreviousStock: 2, locationNewStock: 0 });
    });

    it("reads a location's own count only from the operation that recorded it", () => {
        const payload = JSON.stringify({ variantId: "var_a", previousStock: 5, newStock: 8, delta: 3, locationId: "loc_b", locationPreviousStock: 0, locationNewStock: 3 });
        expect(movementLocationCounts(payload, "loc_b")).toEqual({ locationPreviousStock: 0, locationNewStock: 3 });
        // Another location's counts, no location, a malformed or missing payload: unknown.
        expect(movementLocationCounts(payload, "loc_c")).toEqual({ locationPreviousStock: null, locationNewStock: null });
        expect(movementLocationCounts(payload, null)).toEqual({ locationPreviousStock: null, locationNewStock: null });
        expect(movementLocationCounts("{", "loc_b")).toEqual({ locationPreviousStock: null, locationNewStock: null });
        expect(movementLocationCounts(null, "loc_b")).toEqual({ locationPreviousStock: null, locationNewStock: null });
    });
});

describe("re-reserving a restored order in its sales channel", () => {
    it("takes only units at the locations the order's channel sells from", async () => {
        seedCatalog({ var_a: 5 });
        // Four of the five units sit at a shop the online store does not sell from.
        const shop = await createInventoryLocation(db, { name: "Shop", code: "SHOP" });
        await adjust("var_a", -4);
        await adjust("var_a", 4, shop.id);
        sqlite.prepare("DELETE FROM sales_channel_locations WHERE channel_id = 'sc_online_store' AND location_id = ?").run(shop.id);

        seedOrder("ord_big", [{ variantId: "var_a", quantity: 2 }]);
        seedOrder("ord_small", [{ variantId: "var_a", quantity: 1 }]);
        sqlite.exec("UPDATE orders SET inventory_action = 'restored'");

        await expect(applyInventoryForStatusChange(db, "ord_big", "confirmed")).rejects.toThrow();
        expect(one("SELECT reserved_stock FROM product_variants")).toEqual({ reserved_stock: 0 });
        expect(one("SELECT inventory_action FROM orders WHERE id = 'ord_big'")).toEqual({ inventory_action: "restored" });

        expect(await applyInventoryForStatusChange(db, "ord_small", "confirmed")).toBe("reserved");
        expect(one("SELECT reserved_stock FROM product_variants")).toEqual({ reserved_stock: 1 });
    });
});

describe("order stock at the fulfilment location", () => {
    it("fails a deduct cleanly where the location lacks units, and restores to where units left", async () => {
        seedCatalog({ var_a: 5 });
        const branch = await createInventoryLocation(db, { name: "Branch", code: "BR" });
        seedOrder("ord_1", [{ variantId: "var_a", quantity: 2 }], branch.id);
        expect(await reserveOrder("ord_1", [{ variantId: "var_a", quantity: 2 }])).toBe(true);

        await expect(applyInventoryForStatusChange(db, "ord_1", "shipped"))
            .rejects.toBeInstanceOf(InventoryLocationShortfallError);
        expect(one("SELECT stock, reserved_stock FROM product_variants")).toEqual({ stock: 5, reserved_stock: 2 });
        expect(one("SELECT count(*) AS n FROM inventory_movements WHERE type = 'deducted'")).toEqual({ n: 0 });
        expect(one("SELECT inventory_action FROM orders")).toEqual({ inventory_action: "reserved" });

        // The merchant moves the order back to the default location: it ships from there.
        await setOrderFulfillmentLocation(db, "ord_1", { locationId: null, expectedVersion: 1 });
        await applyInventoryForStatusChange(db, "ord_1", "shipped");
        expect(level("var_a", "loc_default")).toBe(3);
        expect(one("SELECT location_id FROM inventory_movements WHERE type = 'deducted'")).toEqual({ location_id: "loc_default" });
        await expect(setOrderFulfillmentLocation(db, "ord_1", { locationId: branch.id, expectedVersion: 2 }))
            .rejects.toThrow();

        // The default moves; a restore still returns units to where they left.
        await setDefaultInventoryLocation(db, branch.id);
        await applyInventoryForStatusChange(db, "ord_1", "cancelled");
        expect(level("var_a", "loc_default")).toBe(5);
        expect(level("var_a", branch.id)).toBe(0);
        expectLevelsFold({ var_a: 5 });
    });

    it("restores to the order's location, else the default, when the deduct location was archived", async () => {
        seedCatalog({ var_a: 0 });
        const branch = await createInventoryLocation(db, { name: "Branch", code: "BR" });
        await adjust("var_a", 2, branch.id);
        seedOrder("ord_1", [{ variantId: "var_a", quantity: 2 }], branch.id);
        await reserveOrder("ord_1", [{ variantId: "var_a", quantity: 2 }]);
        await applyInventoryForStatusChange(db, "ord_1", "shipped");
        expect(level("var_a", branch.id)).toBe(0);
        await archiveInventoryLocation(db, branch.id);
        await applyInventoryForStatusChange(db, "ord_1", "cancelled");
        expect(level("var_a", "loc_default")).toBe(2);
        expectLevelsFold({ var_a: 0 });
    });
});

describe("order fulfilment location changes on the timeline", () => {
    it("logs one line per change in the same batch, naming where it shipped from and to", async () => {
        seedCatalog({ var_a: 5 });
        const branch = await createInventoryLocation(db, { name: "Branch", code: "BR" });
        seedOrder("ord_1", [{ variantId: "var_a", quantity: 1 }]);
        const events = () => all<{ kind: string; data: string; actor_id: string | null }>(
            "SELECT kind, data, actor_id FROM order_events WHERE order_id = 'ord_1' ORDER BY created_at, id",
        ).map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));

        await setOrderFulfillmentLocation(db, "ord_1", { locationId: branch.id, expectedVersion: 1 });
        // The same request again (a retry) and a no-op change log nothing more.
        await expect(setOrderFulfillmentLocation(db, "ord_1", { locationId: branch.id, expectedVersion: 1 }))
            .rejects.toThrow(/changed/);
        await setOrderFulfillmentLocation(db, "ord_1", { locationId: branch.id, expectedVersion: 2 });
        await setOrderFulfillmentLocation(db, "ord_1", { locationId: null, expectedVersion: 2 });

        expect(events()).toEqual([
            {
                kind: "fulfillment_location_changed",
                actor_id: null,
                data: { fromLocationId: "loc_default", fromName: "Main location", toLocationId: branch.id, toName: "Branch", explicit: true },
            },
            {
                kind: "fulfillment_location_changed",
                actor_id: null,
                data: { fromLocationId: branch.id, fromName: "Branch", toLocationId: "loc_default", toName: "Main location", explicit: false },
            },
        ]);
    });

    it("writes neither the change nor its line when the guarded write is refused", async () => {
        seedCatalog({ var_a: 5 });
        const branch = await createInventoryLocation(db, { name: "Branch", code: "BR" });
        seedOrder("ord_1", [{ variantId: "var_a", quantity: 1 }]);
        // Something already left: an active ship fulfilment blocks the change inside the batch.
        sqlite.prepare(`
            INSERT INTO order_fulfillments (id, order_id, kind, status, request_key, actor_type)
            VALUES ('ful_1', 'ord_1', 'ship', 'active', 'req_1', 'admin')
        `).run();

        await expect(setOrderFulfillmentLocation(db, "ord_1", { locationId: branch.id, expectedVersion: 1 }))
            .rejects.toThrow();
        expect(one("SELECT fulfillment_location_id, version FROM orders")).toEqual({ fulfillment_location_id: null, version: 1 });
        expect(one("SELECT count(*) AS n FROM order_events")).toEqual({ n: 0 });
    });
});

describe("return receipt restock location", () => {
    it("restocks at the named location and reports where units went", async () => {
        seedCatalog({ var_a: 4 });
        const branch = await createInventoryLocation(db, { name: "Branch", code: "BR" });
        seedOrder("ord_1", [{ variantId: "var_a", quantity: 2 }]);
        await reserveOrder("ord_1", [{ variantId: "var_a", quantity: 2 }]);
        await applyInventoryForStatusChange(db, "ord_1", "shipped");
        expect(level("var_a", "loc_default")).toBe(2);

        const named = await applyClaimedInventoryEntryBatchWithImpact(db, {
            orderId: "ord_1",
            operation: "restore",
            entries: [{ variantId: "var_a", quantity: 1 }],
            claimKey: "return-receipt:v1:ret_1:receive-1:line_1",
            pool: "regular",
            locationId: branch.id,
        });
        expect(named.locationIdByVariant).toEqual({ var_a: branch.id });
        expect(level("var_a", branch.id)).toBe(1);

        // Without a named location the next unit returns to where it left.
        const unnamed = await applyClaimedInventoryEntryBatchWithImpact(db, {
            orderId: "ord_1",
            operation: "restore",
            entries: [{ variantId: "var_a", quantity: 1 }],
            claimKey: "return-receipt:v1:ret_1:receive-2:line_1",
            pool: "regular",
        });
        expect(unnamed.locationIdByVariant).toEqual({ var_a: "loc_default" });
        expect(level("var_a", "loc_default")).toBe(3);
        await expect(applyClaimedInventoryEntryBatchWithImpact(db, {
            orderId: "ord_1",
            operation: "deduct",
            entries: [{ variantId: "var_a", quantity: 1 }],
            claimKey: "test:deduct-named",
            pool: "regular",
            locationId: branch.id,
        })).rejects.toThrow(/Only a restore/);
        expectLevelsFold({ var_a: 4 });
    });
});

describe("sum(levels) = stock fold", () => {
    /** Deterministic PRNG so a failing seed replays. */
    function prng(seed: number) {
        let state = seed >>> 0;
        return () => {
            state = (state + 0x6d2b79f5) >>> 0;
            let value = state;
            value = Math.imul(value ^ (value >>> 15), value | 1);
            value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
        };
    }

    it.each([1, 7, 42])("holds across random reserve/release/deduct/restore/adjust/stocktake sequences (seed %i)", async (seed) => {
        const random = prng(seed);
        const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
        const initial = { var_a: 6, var_b: 3, var_c: 0 };
        seedCatalog(initial);
        seedLocation("loc_b", "Branch");
        seedLocation("loc_c", "Store");
        const variants = Object.keys(initial);
        const locations = ["loc_default", "loc_b", "loc_c"];
        const orders: Array<{ id: string; lines: Array<{ variantId: string; quantity: number }> }> = [];

        for (let step = 0; step < 80; step += 1) {
            const action = pick(["adjust", "adjust", "stocktake", "order", "order", "ship", "ship", "ship", "cancel"] as const);
            try {
                if (action === "adjust") {
                    await adjust(pick(variants), pick([-3, -1, 1, 2, 5]), pick(locations));
                } else if (action === "stocktake") {
                    await stocktake(pick(variants), Math.floor(random() * 6), pick(locations));
                } else if (action === "order") {
                    const id = `ord_${step}`;
                    const lines = [{ variantId: pick(variants), quantity: 1 + Math.floor(random() * 3) }];
                    seedOrder(id, lines, pick([null, ...locations]));
                    if (await reserveOrder(id, lines)) orders.push({ id, lines });
                } else if (orders.length > 0) {
                    const order = pick(orders);
                    await applyInventoryForStatusChange(db, order.id, action === "ship" ? "shipped" : "cancelled");
                }
            } catch (error) {
                // Refusals are expected (a location without the units, a count
                // below reservations); they must leave nothing half-written.
                if (!(error instanceof Error)) throw error;
            }
            expectLevelsFold(initial);
        }
        // The sequence exercised every path that moves or holds stock.
        const types = new Set(all<{ type: string }>("SELECT DISTINCT type FROM inventory_movements").map((row) => row.type));
        expect([...types]).toEqual(expect.arrayContaining(["adjusted", "reserved", "released", "deducted", "restored"]));
    });
});
