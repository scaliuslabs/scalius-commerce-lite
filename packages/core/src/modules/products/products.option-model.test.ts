import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { productVariants } from "@scalius/database/schema";
import { variantOptionLabelSql } from "./products.option-model";

describe("variantOptionLabelSql", () => {
  it("keeps the correlated variant id qualified inside option joins", () => {
    const db = drizzle({} as D1Database);
    const query = db
      .select({
        id: productVariants.id,
        optionLabel: variantOptionLabelSql(productVariants.id),
      })
      .from(productVariants)
      .toSQL();

    expect(query.sql).toContain(
      'pvov.variant_id = "product_variants"."id"',
    );
    expect(query.sql).not.toContain("pvov.variant_id = \"id\"");
  });
});
