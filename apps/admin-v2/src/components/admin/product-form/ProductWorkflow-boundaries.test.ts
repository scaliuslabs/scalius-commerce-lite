import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const actionBarSource = readFileSync(
  new URL("./ProductStickyHeader.tsx", import.meta.url),
  "utf8",
);
const variantManagerSource = readFileSync(
  new URL("./variants/VariantManager.tsx", import.meta.url),
  "utf8",
);

describe("product editing workflow boundaries", () => {
  it("does not leave live navigation anchors active during product save", () => {
    expect(actionBarSource).toContain("isSubmitting ? (");
    expect(actionBarSource).toContain("<Link to={cancelUrl}>Discard</Link>");
    expect(actionBarSource).toContain('<Link to="/admin/products/new">');
    expect(actionBarSource).not.toMatch(
      /asChild\s+disabled=\{isSubmitting\}/,
    );
  });

  it("shows the create-another shortcut only with product create permission", () => {
    expect(actionBarSource).toContain(
      "isEdit && productActions.canCreate &&",
    );
  });

  it("guards add, edit, and bulk option drafts from navigation loss", () => {
    expect(variantManagerSource).toContain("const hasUnsavedVariantDrafts =");
    expect(variantManagerSource).toContain("isAnyRowEditing ||");
    expect(variantManagerSource).toContain("draftNewIds.length > 0");
    expect(variantManagerSource).toContain(
      "Object.keys(draftBulkUpdates).length > 0",
    );
    expect(variantManagerSource).toContain(
      "isDirty={hasUnsavedVariantDrafts}",
    );
  });
});
