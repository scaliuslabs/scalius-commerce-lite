import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const adminComponent = (relativePath: string) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("shared form assistant save opt-in", () => {
  it("allows only the Category and Collection catalog containers to opt in", () => {
    const categoryForm = adminComponent("CategoryForm.tsx");
    const collectionForm = adminComponent(
      "collection-form/CollectionFormContainer.tsx",
    );
    const actionBar = adminComponent("FormStickyHeader.tsx");
    const formContainer = readFileSync(
      new URL("./FormContainer.tsx", import.meta.url),
      "utf8",
    );

    expect(actionBar).toContain("allowAssistantSave = false");
    expect(actionBar).toContain(
      'allowAssistantSave ? "allow" : undefined',
    );
    expect(formContainer).toContain("allowAssistantSave={allowAssistantSave}");
    expect(categoryForm).toMatch(
      /<FormContainer[\s\S]*?saveLabel=\{isEdit \? "Save Category" : "Create Category"\}[\s\S]*?allowAssistantSave/,
    );
    expect(collectionForm).toMatch(
      /<FormActionBar[\s\S]*?title="Collections"[\s\S]*?allowAssistantSave/,
    );
  });

  it.each([
    "OrderForm.tsx",
    "CustomerForm.tsx",
    "AnalyticsForm.tsx",
    "PageForm.tsx",
  ])("keeps %s on the default human-only save policy", (relativePath) => {
    expect(adminComponent(relativePath)).not.toContain("allowAssistantSave");
  });
});
