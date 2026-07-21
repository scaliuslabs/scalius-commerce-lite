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

describe("shared mobile list controls", () => {
  it("uses touch-sized search controls while preserving desktop density", () => {
    expect(toolbarSource).toContain('className="h-11 pl-8 pr-11 sm:h-9 sm:pr-9"');
    expect(toolbarSource).toContain('aria-label="Clear search"');
    expect(toolbarSource).toContain("h-11 w-11");
    expect(toolbarSource).toContain("sm:h-9 sm:w-9");
  });

  it("uses touch-sized pagination controls without forcing mobile overflow", () => {
    expect(paginationSource).toContain("h-11 px-3");
    expect(paginationSource).toContain("h-11 w-11");
    expect(paginationSource).toContain("sm:h-8");
    expect(paginationSource).toContain('className="flex flex-wrap items-center gap-1.5"');
  });
});
