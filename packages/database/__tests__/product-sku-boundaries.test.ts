import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRODUCTS_SCHEMA_SOURCE = fileURLToPath(
    new URL("../src/schema/products.ts", import.meta.url),
);
const SIMPLE_SKU_REPAIR_MIGRATION = fileURLToPath(
    new URL("../migrations/0057_simple_sku_legacy_repair.sql", import.meta.url),
);
const MIGRATION_METADATA_CHECK = fileURLToPath(
    new URL("../scripts/check-migration-metadata.mjs", import.meta.url),
);

describe("product SKU inventory boundaries", () => {
    it("documents and repairs legacy simple-product SKU invariants", () => {
        const schemaSource = readFileSync(PRODUCTS_SCHEMA_SOURCE, "utf8");
        const migrationSource = readFileSync(SIMPLE_SKU_REPAIR_MIGRATION, "utf8");
        const metadataCheckSource = readFileSync(MIGRATION_METADATA_CHECK, "utf8");

        expect(schemaSource).toContain("product_variants_one_default_per_product_idx");
        expect(migrationSource).toContain("INSERT INTO `product_variants`");
        expect(migrationSource).toContain("NOT EXISTS");
        expect(migrationSource).toContain("`is_default` = true");
        expect(migrationSource).toContain("`track_inventory` = false");
        expect(migrationSource).toContain("`inventory_movements`");
        expect(metadataCheckSource).toContain('"0057"');
    });
});
