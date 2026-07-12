import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaSource = readFileSync(
  fileURLToPath(new URL("../src/schema/products.ts", import.meta.url)),
  "utf8",
);
const cutoverMigration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0007_bored_vulcan.sql", import.meta.url),
  ),
  "utf8",
);
const lifecycleMigration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0008_empty_ikaris.sql", import.meta.url),
  ),
  "utf8",
);

describe("normalized product option and SKU media schema boundaries", () => {
  it("uses normalized option identities and a direct stable SKU image foreign key", () => {
    expect(schemaSource).toContain(
      'export const productOptionDefinitions = sqliteTable("product_option_definitions"',
    );
    expect(schemaSource).toContain(
      'export const productOptionValues = sqliteTable("product_option_values"',
    );
    expect(schemaSource).toContain(
      'imageId: text("image_id")',
    );
    expect(schemaSource).toContain(
      'references(() => productImages.id, { onDelete: "set null" })',
    );
    expect(schemaSource).toContain(
      'export const productVariantOptionValues = sqliteTable("product_variant_option_values"',
    );
    expect(schemaSource).toContain(
      "primaryKey({ columns: [table.variantId, table.optionDefinitionId] })",
    );
    expect(schemaSource).toContain(
      'uniqueIndex("product_option_definitions_name_uidx")',
    );
    expect(schemaSource).toContain(
      'uniqueIndex("product_option_values_value_uidx")',
    );
    expect(schemaSource).not.toContain("productVariantImageMappings");
  });

  it("cuts over to normalized options and direct SKU media without retaining mapping tables", () => {
    expect(cutoverMigration).toContain(
      "DROP TABLE `product_variant_image_mappings`",
    );
    expect(cutoverMigration).toContain(
      "CREATE TABLE `product_option_definitions`",
    );
    expect(cutoverMigration).toContain(
      "CREATE TABLE `product_option_values`",
    );
    expect(cutoverMigration).toContain(
      "CREATE TABLE `product_variant_option_values`",
    );
    expect(cutoverMigration).toContain(
      "FOREIGN KEY (`image_id`) REFERENCES `product_images`(`id`) ON UPDATE no action ON DELETE set null",
    );
    expect(cutoverMigration).toContain(
      "NEW.`image_id` IS NOT NULL AND NOT EXISTS",
    );
    expect(cutoverMigration).toContain(
      "ALTER TABLE `products` DROP COLUMN `variant_image_axis`",
    );
    expect(lifecycleMigration).toContain(
      "CREATE UNIQUE INDEX `product_option_definitions_name_uidx`",
    );
    expect(lifecycleMigration).toContain(
      'WHERE "product_option_definitions"."deleted_at" IS NULL',
    );
    expect(lifecycleMigration).toContain(
      'WHERE "product_option_values"."deleted_at" IS NULL',
    );
  });
});
