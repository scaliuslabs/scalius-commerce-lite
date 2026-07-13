import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const NAVIGATION_BUILDER_SOURCE = fileURLToPath(
  new URL("./NavigationBuilder.tsx", import.meta.url),
);
const NAVIGATION_TREE_ROWS_SOURCE = fileURLToPath(
  new URL("./NavigationTreeRows.tsx", import.meta.url),
);
const MOBILE_NAVIGATION_TREE_SOURCE = fileURLToPath(
  new URL("./MobileNavigationTree.tsx", import.meta.url),
);
const SORTABLE_NAVIGATION_EDITOR_SOURCE = fileURLToPath(
  new URL("./SortableNavigationEditor.tsx", import.meta.url),
);
const SORTABLE_NAV_ITEM_SOURCE = fileURLToPath(
  new URL("./SortableNavItem.tsx", import.meta.url),
);
const ADD_NAV_ITEM_DIALOG_SOURCE = fileURLToPath(
  new URL("./AddNavItemDialog.tsx", import.meta.url),
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
    expect(treeRowsSource).toContain("depth + 1 < maxDepth");
  });

  it("keeps public menus to three usable levels", () => {
    const typesSource = readFileSync(
      fileURLToPath(new URL("./types.ts", import.meta.url)),
      "utf8",
    );

    expect(typesSource).toContain("MAX_NAV_DEPTH = 3");
    expect(typesSource).not.toContain("MAX_NAV_DEPTH = 10");
  });

  it("uses a native-control mobile tree instead of squeezing the desktop table", () => {
    const builderSource = readFileSync(NAVIGATION_BUILDER_SOURCE, "utf8");
    const mobileSource = readFileSync(MOBILE_NAVIGATION_TREE_SOURCE, "utf8");

    expect(builderSource).toContain("useIsMobile");
    expect(builderSource).toContain("renderMobileNavigation");
    expect(builderSource).toContain("<MobileNavigationTree");
    expect(mobileSource).not.toContain("<Table");
    expect(mobileSource).toContain('aria-expanded={expanded}');
    expect(mobileSource).toContain('role="group"');
    expect(mobileSource).toContain("Move ${label} earlier");
    expect(mobileSource).toContain("Move ${label} up one level");
  });

  it("keeps every editor on the shared depth and safe-preview boundaries", () => {
    const builderSource = readFileSync(NAVIGATION_BUILDER_SOURCE, "utf8");
    const treeRowsSource = readFileSync(NAVIGATION_TREE_ROWS_SOURCE, "utf8");
    const mobileSource = readFileSync(MOBILE_NAVIGATION_TREE_SOURCE, "utf8");
    const sortableSource = readFileSync(SORTABLE_NAV_ITEM_SOURCE, "utf8");

    expect(builderSource).toContain("canIndentNavigationItem(item, depth)");
    for (const source of [treeRowsSource, mobileSource, sortableSource]) {
      expect(source).toContain("canIndentNavigationItem(item, depth, maxDepth)");
      expect(source).toContain("openNavigationPreview");
      expect(source).not.toContain("window.open(");
    }
    expect(sortableSource).toContain("depth + 1 < maxDepth");
    expect(sortableSource).not.toContain("depth < maxDepth;");
  });

  it("uses public page sources and the shared safe-link policy", () => {
    const dialogSource = readFileSync(ADD_NAV_ITEM_DIALOG_SOURCE, "utf8");

    expect(dialogSource).toContain("data.items.pages");
    expect(dialogSource).toContain("parseNavigationHref(customUrl)");
    expect(dialogSource).not.toContain("`/pages/${p.slug}`");
    expect(dialogSource).not.toContain('from "~/lib/api-functions/pages"');
  });
});
