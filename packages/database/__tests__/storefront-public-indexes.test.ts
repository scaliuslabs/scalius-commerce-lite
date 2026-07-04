import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const schemaPath = resolve(repoRoot, "packages/database/src/schema/products.ts");
const migrationPath = resolve(
    repoRoot,
    "packages/database/migrations/0075_storefront_listing_indexes.sql",
);
const metadataCheckPath = resolve(
    repoRoot,
    "packages/database/scripts/check-migration-metadata.mjs",
);
const journalPath = resolve(repoRoot, "packages/database/migrations/meta/_journal.json");

describe("storefront public listing indexes", () => {
    it("keeps Drizzle schema aligned with the D1 listing index migration", () => {
        const schema = readFileSync(schemaPath, "utf8");
        const migration = readFileSync(migrationPath, "utf8");

        expect(schema).toContain(
            'index("products_public_newest_idx").on(table.isActive, table.deletedAt, sql`${table.createdAt} DESC`)',
        );
        expect(schema).toContain('index("products_public_category_newest_idx").on(');
        expect(schema).toContain("table.categoryId,\n            table.isActive,\n            table.deletedAt,\n            sql`${table.createdAt} DESC`");
        expect(schema).toContain('index("product_attribute_values_attr_value_product_idx").on(');
        expect(schema).toContain("table.attributeId,\n            table.value,\n            table.productId");

        expect(migration).toContain(
            "CREATE INDEX IF NOT EXISTS `products_public_newest_idx`\nON `products` (`is_active`, `deleted_at`, `created_at` DESC);",
        );
        expect(migration).toContain(
            "CREATE INDEX IF NOT EXISTS `products_public_category_newest_idx`\nON `products` (`category_id`, `is_active`, `deleted_at`, `created_at` DESC);",
        );
        expect(migration).toContain(
            "CREATE INDEX IF NOT EXISTS `product_attribute_values_attr_value_product_idx`\nON `product_attribute_values` (`attribute_id`, `value`, `product_id`);",
        );
        expect(migration).toContain("PRAGMA optimize;");
    });

    it("keeps the manual migration visible to metadata checks", () => {
        const metadataCheck = readFileSync(metadataCheckPath, "utf8");
        const journal = JSON.parse(readFileSync(journalPath, "utf8"));

        expect(metadataCheck).toContain('"0075"');
        expect(journal.entries).toContainEqual(expect.objectContaining({
            idx: 75,
            tag: "0075_storefront_listing_indexes",
            breakpoints: true,
        }));
    });
});
