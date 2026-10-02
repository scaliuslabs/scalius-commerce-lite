import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { ConflictError } from "@scalius/core/errors";
import { saveProductOptionMatrix } from "./option-matrix";
import { executeInventoryOperation } from "../inventory/inventory-operations";

function setup() {
    let pending: ((sqlite: DatabaseSync) => void) | undefined;
    const harness = createSqliteD1Database({
        beforeBatch(sqlite) {
            const apply = pending;
            pending = undefined;
            apply?.(sqlite);
        },
    });
    harness.sqlite.exec(`
        INSERT INTO products (id, name, price_minor, slug) VALUES ('prod_1', 'Tee', 1000, 'tee');
        INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping)
        VALUES ('popt_size', 'prod_1', 'Size', 'size', 0, 'size');
        INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
            ('pval_s', 'popt_size', 'S', 's', 0),
            ('pval_m', 'popt_size', 'M', 'm', 1);
        INSERT INTO product_variants (id, product_id, option_combination_key, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
            ('var_s', 'prod_1', 'pval_s', 'TEE-S', 1000, 4, 0, 0, 1),
            ('var_m', 'prod_1', 'pval_m', 'TEE-M', 1000, 2, 0, 0, 1);
        INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES
            ('var_s', 'popt_size', 'pval_s'),
            ('var_m', 'popt_size', 'pval_m');
    `);
    const variant = (id: string) => harness.sqlite.prepare(
        "SELECT stock, deleted_at IS NOT NULL AS retired FROM product_variants WHERE id = ?",
    ).get(id);
    const raceNextBatch = (race: (sqlite: DatabaseSync) => void) => { pending = race; };
    return { ...harness, variant, raceNextBatch };
}

// Saved rows only send stock when it changes, together with the version the editor loaded.
const row = (id: string, valueId: string, sku: string, stock?: number, expectedStockVersion?: number) => ({
    id, selectedOptionValueIds: [valueId], imageId: null, sku, price: 10, trackInventory: true,
    ...(stock === undefined ? {} : { stock }),
    ...(expectedStockVersion === undefined ? {} : { expectedStockVersion }),
    weight: null, barcode: null, barcodeType: null, discountType: "percentage", discountPercentage: 0, discountAmount: null,
});
const matrix = (revision: number, values: Array<{ id: string; value: string }>, variants: unknown[]) => ({
    expectedAggregateRevision: revision,
    options: [{ id: "popt_size", name: "Size", standardMapping: "size", values }],
    variants,
});
const onlySmall = matrix(1, [{ id: "pval_s", value: "S" }], [row("var_s", "pval_s", "TEE-S")]);
const restoreMedium = matrix(2, [{ id: "pval_s", value: "S" }, { id: "pval_m", value: "M" }], [
    row("var_s", "pval_s", "TEE-S"),
    row("draft_m", "pval_m", "TEE-M", 99),
]);

describe("option matrix SKU retirement and restoration", () => {
    it("soft-retires an omitted combination without clearing its stock history", async () => {
        const { db, variant } = setup();

        await saveProductOptionMatrix(db, "prod_1", onlySmall);

        expect(variant("var_m")).toEqual({ stock: 2, retired: 1 });
    });

    it("restores the retired SKU identity with its own stock instead of the draft quantity", async () => {
        const { db, variant } = setup();
        await saveProductOptionMatrix(db, "prod_1", onlySmall);

        await saveProductOptionMatrix(db, "prod_1", restoreMedium);

        expect(variant("var_m")).toEqual({ stock: 2, retired: 0 });
        expect(variant("draft_m")).toBeUndefined();
    });

    it("revives a removed value typed again, so its retired SKU comes back with its stock", async () => {
        const { db, variant, sqlite } = setup();
        // The editor drops the value M entirely, then the merchant types "m" again as a new value.
        await saveProductOptionMatrix(db, "prod_1", onlySmall);
        await saveProductOptionMatrix(db, "prod_1", matrix(2, [{ id: "pval_s", value: "S" }, { id: "draft_value_m", value: "m" }], [
            row("var_s", "pval_s", "TEE-S"),
            row("draft_m", "draft_value_m", "TEE-M", 0),
        ]));

        expect(variant("var_m")).toEqual({ stock: 2, retired: 0 });
        expect(sqlite.prepare("SELECT id, value FROM product_option_values WHERE deleted_at IS NULL ORDER BY position").all())
            .toEqual([{ id: "pval_s", value: "S" }, { id: "pval_m", value: "m" }]);
    });

    it("fails closed when the retired SKU's stock changes before the restore commits", async () => {
        const { db, variant, raceNextBatch } = setup();
        await saveProductOptionMatrix(db, "prod_1", onlySmall);
        raceNextBatch((sqlite) => {
            sqlite.exec("UPDATE product_variants SET stock = 3, stock_version = stock_version + 1 WHERE id = 'var_m'");
        });

        await expect(saveProductOptionMatrix(db, "prod_1", restoreMedium)).rejects.toBeInstanceOf(ConflictError);
        expect(variant("var_m")).toEqual({ stock: 3, retired: 1 });
    });

    it("reconciles low-stock alerts after a matrix stock transition in either direction", async () => {
        const { sqlite, db } = setup();
        sqlite.exec(`UPDATE product_variants SET low_stock_threshold = 5 WHERE id = 'var_s';
            INSERT INTO product_low_stock_alerts (id, variant_id, product_id, current_qty, threshold)
            VALUES ('alert_s', 'var_s', 'prod_1', 4, 5);`);
        const alert = () => sqlite.prepare("SELECT alert_status, current_qty FROM product_low_stock_alerts").get();

        await saveProductOptionMatrix(db, "prod_1", matrix(1, [{ id: "pval_s", value: "S" }], [row("var_s", "pval_s", "TEE-S", 9, 1)]));
        expect(alert()).toEqual({ alert_status: "resolved", current_qty: 9 });

        await saveProductOptionMatrix(db, "prod_1", matrix(2, [{ id: "pval_s", value: "S" }], [row("var_s", "pval_s", "TEE-S", 3, 2)]));
        expect(alert()).toEqual({ alert_status: "active", current_qty: 3 });
    });
});

describe("simple product conversion with several inventory locations", () => {
    function simpleProduct() {
        const harness = createSqliteD1Database();
        harness.sqlite.exec(`
            INSERT INTO products (id, name, price_minor, slug) VALUES ('prod_simple', 'Mug', 1000, 'mug');
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
            VALUES ('var_default', 'prod_simple', 'MUG', 1000, 5, 0, 1, 1);
            INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position)
            VALUES ('loc_branch', 'Banani store', 'BAN', 'store', 0, 'active', 1);
        `);
        const moveToBranch = async (units: number) => {
            for (const [locationId, delta] of [["loc_default", -units], ["loc_branch", units]] as const) {
                await executeInventoryOperation(harness.db, {
                    operationKey: `invop_${crypto.randomUUID()}`,
                    operationType: "manual_adjustment",
                    variantId: "var_default",
                    pool: "stock",
                    mode: "relative",
                    delta,
                    reason: "correction",
                    locationId,
                });
            }
        };
        const levels = () => harness.sqlite.prepare(`
            SELECT v.sku, l.location_id, l.on_hand FROM inventory_levels AS l
            JOIN product_variants AS v ON v.id = l.variant_id
            WHERE l.on_hand > 0 ORDER BY v.sku, l.location_id
        `).all();
        const revision = () => (harness.sqlite.prepare(
            "SELECT aggregate_revision FROM products WHERE id = 'prod_simple'",
        ).get() as { aggregate_revision: number }).aggregate_revision;
        const convert = () => saveProductOptionMatrix(harness.db, "prod_simple", {
            expectedAggregateRevision: revision(),
            options: [{
                id: "draft_size", name: "Size", standardMapping: "size",
                values: [{ id: "draft_s", value: "S" }, { id: "draft_m", value: "M" }],
            }],
            variants: [row("draft_var_s", "draft_s", "MUG-S", 3), row("draft_var_m", "draft_m", "MUG-M", 2)],
        });
        return { ...harness, moveToBranch, levels, convert };
    }

    it("refuses while another location holds the simple SKU's units, and writes nothing", async () => {
        const { sqlite, moveToBranch, levels, convert } = simpleProduct();
        await moveToBranch(2);
        const before = levels();

        await expect(convert()).rejects.toThrow(
            "Banani store still holds 2 units of this product. Options start with all stock at Main location",
        );
        expect(levels()).toEqual(before);
        expect(sqlite.prepare("SELECT count(*) AS n FROM product_variants WHERE deleted_at IS NULL").get()).toEqual({ n: 1 });
    });

    it("allocates the units at the default location to the new option SKUs once they are all there", async () => {
        const { sqlite, moveToBranch, levels, convert } = simpleProduct();
        await moveToBranch(2);
        await moveToBranch(-2);

        await convert();

        expect(levels()).toEqual([
            { sku: "MUG-M", location_id: "loc_default", on_hand: 2 },
            { sku: "MUG-S", location_id: "loc_default", on_hand: 3 },
        ]);
        expect(sqlite.prepare("SELECT stock, deleted_at IS NOT NULL AS retired FROM product_variants WHERE id = 'var_default'").get())
            .toEqual({ stock: 0, retired: 1 });
    });
});
