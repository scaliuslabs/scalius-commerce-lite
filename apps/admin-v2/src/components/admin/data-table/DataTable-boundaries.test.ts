import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DATA_TABLE_SOURCE = fileURLToPath(
  new URL("./DataTable.tsx", import.meta.url),
);
const COLUMN_HEADER_SOURCE = fileURLToPath(
  new URL("./DataTableColumnHeader.tsx", import.meta.url),
);
const COLUMN_HEADER_MENU_SOURCE = fileURLToPath(
  new URL("./DataTableColumnHeaderMenu.tsx", import.meta.url),
);
const ROW_ACTIONS_SOURCE = fileURLToPath(
  new URL("./DataTableRowActions.tsx", import.meta.url),
);
const ROW_ACTIONS_MENU_SOURCE = fileURLToPath(
  new URL("./DataTableRowActionsMenu.tsx", import.meta.url),
);
const PAGINATION_SOURCE = fileURLToPath(
  new URL("./DataTablePagination.tsx", import.meta.url),
);
const PAGINATION_PAGE_SIZE_MENU_SOURCE = fileURLToPath(
  new URL("./DataTablePaginationPageSizeMenu.tsx", import.meta.url),
);
const COLUMN_FACTORIES_SOURCE = fileURLToPath(
  new URL("./columns/column-factories.tsx", import.meta.url),
);

describe("DataTable boundaries", () => {
  it("renders an explicit retryable error state instead of stale rows", () => {
    const source = readFileSync(DATA_TABLE_SOURCE, "utf8");

    expect(source).toContain("error?: unknown");
    expect(source).toContain("onRetry?: () => void");
    expect(source).toContain("const showError = Boolean(error) && !isLoading");
    expect(source).toContain("Could not load this list");
    expect(source).toContain("Retry");
    expect(source).toContain("!showError &&");
    expect(source).toContain("visible={isFetching && !isLoading && !showError}");
  });

  it("keeps shared sort, row-action, and pagination menus behind lazy interaction boundaries", () => {
    const dataTableSource = readFileSync(DATA_TABLE_SOURCE, "utf8");
    const columnHeaderSource = readFileSync(COLUMN_HEADER_SOURCE, "utf8");
    const columnHeaderMenuSource = readFileSync(
      COLUMN_HEADER_MENU_SOURCE,
      "utf8",
    );
    const rowActionsSource = readFileSync(ROW_ACTIONS_SOURCE, "utf8");
    const rowActionsMenuSource = readFileSync(ROW_ACTIONS_MENU_SOURCE, "utf8");
    const paginationSource = readFileSync(PAGINATION_SOURCE, "utf8");
    const paginationPageSizeMenuSource = readFileSync(
      PAGINATION_PAGE_SIZE_MENU_SOURCE,
      "utf8",
    );
    const columnFactoriesSource = readFileSync(COLUMN_FACTORIES_SOURCE, "utf8");
    const hotPathSources = [
      dataTableSource,
      columnHeaderSource,
      rowActionsSource,
      paginationSource,
      columnFactoriesSource,
    ];

    expect(columnHeaderSource).toContain(
      'import("./DataTableColumnHeaderMenu")',
    );
    expect(columnHeaderSource).toContain("isMenuRequested");
    expect(columnHeaderMenuSource).toContain("@/components/ui/dropdown-menu");
    expect(columnHeaderMenuSource).toContain("DropdownMenuContent");

    expect(rowActionsSource).toContain('import("./DataTableRowActionsMenu")');
    expect(rowActionsSource).toContain("isMenuRequested");
    expect(rowActionsMenuSource).toContain("@/components/ui/dropdown-menu");
    expect(rowActionsMenuSource).toContain("DropdownMenuContent");

    expect(paginationSource).toContain(
      'import("./DataTablePaginationPageSizeMenu")',
    );
    expect(paginationSource).toContain("isPageSizeMenuRequested");
    expect(paginationPageSizeMenuSource).toContain(
      "@/components/ui/dropdown-menu",
    );
    expect(paginationPageSizeMenuSource).toContain("DropdownMenuContent");

    for (const source of hotPathSources) {
      expect(source).not.toContain("@/components/ui/dropdown-menu");
      expect(source).not.toContain("DropdownMenuContent");
    }
  });
});
