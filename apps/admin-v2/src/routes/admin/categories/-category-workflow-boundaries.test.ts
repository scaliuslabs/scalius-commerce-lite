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

describe("category admin workflow boundaries", () => {
  it("confirms single and bulk destructive operations through one dialog", () => {
    expect(listSource).toContain("setDeleteIntent({");
    expect(listSource).toContain("bulk: true");
    expect(listSource).toContain("itemCount={deleteIntent?.ids.length ?? 1}");
  });

  it("offers bulk restore and gates trash selection by trash permissions", () => {
    expect(listSource).toContain("useBulkRestoreCategories");
    expect(listSource).toContain("categoryActions.canRestore || categoryActions.canPermanentDelete");
  });

  it("does not expose edit navigation for trashed categories", () => {
    expect(columnsSource).toContain("opts.canEdit && !opts.showTrashed");
    expect(editSource).toContain("if (category.deletedAt != null)");
  });
});
