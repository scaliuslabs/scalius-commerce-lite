import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  orderItems,
  productImages,
  products,
  productVariants,
} from "@scalius/database/schema";
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

  it("does not double-qualify the outer id when the projection joins products", () => {
    const db = drizzle({} as D1Database);
    const query = db
      .select({
        id: productVariants.id,
        productName: products.name,
        optionLabel: variantOptionLabelSql(productVariants.id),
      })
      .from(productVariants)
      .leftJoin(products, eq(products.id, productVariants.productId))
      .toSQL();

    expect(query.sql).toContain(
      'pvov.variant_id = "product_variants"."id"',
    );
    expect(query.sql).not.toContain(
      '"product_variants"."product_variants"."id"',
    );
  });

  it("compiles the admin order-detail item projection with an unambiguous correlated variant id", () => {
    const db = drizzle({} as D1Database);
    const query = db
      .select({
        id: orderItems.id,
        productName: products.name,
        productImage: productImages.url,
        variantId: orderItems.variantId,
        variantLabel: variantOptionLabelSql(productVariants.id),
      })
      .from(orderItems)
      .leftJoin(products, eq(products.id, orderItems.productId))
      .leftJoin(productVariants, eq(productVariants.id, orderItems.variantId))
      .leftJoin(
        productImages,
        eq(productImages.productId, orderItems.productId),
      )
      .where(eq(orderItems.orderId, "ord_regression"))
      .toSQL();

    expect(query.sql).toContain(
      'pvov.variant_id = "product_variants"."id"',
    );
    expect(query.sql).not.toContain("pvov.variant_id = \"id\"");
    expect(query.sql).not.toContain(
      '"product_variants"."product_variants"."id"',
    );
  });
});
