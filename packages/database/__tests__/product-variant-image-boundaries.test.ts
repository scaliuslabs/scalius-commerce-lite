import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaSource = readFileSync(
  fileURLToPath(new URL("../src/schema/products.ts", import.meta.url)),
  "utf8",
);
const schemaMigration = readFileSync(
  fileURLToPath(new URL("../migrations/0001_lying_marvex.sql", import.meta.url)),
  "utf8",
);
const backfillMigration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0002_backfill_variant_image_mappings.sql", import.meta.url),
  ),
  "utf8",
);
const cutoverMigration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0006_outgoing_captain_midlands.sql", import.meta.url),
  ),
  "utf8",
);

describe("product variant image schema boundaries", () => {
  it("uses stable image and target foreign keys with one target per image", () => {
    expect(schemaSource).toContain(
      'export const productVariantImageMappings = sqliteTable("product_variant_image_mappings"',
    );
    expect(schemaSource).toContain(
      'references(() => productImages.id, { onDelete: "cascade" })',
    );
    expect(schemaSource).toContain(
      'references(() => productVariants.id, { onDelete: "cascade" })',
    );
    expect(schemaSource).toContain(
      'uniqueIndex("product_variant_image_mappings_image_uidx").on(table.imageId)',
    );
    expect(schemaMigration).toContain(
      "product_variant_image_mappings_target_check",
    );
  });

  it("materializes old positions once and then permanently retires metadata markers", () => {
    expect(backfillMigration).toContain("row_number() OVER");
    expect(backfillMigration).toContain(
      "ranked_images.`position` = ranked_options.`position`",
    );
    expect(backfillMigration).toContain(
      "products_variant_image_axis_insert_guard",
    );
    expect(backfillMigration).toContain(
      "product_variant_image_mapping_insert_guard",
    );
    expect(cutoverMigration).toContain("product_variants_active_option_identity_uidx");
    expect(cutoverMigration).toContain("products_variant_image_marker_insert_guard");
    expect(cutoverMigration).toContain("replace(coalesce(`meta_description`, '')");
  });
});
