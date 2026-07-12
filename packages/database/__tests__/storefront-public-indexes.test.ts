import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const schemaPath = resolve(repoRoot, "packages/database/src/schema/products.ts");
const baselinePath = resolve(
    repoRoot,
    "packages/database/migrations/0000_blushing_jack_power.sql",
);
const journalPath = resolve(repoRoot, "packages/database/migrations/meta/_journal.json");

describe("storefront public listing indexes", () => {
    it("keeps Drizzle schema aligned with the D1 baseline indexes", () => {
        const schema = readFileSync(schemaPath, "utf8");
        const baseline = readFileSync(baselinePath, "utf8");

        expect(schema).toContain(
            'index("products_public_newest_idx").on(table.isActive, table.deletedAt, sql`${table.createdAt} DESC`)',
        );
        expect(schema).toContain('index("products_public_category_newest_idx").on(');
        expect(schema).toContain("table.categoryId,\n            table.isActive,\n            table.deletedAt,\n            sql`${table.createdAt} DESC`");
        expect(schema).toContain('index("product_attribute_values_attr_value_product_idx").on(');
        expect(schema).toContain("table.attributeId,\n            table.value,\n            table.productId");

        expect(baseline).toContain(
            "CREATE INDEX `products_public_newest_idx` ON `products` (`is_active`,`deleted_at`,\"created_at\" DESC)",
        );
        expect(baseline).toContain(
            "CREATE INDEX `products_public_category_newest_idx` ON `products` (`category_id`,`is_active`,`deleted_at`,\"created_at\" DESC)",
        );
        expect(baseline).toContain(
            "CREATE INDEX `product_attribute_values_attr_value_product_idx` ON `product_attribute_values` (`attribute_id`,`value`,`product_id`)",
        );
    });

    it("registers the baseline and additive catalog migrations contiguously", () => {
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
            entries: Array<{ idx: number; tag: string; breakpoints: boolean }>;
        };

        expect(journal.entries.map((entry) => entry.idx)).toEqual(
            journal.entries.map((_entry, index) => index),
        );
        expect(journal.entries.every((entry) =>
            entry.tag.startsWith(`${String(entry.idx).padStart(4, "0")}_`)
        )).toBe(true);
        expect(journal.entries.every((entry) => entry.breakpoints)).toBe(true);
    });
});
