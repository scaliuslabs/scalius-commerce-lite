import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PRODUCT_MUTATIONS_SOURCE = fileURLToPath(
  new URL("./products.ts", import.meta.url),
);

const VARIANT_MUTATION_HOOKS = [
  "useCreateProductVariant",
  "useUpdateProductVariant",
  "useDeleteProductVariant",
  "useBulkCreateProductVariants",
  "useBulkUpdateProductVariants",
  "useBulkDeleteProductVariants",
  "useDuplicateProductVariant",
];

describe("product variant mutation cache boundaries", () => {
  it("invalidates product list, detail, and variant queries after SKU mutations", () => {
    const source = readFileSync(PRODUCT_MUTATIONS_SOURCE, "utf8");

    expect(source).toContain("function invalidateProductVariantMutationQueries(");
    expect(source).toMatch(
      /function invalidateProductVariantMutationQueries\([\s\S]*?queryKeys\.products\.list\(\)[\s\S]*?invalidateProductLookupQueries\(queryClient\)[\s\S]*?invalidateProductStatsQueries\(queryClient\)[\s\S]*?queryKeys\.products\.detail\(productId\)[\s\S]*?queryKeys\.products\.variants\(productId\)[\s\S]*?queryKeys\.products\.variantSortOrder\(productId\)[\s\S]*?queryKeys\.inventory\.list\(\)[\s\S]*?\n}/,
    );

    for (const hookName of VARIANT_MUTATION_HOOKS) {
      expect(source).toMatch(
        new RegExp(
          `export function ${hookName}\\([\\s\\S]*?onSuccess: \\(_data, variables\\) => \\{\\s*invalidateProductVariantMutationQueries\\(queryClient, variables\\.productId\\);`,
        ),
      );
    }
  });
});
