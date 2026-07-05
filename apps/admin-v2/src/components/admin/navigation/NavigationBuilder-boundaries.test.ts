import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NAVIGATION_BUILDER_SOURCE = fileURLToPath(
  new URL("./NavigationBuilder.tsx", import.meta.url),
);
const NAVIGATION_TREE_ROWS_SOURCE = fileURLToPath(
  new URL("./NavigationTreeRows.tsx", import.meta.url),
);
const SORTABLE_NAVIGATION_EDITOR_SOURCE = fileURLToPath(
  new URL("./SortableNavigationEditor.tsx", import.meta.url),
);
const SORTABLE_NAV_ITEM_SOURCE = fileURLToPath(
  new URL("./SortableNavItem.tsx", import.meta.url),
);

describe("NavigationBuilder bundle boundaries", () => {
  it("keeps dnd-kit behind the reorder-mode lazy boundary", () => {
    const builderSource = readFileSync(NAVIGATION_BUILDER_SOURCE, "utf8");
    const treeRowsSource = readFileSync(NAVIGATION_TREE_ROWS_SOURCE, "utf8");
    const sortableEditorSource = readFileSync(
      SORTABLE_NAVIGATION_EDITOR_SOURCE,
      "utf8",
    );
    const sortableNavItemSource = readFileSync(SORTABLE_NAV_ITEM_SOURCE, "utf8");

    expect(builderSource).toContain('import("./SortableNavigationEditor")');
    expect(builderSource).toContain("isReorderMode");
    expect(builderSource).not.toContain("@dnd-kit/");
    expect(builderSource).not.toContain("./SortableNavItem");

    expect(treeRowsSource).not.toContain("@dnd-kit/");
    expect(treeRowsSource).not.toContain("useSortable");

    expect(sortableEditorSource).toContain("@dnd-kit/core");
    expect(sortableEditorSource).toContain("@dnd-kit/sortable");
    expect(sortableEditorSource).toContain("./SortableNavItem");
    expect(sortableNavItemSource).toContain("useSortable");
  });

  it("keeps plain child rows editable without entering reorder mode", () => {
    const treeRowsSource = readFileSync(NAVIGATION_TREE_ROWS_SOURCE, "utf8");

    expect(treeRowsSource).toContain("onOutdent(parentPath, index)");
    expect(treeRowsSource).toContain("canOutdent");
  });
});
