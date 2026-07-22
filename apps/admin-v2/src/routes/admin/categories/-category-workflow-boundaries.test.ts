import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const listSource = readFileSync(
  fileURLToPath(new URL("./index.tsx", import.meta.url)),
  "utf8",
);
const columnsSource = readFileSync(
  fileURLToPath(
    new URL("../../../components/admin/data-table/columns/category-columns.tsx", import.meta.url),
  ),
  "utf8",
);
const editSource = readFileSync(
  fileURLToPath(new URL("./$categoryId/edit.tsx", import.meta.url)),
  "utf8",
);
const formSource = readFileSync(
  fileURLToPath(
    new URL("../../../components/admin/CategoryForm.tsx", import.meta.url),
  ),
  "utf8",
);
const apiSource = readFileSync(
  fileURLToPath(
    new URL("../../../lib/api-functions/categories.ts", import.meta.url),
  ),
  "utf8",
);

describe("category admin workflow boundaries", () => {
  it("confirms single and bulk destructive operations through one dialog", () => {
    expect(listSource).toContain("setDeleteIntent({");
    expect(listSource).toContain("bulk: true");
    expect(listSource).toContain("itemCount={deleteIntent?.categories.length ?? 1}");
    expect(listSource).toContain("expectedRevision: category.revision");
  });

  it("offers bulk restore and gates trash selection by trash permissions", () => {
    expect(listSource).toContain("useBulkRestoreCategories");
    expect(listSource).toContain("categoryActions.canRestore || categoryActions.canPermanentDelete");
  });

  it("does not expose edit navigation for trashed categories", () => {
    expect(columnsSource).toContain("opts.canEdit && !opts.showTrashed");
    expect(editSource).toContain("if (category.deletedAt != null)");
  });

  it("makes publication explicit and carries revision claims on every write", () => {
    expect(listSource).toContain('["name", "status", "createdAt", "updatedAt"]');
    expect(formSource).toContain('name="status"');
    expect(formSource).toContain('value="published"');
    expect(formSource).toContain("publishReadiness.blockers.map");
    expect(formSource).toContain('form.watch("status") === "published"');
    expect(apiSource).toContain("expectedRevision: number");
    expect(apiSource).toContain("apiDelete(`/categories/${data.id}`, {");
    expect(apiSource).toContain("expectedRevision: data.expectedRevision");
  });

  it("keeps the category editor compact without removing merchandising content", () => {
    expect(formSource).toContain('<Tabs defaultValue="introduction"');
    expect(formSource).toContain('value="below-products"');
    expect(formSource).toContain('name="description"');
    expect(formSource).toContain('name="content"');
    expect(formSource).toContain('title="Search and discovery"');
    expect(formSource).toContain('name="slug"');
    expect(formSource).toContain('title="Image"');
    expect(formSource).not.toContain("New categories start as drafts");
    expect(formSource).not.toContain("Auto-generated from the name");
    expect(formSource).not.toContain("Optimize for search engines");
    expect(formSource).not.toContain("URL & Slug");
  });

  it("keeps category saves in context", () => {
    expect(formSource).toContain("onSuccess: (result) => {");
    expect(formSource).toContain("form.reset({");
    expect(formSource).toContain('to: "/admin/categories/$categoryId/edit"');
    expect(formSource).toContain("if (!isEdit && mutation.id)");
  });
});
