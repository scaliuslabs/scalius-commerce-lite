import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRODUCTS_SCHEMA_SOURCE = fileURLToPath(
    new URL("../src/schema/products.ts", import.meta.url),
);
const BASELINE_MIGRATION = fileURLToPath(
    new URL("../migrations/0000_blushing_jack_power.sql", import.meta.url),
);

describe("product SKU inventory boundaries", () => {
    it("keeps sellable SKU and inventory invariants in the clean baseline", () => {
        const schemaSource = readFileSync(PRODUCTS_SCHEMA_SOURCE, "utf8");
        const baselineSource = readFileSync(BASELINE_MIGRATION, "utf8");

        expect(schemaSource).toContain("product_variants_one_default_per_product_idx");
        expect(schemaSource).toContain('isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false)');
        expect(schemaSource).toContain('trackInventory: integer("track_inventory", { mode: "boolean" }).notNull().default(true)');

        expect(baselineSource).toContain("CREATE TABLE `product_variants`");
        expect(baselineSource).toContain("`is_default` integer DEFAULT false NOT NULL");
        expect(baselineSource).toContain("`track_inventory` integer DEFAULT true NOT NULL");
        expect(baselineSource).toContain("CREATE UNIQUE INDEX `product_variants_sku_unique_idx`");
        expect(baselineSource).toContain("CREATE UNIQUE INDEX `product_variants_one_default_per_product_idx`");
        expect(baselineSource).toContain("WHERE `is_default` = true AND `deleted_at` IS NULL");
        expect(baselineSource).toContain("CREATE TABLE `inventory_movements`");
        expect(baselineSource).toContain(
            "FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict",
        );
    });
});
