import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const productImageSurfaces = [
  "../components/admin/ProductView.tsx",
  "../components/admin/data-table/columns/product-columns.tsx",
  "../components/admin/orderview/OrderItemsCard.tsx",
  "../components/admin/product-form/ProductImagesSection.tsx",
  "../components/admin/product-form/variants/OptionMatrixEditor.tsx",
  "../components/admin/product-list/ProductMobileRow.tsx",
  "../components/admin/scanner/ManualSheet.tsx",
].map((path) => ({
  path,
  source: readFileSync(new URL(path, import.meta.url), "utf8"),
}));

describe("admin catalog image presentation boundaries", () => {
  it.each(productImageSurfaces)(
    "preserves the complete product asset in $path",
    ({ source }) => {
      expect(source).toContain("object-contain");
      expect(source).not.toContain("object-cover");
    },
  );
});
