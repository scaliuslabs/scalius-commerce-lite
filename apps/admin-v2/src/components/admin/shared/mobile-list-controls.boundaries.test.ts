import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const toolbarSource = readFileSync(
  resolve(import.meta.dirname, "../data-table/DataTableToolbar.tsx"),
  "utf8",
);
const paginationSource = readFileSync(
  resolve(import.meta.dirname, "AdminListPagination.tsx"),
  "utf8",
);
const dataTablePaginationSource = readFileSync(
  resolve(import.meta.dirname, "../data-table/DataTablePagination.tsx"),
  "utf8",
);
const rowActionsSource = readFileSync(
  resolve(import.meta.dirname, "../data-table/DataTableRowActions.tsx"),
  "utf8",
);
const dropdownMenuSource = readFileSync(
  resolve(import.meta.dirname, "../../ui/dropdown-menu.tsx"),
  "utf8",
);
const productListSource = readFileSync(
  resolve(import.meta.dirname, "../../../routes/admin/products/index.tsx"),
  "utf8",
);
const darkModeToggleSource = readFileSync(
  resolve(import.meta.dirname, "../../ui/DarkModeToggle.tsx"),
  "utf8",
);

describe("shared mobile list controls", () => {
  it("uses touch-sized search controls while preserving desktop density", () => {
    expect(toolbarSource).toContain('className="h-11 pl-8 pr-11 sm:h-9 sm:pr-9"');
    expect(toolbarSource).toContain('aria-label="Clear search"');
    expect(toolbarSource).toContain("h-11 w-11");
    expect(toolbarSource).toContain("sm:h-9 sm:w-9");
  });

  it("uses touch-sized pagination controls without forcing mobile overflow", () => {
    for (const source of [paginationSource, dataTablePaginationSource]) {
      expect(source).toContain("h-11 px-3");
      expect(source).toContain("h-11 w-11");
      expect(source).toContain("sm:h-8");
      expect(source).toContain('className="flex flex-wrap items-center gap-1.5"');
    }
  });

  it("uses touch-sized row actions and menu items before desktop density resumes", () => {
    expect(rowActionsSource).toContain("h-11 w-11 p-0 sm:h-8 sm:w-8");
    expect(dropdownMenuSource).toContain("min-h-11");
    expect(dropdownMenuSource).toContain("sm:min-h-0");
  });

  it("keeps product list and global theme actions touch-sized on phones", () => {
    expect(productListSource.match(/h-11 text-xs/g)).toHaveLength(3);
    expect(productListSource.match(/sm:h-7/g)).toHaveLength(3);
    expect(darkModeToggleSource).toContain("h-11 w-11 shrink-0");
    expect(darkModeToggleSource).toContain("sm:h-9 sm:w-9");
    expect(darkModeToggleSource).toContain('role="switch"');
    expect(darkModeToggleSource).toContain("aria-checked={isDark}");
  });
});
