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

  it("gives shared and catalog forms a visible page heading", () => {
    expect(formContainerSource).toContain("<h1");
    expect(formContainerSource).toContain("Create ${entityLabel}");
    expect(productFormSource).toContain('"Create Product"');
    expect(collectionFormSource).toContain('"Create Collection"');
  });

  it("defaults new products and collections to draft", () => {
    expect(productFormSource).toContain("isActive: false");
    expect(collectionFormSource).toContain("isActive: false");
  });
});
