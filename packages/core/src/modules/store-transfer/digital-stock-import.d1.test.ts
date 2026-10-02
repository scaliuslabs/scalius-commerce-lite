// Inventory CSV import and digital SKUs (migrated schema): a digital SKU's
// stock is its licence keys, so a row that sets another count is a row-level
// issue in the import report (dry run and write), never a crash of the batch,
// while a row that confirms the current count, and physical rows next to it,
// go through as usual.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { inventoryImportBatchSchema } from "@scalius/shared/store-transfer/inventory";
import { importInventory } from "./inventory-import";
import { DIGITAL_STOCK_IS_KEYS_MESSAGE, DIGITAL_STOCK_IS_KEYS_REASON } from "../products/digital-stock-rules";

let sqlite: DatabaseSync;
let db: Database;

const stock = (sku: string) => (sqlite.prepare("SELECT stock FROM product_variants WHERE sku = ?").get(sku) as { stock: number }).stock;

function seedSku(id: string, sku: string, units: number, kind: "physical" | "digital") {
    sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, is_active) VALUES (?, ?, ?, 90000, 1)")
        .run(`prod_${id}`, `Product ${id}`, `product-${id}`);
    sqlite.prepare(`
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
        VALUES (?, ?, ?, 90000, ?, 0, 1, 1, 1, ?)
    `).run(id, `prod_${id}`, sku, units, kind);
}

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    seedSku("var_app", "APP-1", 3, "digital");
    seedSku("var_book", "BOOK-1", 2, "digital");
    seedSku("var_mug", "MUG-1", 5, "physical");
});

afterEach(() => sqlite.close());

describe("inventory import and digital SKUs", () => {
    it("reports a count on a digital SKU as a row issue and imports the rest", async () => {
        const batch = inventoryImportBatchSchema.parse({
            runId: "run_digital_0001",
            items: [
                { ref: "row-2", sku: "APP-1", onHand: 50 },
                { ref: "row-3", sku: "MUG-1", onHand: 8 },
                // Confirming a digital SKU's current count (an export re-imported) is fine.
                { ref: "row-4", sku: "book-1", onHand: 2 },
            ],
        });

        const preview = await importInventory(db, { ...batch, dryRun: true });
        expect(preview.results.map((result) => [result.ref, result.status])).toEqual([
            ["row-2", "failed"],
            ["row-3", "would_update"],
            ["row-4", "would_skip"],
        ]);
        expect(preview.results[0]!.issues).toEqual([{
            code: DIGITAL_STOCK_IS_KEYS_REASON,
            message: `SKU APP-1: ${DIGITAL_STOCK_IS_KEYS_MESSAGE}`,
            field: "onHand",
        }]);

        const written = await importInventory(db, batch);
        expect(written.results.map((result) => [result.ref, result.status, result.issues.map((issue) => issue.code)])).toEqual([
            ["row-2", "failed", [DIGITAL_STOCK_IS_KEYS_REASON]],
            ["row-3", "updated", []],
            ["row-4", "unchanged", []],
        ]);
        expect([stock("APP-1"), stock("MUG-1")]).toEqual([3, 8]);
        expect(sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE variant_id = 'var_app'").get()).toEqual({ n: 0 });
    });

    it("reports a SKU that turned digital after the preview with the same code", async () => {
        const batch = inventoryImportBatchSchema.parse({ runId: "run_digital_0002", items: [{ ref: "row-2", sku: "MUG-1", onHand: 9 }] });
        const preview = await importInventory(db, { ...batch, dryRun: true });
        expect(preview.results[0]!.status).toBe("would_update");
        sqlite.prepare("UPDATE product_variants SET fulfillment_kind = 'digital' WHERE id = 'var_mug'").run();
        const written = await importInventory(db, { ...batch, items: [{ ...batch.items[0]!, expectedOnHand: 5 }] });
        expect(written.results[0]).toMatchObject({ status: "failed", issues: [{ code: DIGITAL_STOCK_IS_KEYS_REASON }] });
        expect(stock("MUG-1")).toBe(5);
    });
});
