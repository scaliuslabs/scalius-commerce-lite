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
});
