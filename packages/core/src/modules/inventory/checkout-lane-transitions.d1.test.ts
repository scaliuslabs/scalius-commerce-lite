import {
    DatabaseSync,
    type SQLInputValue,
    type SQLOutputValue,
    type StatementSync,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import {
    buildCheckoutCommitStatements,
    buildEnsureCheckoutReservationLanesStatement,
    type CheckoutCommittedOrderRow,
    type PortableSqlStatement,
    type PreparedCheckoutCommit,
} from "@scalius/database/checkout-commit";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import * as schema from "@scalius/database/schema";

import {
    applyInventoryForStatusChange,
    applyInventoryForStatusChangeWithImpact,
} from "./inventory-transitions";

const migrationDirectory = fileURLToPath(new URL(
    "../../../../database/migrations/",
    import.meta.url,
));

function createProviderSchemaDatabase(): DatabaseSync {
    const sqlite = new DatabaseSync(":memory:");
    for (const name of readdirSync(migrationDirectory)
        .filter((candidate) => /^\d{4}_.+\.sql$/.test(candidate))
        .sort()) {
        const migration = readFileSync(`${migrationDirectory}/${name}`, "utf8");
        sqlite.exec(compileSqliteMigrationForProvider(migration, "d1"));
    }
    return sqlite;
}

interface SqliteD1Result {
    results: Record<string, SQLOutputValue>[];
    success: true;
    meta: Record<string, never>;
}

interface SqliteD1Statement {
    bind(...values: SQLInputValue[]): SqliteD1Statement;
    run(): Promise<SqliteD1Result>;
    all(): Promise<SqliteD1Result>;
    raw(): Promise<SQLOutputValue[][]>;
    first(column?: string): Promise<unknown>;
    execute(): SqliteD1Result;
}

function rows(
    statement: StatementSync,
    values: SQLInputValue[],
): Record<string, SQLOutputValue>[] {
    return statement.all(...values);
}

function d1Statement(
    sqlite: DatabaseSync,
    query: string,
    values: SQLInputValue[] = [],
): SqliteD1Statement {
    const execute = (): SqliteD1Result => ({
        results: rows(sqlite.prepare(query), values),
        success: true,
        meta: {},
    });
    return {
        bind: (...nextValues) => d1Statement(sqlite, query, nextValues),
        run: async () => execute(),
        all: async () => execute(),
        raw: async () => {
            const statement = sqlite.prepare(query);
            statement.setReturnArrays(true);
            return statement.all(...values) as unknown as SQLOutputValue[][];
        },
        first: async (column) => {
            const row = rows(sqlite.prepare(query), values)[0];
            return column ? row?.[column] ?? null : row ?? null;
        },
        execute,
    };
}

function drizzleDatabase(sqlite: DatabaseSync): Database {
    const binding = {
        prepare: (query: string) => d1Statement(sqlite, query),
        async batch(statements: SqliteD1Statement[]) {
            sqlite.exec("BEGIN IMMEDIATE");
            try {
                const results = statements.map((statement) => statement.execute());
                sqlite.exec("COMMIT");
                return results;
            } catch (error) {
                sqlite.exec("ROLLBACK");
                throw error;
            }
        },
    };
    return drizzle(binding as unknown as D1Database, { schema }) as unknown as Database;
}

function executeRun(sqlite: DatabaseSync, statement: PortableSqlStatement): void {
    sqlite.prepare(statement.sql).run(...statement.args as SQLInputValue[]);
}

function orderRow(id: string): CheckoutCommittedOrderRow {
    return {
        id,
        customerName: "Checkout Lane Buyer",
        customerPhone: "+8801700000000",
        customerEmail: null,
        shippingAddress: "123 Test Road",
        city: "city_1",
        zone: "zone_1",
        area: null,
        cityName: "Dhaka",
        zoneName: "Dhanmondi",
        areaName: null,
        totalAmount: 200,
        shippingCharge: 0,
        discountAmount: 0,
        currencyCode: "BDT",
        currencyDecimalPlaces: 2,
        subtotalAmountMinor: 20_000,
        shippingAmountMinor: 0,
        shippingMethodId: "shipping_standard",
        shippingMethodName: "Standard delivery",
        shippingMethodDescription: null,
        shippingMethodBaseAmountMinor: 0,
        shippingFeeWaived: false,
        discountAmountMinor: 0,
        taxAmountMinor: 0,
        totalAmountMinor: 20_000,
        taxLabel: "Tax",
        pricesIncludeTax: false,
        status: "pending",
        notes: null,
        paymentMethod: "cod",
        paymentStatus: "unpaid",
        paidAmount: 0,
        balanceDue: 200,
        fulfillmentStatus: "pending",
        inventoryPool: "regular",
        inventoryAction: "reserved",
        customerId: null,
        accountOwnerCustomerId: null,
    };
}

function checkoutCommit(
    orderId: string,
    authorityRevision: number,
): PreparedCheckoutCommit {
    const requestKey = `checkout_submit:v1:${orderId}`;
    const requestHash = `hash_${orderId}`;
    const receiptHash = `receipt_${orderId}`;
    const response = { orderId, receiptToken: `proof_${orderId}` };
    const order = orderRow(orderId);
    return {
        requestKey,
        requestHash,
        receiptHash,
        authorityRevision,
        lane: 0,
        order,
        response,
        aggregate: {
            schemaVersion: 1,
            checkout: { requestKey, requestHash, receiptHash, authorityRevision, response },
            payload: {
                orderData: order,
                items: [{
                    id: `item_${orderId}`,
                    productId: "product_hot",
                    variantId: "variant_hot",
                    quantity: 2,
                    inventoryTracked: true,
                }],
            },
        },
        edges: [{
            variantId: "variant_hot",
            pool: "regular",
            lane: 0,
            quantity: 2,
            capacity: 4,
            reservedBefore: 0,
            reservedAfter: 2,
            laneVersionBefore: 0,
            laneVersionAfter: 1,
            sourceStockVersion: 1,
        }],
    };
}

function commitCheckout(sqlite: DatabaseSync, orderId: string): void {
    executeRun(sqlite, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    const authority = sqlite.prepare(`
        SELECT revision FROM checkout_authority WHERE id = 'default'
    `).get() as { revision: number };
    const statements = buildCheckoutCommitStatements(
        [checkoutCommit(orderId, Number(authority.revision))],
        `batch_${orderId}`,
    );
    sqlite.exec("BEGIN IMMEDIATE");
    try {
        sqlite.prepare(statements[0]!.sql).all(...statements[0]!.args as SQLInputValue[]);
        executeRun(sqlite, statements[1]!);
        executeRun(sqlite, statements[2]!);
        sqlite.prepare(statements[3]!.sql).all(...statements[3]!.args as SQLInputValue[]);
        executeRun(sqlite, statements[4]!);
        sqlite.exec("COMMIT");
    } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
    }
}

describe("coordinated checkout lane lifecycle on D1 SQL", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(async () => {
        sqlite = createProviderSchemaDatabase();
        sqlite.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO products (id, name, price, slug, is_active)
            VALUES ('product_hot', 'Hot product', 100, 'hot-product', 1);
            INSERT INTO product_variants (
                id, product_id, sku, price, stock, reserved_stock,
                stock_version, track_inventory, is_default
            ) VALUES (
                'variant_hot', 'product_hot', 'HOT-1', 100, 10, 2,
                1, 1, 1
            );
        `);
        db = drizzleDatabase(sqlite);
    });

    afterEach(() => sqlite.close());

    it("releases the exact lane edge atomically and replays as a no-op", async () => {
        commitCheckout(sqlite, "order_release");
        sqlite.exec(`UPDATE product_variants SET low_stock_threshold = 6 WHERE id = 'variant_hot'`);
        sqlite.exec(`UPDATE orders SET status = 'cancelled' WHERE id = 'order_release'`);

        await expect(applyInventoryForStatusChangeWithImpact(db, "order_release", "cancelled"))
            .resolves.toEqual({
                inventoryAction: "restored",
                availabilityTransitionVariantIds: ["variant_hot"],
            });
        await expect(applyInventoryForStatusChange(db, "order_release", "cancelled"))
            .resolves.toBe("restored");

        expect(sqlite.prepare(`
            SELECT inventory_action AS action, inventory_authority AS authority
            FROM orders WHERE id = 'order_release'
        `).get()).toEqual({ action: "restored", authority: "checkout_lane_v1" });
        expect(sqlite.prepare(`
            SELECT reserved_quantity AS reserved, version
            FROM inventory_reservation_lanes
            WHERE variant_id = 'variant_hot' AND pool = 'regular' AND lane = 0
        `).get()).toEqual({ reserved: 0, version: 2 });
        expect(sqlite.prepare(`
            SELECT stock, reserved_stock AS legacyReserved, stock_version AS stockVersion
            FROM product_variants WHERE id = 'variant_hot'
        `).get()).toEqual({ stock: 10, legacyReserved: 2, stockVersion: 1 });
        expect(sqlite.prepare(`
            SELECT operation, quantity, lane_reserved_before AS before, lane_reserved_after AS after
            FROM checkout_inventory_lane_movements WHERE order_id = 'order_release'
        `).get()).toEqual({ operation: "released", quantity: 2, before: 2, after: 0 });
        expect(sqlite.prepare(`
            SELECT COUNT(*) AS count FROM inventory_movements WHERE order_id = 'order_release'
        `).get()).toEqual({ count: 0 });
    });

    it("deducts physical stock, records both ledgers, then restores exactly once", async () => {
        commitCheckout(sqlite, "order_deduct");
        sqlite.exec(`UPDATE orders SET status = 'shipped' WHERE id = 'order_deduct'`);

        await expect(applyInventoryForStatusChangeWithImpact(db, "order_deduct", "shipped"))
            .resolves.toEqual({
                inventoryAction: "deducted",
                availabilityTransitionVariantIds: [],
            });
        await expect(applyInventoryForStatusChange(db, "order_deduct", "shipped"))
            .resolves.toBe("deducted");

        expect(sqlite.prepare(`
            SELECT stock, reserved_stock AS legacyReserved, stock_version AS stockVersion
            FROM product_variants WHERE id = 'variant_hot'
        `).get()).toEqual({ stock: 8, legacyReserved: 2, stockVersion: 2 });
        expect(sqlite.prepare(`
            SELECT SUM(capacity) AS capacity, SUM(reserved_quantity) AS reserved,
                   MIN(source_stock_version) AS minVersion, MAX(source_stock_version) AS maxVersion
            FROM inventory_reservation_lanes
            WHERE variant_id = 'variant_hot' AND pool = 'regular'
        `).get()).toEqual({ capacity: 6, reserved: 0, minVersion: 2, maxVersion: 2 });
        expect(sqlite.prepare(`
            SELECT type, quantity, stock_delta AS stockDelta,
                   reserved_stock_delta AS legacyReservedDelta
            FROM inventory_movements WHERE order_id = 'order_deduct'
        `).get()).toEqual({
            type: "deducted",
            quantity: 2,
            stockDelta: -2,
            legacyReservedDelta: 0,
        });

        sqlite.exec(`UPDATE orders SET status = 'cancelled' WHERE id = 'order_deduct'`);
        await expect(applyInventoryForStatusChange(db, "order_deduct", "cancelled"))
            .resolves.toBe("restored");
        await expect(applyInventoryForStatusChange(db, "order_deduct", "cancelled"))
            .resolves.toBe("restored");

        expect(sqlite.prepare(`
            SELECT stock, reserved_stock AS legacyReserved, stock_version AS stockVersion
            FROM product_variants WHERE id = 'variant_hot'
        `).get()).toEqual({ stock: 10, legacyReserved: 2, stockVersion: 3 });
        expect(sqlite.prepare(`
            SELECT type, quantity, stock_delta AS stockDelta
            FROM inventory_movements WHERE order_id = 'order_deduct'
            ORDER BY stock_version_after
        `).all()).toEqual([
            { type: "deducted", quantity: 2, stockDelta: -2 },
            { type: "restored", quantity: 2, stockDelta: 2 },
        ]);
    });

    it("repairs a restored active aggregate with a bounded legacy reservation", async () => {
        commitCheckout(sqlite, "order_repair");
        sqlite.exec(`UPDATE orders SET status = 'cancelled' WHERE id = 'order_repair'`);
        await applyInventoryForStatusChange(db, "order_repair", "cancelled");

        sqlite.exec(`UPDATE orders SET status = 'pending' WHERE id = 'order_repair'`);
        await expect(applyInventoryForStatusChange(db, "order_repair", "pending"))
            .resolves.toBe("reserved");

        expect(sqlite.prepare(`
            SELECT inventory_action AS action, inventory_authority AS authority
            FROM orders WHERE id = 'order_repair'
        `).get()).toEqual({ action: "reserved", authority: "legacy_counter" });
        expect(sqlite.prepare(`
            SELECT stock, reserved_stock AS legacyReserved, stock_version AS stockVersion
            FROM product_variants WHERE id = 'variant_hot'
        `).get()).toEqual({ stock: 10, legacyReserved: 4, stockVersion: 2 });

        sqlite.exec(`UPDATE product_variants SET low_stock_threshold = 6 WHERE id = 'variant_hot'`);
        sqlite.exec(`UPDATE orders SET status = 'cancelled' WHERE id = 'order_repair'`);
        await expect(applyInventoryForStatusChangeWithImpact(
            db,
            "order_repair",
            "cancelled",
        )).resolves.toEqual({
            inventoryAction: "restored",
            availabilityTransitionVariantIds: ["variant_hot"],
        });
        expect(sqlite.prepare(`
            SELECT reserved_stock AS legacyReserved FROM product_variants WHERE id = 'variant_hot'
        `).get()).toEqual({ legacyReserved: 2 });
    });
});
