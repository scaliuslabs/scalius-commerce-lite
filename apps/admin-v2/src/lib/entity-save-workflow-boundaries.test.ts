import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const adminSource = (...parts: string[]) =>
  readFileSync(resolve(import.meta.dirname, "..", ...parts), "utf8");

describe("merchant create and edit save workflows", () => {
  it.each([
    [
      "category",
      adminSource("components", "admin", "CategoryForm.tsx"),
      "/admin/categories/$categoryId/edit",
    ],
    [
      "page",
      adminSource("components", "admin", "PageForm.tsx"),
      "/admin/pages/$pageId/edit",
    ],
  ])(
    "keeps %s edits in place and opens new resources in their editor",
    (_name, source, editRoute) => {
      expect(source).toContain("onSuccess: (result) => {");
      expect(source).toContain("form.reset({");
      expect(source).toContain("if (!isEdit && mutation.id)");
      expect(source).toContain(`to: "${editRoute}"`);
    },
  );

  it("keeps article saves in the article editor instead of returning to the list", () => {
    const source = adminSource("components", "admin", "PageForm.tsx");
    expect(source).toContain('to: "/admin/articles/$articleId/edit"');
    expect(source).toMatch(
      /navigateTo:\s+contentType === "article" \? "\/admin\/articles" : "\/admin\/pages"/,
    );
  });

  it("keeps collection edits in place and advances the local version", () => {
    const source = adminSource(
      "components",
      "admin",
      "collection-form",
      "CollectionFormContainer.tsx",
    );

    expect(source).toContain(
      "const expectedVersion = values.version || defaultValues?.version",
    );
    expect(source).toContain("version: result.version");
    expect(source).toContain(
      'toast.success(isEdit ? "Collection saved" : "Collection created")',
    );
    expect(source).not.toContain('navigate({ to: "/admin/collections" })');
    expect(source).toContain('to: "/admin/collections/$collectionId/edit"');
  });
});
