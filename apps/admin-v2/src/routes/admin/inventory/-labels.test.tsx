import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MAX_LABEL_SKUS } from "~/components/admin/barcode-labels/barcode-label-model";
import { validateBarcodeLabelSearch } from "~/components/admin/barcode-labels/barcode-label-search";

const inventorySource = readFileSync(
  new URL("../../../components/admin/InventoryManager.tsx", import.meta.url),
  "utf8",
);
const optionMatrixSource = readFileSync(
  new URL("../../../components/admin/product-form/variants/OptionMatrixEditor.tsx", import.meta.url),
  "utf8",
);

describe("barcode label workspace entry points", () => {
  it("keeps exact saved SKU selection reload-safe, deduplicated, and bounded", () => {
    const ids = Array.from({ length: MAX_LABEL_SKUS + 2 }, (_, index) => `var_${index}`);
    const validated = validateBarcodeLabelSearch({
      variants: [ids[0], "invalid", ids[0], ...ids.slice(1)].join(","),
    });

    const selectedIds = validated.variants?.split(",") ?? [];
    expect(selectedIds).toHaveLength(MAX_LABEL_SKUS);
    expect(selectedIds[0]).toBe("var_0");
    expect(new Set(selectedIds).size).toBe(selectedIds.length);
    expect(selectedIds).not.toContain("invalid");
  });

  it("routes one-SKU and batch actions into the same reviewed workspace", () => {
    expect(inventorySource).toContain('to="/admin/inventory/labels"');
    expect(inventorySource).toContain('search={{ variants: v.id }}');
    expect(inventorySource).toContain('selectedVariantIds.join(",")');
    expect(optionMatrixSource).toContain('to="/admin/inventory/labels"');
    expect(optionMatrixSource).toContain('search={{ variants: variant.id }}');
    expect(optionMatrixSource).toContain('selectedPersistedIds.join(",")');
    expect(inventorySource).not.toContain("window.print");
    expect(optionMatrixSource).not.toContain("window.print");
  });
});
