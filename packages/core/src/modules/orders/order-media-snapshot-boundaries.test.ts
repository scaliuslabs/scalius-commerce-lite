import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

describe("order image snapshot boundaries", () => {
  it("resolves an image asset during authoritative cart validation and commits its identity", () => {
    const validation = read("./cart-validation.ts");
    const storefront = read("./orders.storefront.ts");
    const ingest = read("./orders.ingest.ts");

    expect(validation).toContain("resolveSkuImageRepresentation");
    expect(validation).toContain("productImageMediaId: image?.mediaId ?? null");
    expect(storefront).toContain("productImageMediaId: validatedItem.productImageMediaId");
    expect(ingest).toContain("productImageMediaId: item.productImageMediaId");
  });

  it("reads historical order images without consulting current product composition", () => {
    const admin = read("./orders.admin.ts");
    const customers = read("../customers/customers.service.ts");

    expect(admin).not.toContain("productImages");
    expect(customers).not.toContain("productImages");
    expect(admin).toContain("eq(media.id, orderItems.productImageMediaId)");
    expect(customers).toContain("eq(media.id, orderItems.productImageMediaId)");
    expect(admin).toContain("productName: orderItems.productName");
    expect(customers).toContain("productName: orderItems.productName");
  });
});
