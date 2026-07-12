import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const actionBarSource = readFileSync(
  new URL("../FormStickyHeader.tsx", import.meta.url),
  "utf8",
);
const formContainerSource = readFileSync(
  new URL("./FormContainer.tsx", import.meta.url),
  "utf8",
);
const productFormSource = readFileSync(
  new URL("../ProductForm.tsx", import.meta.url),
  "utf8",
);
const collectionFormSource = readFileSync(
  new URL("../collection-form/CollectionFormContainer.tsx", import.meta.url),
  "utf8",
);
const categoryFormSource = readFileSync(
  new URL("../CategoryForm.tsx", import.meta.url),
  "utf8",
);

describe("admin form workflow boundaries", () => {
  it("replaces navigation links with inert buttons while saving", () => {
    expect(actionBarSource).toContain("isSubmitting ? (");
    expect(actionBarSource).not.toMatch(
      /asChild\s+disabled=\{isSubmitting\}/,
    );
  });

  it("allows catalog forms to hide create-another shortcuts by capability", () => {
    expect(actionBarSource).toContain("canCreateNew = true");
    expect(actionBarSource).toContain("isEdit && canCreateNew && newUrl");
    expect(formContainerSource).toContain("canCreateNew={canCreateNew}");
    expect(collectionFormSource).toContain(
      "canCreateNew={collectionActions.canCreate}",
    );
  });

  it("provides a fail-closed save capability without changing existing consumers", () => {
    expect(actionBarSource).toContain("canSave = true");
    expect(actionBarSource).toContain("disabled={isSubmitting || !canSave}");
    expect(actionBarSource).toContain("if (canSave) onSave();");
    expect(formContainerSource).toContain("canSave = true");
    expect(formContainerSource).toContain("if (canSave) onSubmit();");
    expect(formContainerSource).toContain("canSave={canSave}");
    expect(formContainerSource).toContain("saveDisabledReason={saveDisabledReason}");
  });

  it("maps category create and edit forms to their exact save capabilities", () => {
    expect(categoryFormSource).toContain("const canSave = isEdit");
    expect(categoryFormSource).toContain("? categoryActions.canEdit");
    expect(categoryFormSource).toContain(": categoryActions.canCreate;");
    expect(categoryFormSource).toContain("canSave={canSave}");
    expect(categoryFormSource).toContain("You do not have permission to edit categories.");
    expect(categoryFormSource).toContain("You do not have permission to create categories.");
  });

  it("gives shared and catalog forms a visible page heading", () => {
    expect(formContainerSource).toContain("<h1");
    expect(formContainerSource).toContain("Create ${entityLabel}");
    expect(productFormSource).toContain('"Create product"');
    expect(collectionFormSource).toContain('"Create Collection"');
  });

  it("defaults new products and collections to draft", () => {
    expect(productFormSource).toContain("isActive: false");
    expect(collectionFormSource).toContain("isActive: false");
  });
});
