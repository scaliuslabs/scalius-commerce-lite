import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { ConflictError } from "@scalius/core/errors";
import { saveProductOptionMatrix } from "./products.option-matrix";

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
        INSERT INTO products (id, name, price, slug) VALUES ('prod_1', 'Tee', 10, 'tee');
        INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping)
        VALUES ('popt_size', 'prod_1', 'Size', 'size', 0, 'size');
        INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES
            ('pval_s', 'popt_size', 'S', 's', 0),
            ('pval_m', 'popt_size', 'M', 'm', 1);
        INSERT INTO product_variants (id, product_id, option_combination_key, sku, price, stock, reserved_stock, is_default, track_inventory) VALUES
            ('var_s', 'prod_1', 'pval_s', 'TEE-S', 10, 4, 0, 0, 1),
            ('var_m', 'prod_1', 'pval_m', 'TEE-M', 10, 2, 0, 0, 1);
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
