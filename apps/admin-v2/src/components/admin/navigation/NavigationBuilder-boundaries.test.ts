import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("navigation workspace boundaries", () => {
  it("uses one searchable hierarchy with an editor directly under the chosen row", () => {
    const source = readSource("./NavigationBuilder.tsx");
    const mapSource = readSource("./NavigationMap.tsx");

    expect(source).toContain('aria-label="Find menu item"');
    expect(source).toContain('aria-label="Selected menu item"');
    expect(source).toContain("Collapse all");
    expect(source).toContain("Expand all");
    expect(source).toContain("matchingItems");
    expect(source).toContain("<NavigationMap");
    expect(mapSource).toContain('aria-label="Menu items"');
    expect(mapSource).toContain("renderEditor(row)");
    expect(mapSource).toContain("[content-visibility:auto]");
    expect(source).not.toContain("lg:grid-cols-[minmax(270px");
    expect(source).not.toContain("<Table");
  });

  it("adds accessible drag while keeping deterministic keyboard and touch fallbacks available", () => {
    const source = readSource("./NavigationBuilder.tsx");
    const mapSource = readSource("./NavigationMap.tsx");

    expect(source).toContain('from "@dnd-kit/core"');
    expect(source).toContain("PointerSensor");
    expect(source).toContain("KeyboardSensor");
    expect(source).toContain("sortableKeyboardCoordinates");
    expect(source).toContain("navigationScreenReaderInstructions");
    expect(source).toContain("DragOverlay");
    expect(source).toContain("applyNavigationDrag");
    expect(mapSource).toContain("useSortable");
    expect(mapSource).toContain("touch-none");
    expect(mapSource).toContain("h-10 w-10");
    expect(mapSource).toContain("Clear search to arrange menu items");
    expect(source).toContain("<details");
    expect(source).toContain("Placement options");
    expect(source).toContain("Parent, position, and keyboard moves");
    expect(source).toContain("Earlier");
    expect(source).toContain("Later");
    expect(source).toContain("Make child");
    expect(source).toContain("Up a level");
    expect(source).toContain("Add child");
    expect(source).toContain("Remove{descendantCount");
    expect(source).toContain("canIndentNavigationItem");
    expect(source).toContain("MAX_NAV_DEPTH");
    expect(source).toContain("MAX_NAV_ITEMS");
    expect(source).toContain("moveNavigationItemToIndexById");
    expect(source).toContain("moveNavigationItemToParentById");
  });

  it("disables drag during filtered views and keeps the 80-row projection", () => {
    const source = readSource("./NavigationBuilder.tsx");

    expect(source).toContain("dragDisabled={Boolean(normalizedQuery)}");
    expect(source).toContain("Clear search to arrange items");
    expect(source).toContain("filtered rows cannot change the wrong branch");
    expect(source).toContain("items={renderedRowIds}");
  });

  it("keeps one narrow-screen-safe editor without a second mobile implementation", () => {
    const source = readSource("./NavigationBuilder.tsx");

    expect(source).toContain("min-w-0");
    expect(source).toContain("sm:flex-row");
    expect(source).not.toContain("useIsMobile");
    expect(source).not.toContain("scrollIntoView");
    expect(source).not.toContain("MobileNavigationTree");
    expect(source).not.toContain("SortableNavigationEditor");
  });

  it("bounds mounted rows independently from the saved menu limit", () => {
    const source = readSource("./NavigationBuilder.tsx");

    expect(source).toContain("NAVIGATION_RENDER_BATCH_SIZE = 80");
    expect(source).toContain("outlineRows.slice(0, renderLimit)");
    expect(source).toContain("Show next");
  });

  it("offers one full-workspace focus mode without recursively nesting it", () => {
    const source = readSource("./NavigationBuilder.tsx");

    expect(source).toContain("Focus on menu");
    expect(source).toContain("focusedSurface");
    expect(source).toContain("100dvh");
    expect(source).toContain("max-w-[1500px]");
  });

  it("uses the shared safe-link policy and public item sources", () => {
    const builderSource = readSource("./NavigationBuilder.tsx");
    const dialogSource = readSource("./AddNavItemDialog.tsx");

    expect(builderSource).toContain("parseNavigationHref");
    expect(builderSource).toContain("openNavigationPreview");
    expect(builderSource).not.toContain("window.open(");
    expect(dialogSource).toContain("data.items.pages");
    expect(dialogSource).toContain("parseNavigationHref(customUrl)");
    expect(dialogSource).toContain("availableSlots");
    expect(dialogSource).toContain("onCheckedChange={() => toggleCategory(cat)}");
    expect(dialogSource).not.toContain("`/pages/${p.slug}`");
  });

  it("edits one footer column at a time with native column-order controls", () => {
    const source = readSource("../footer-builder/NavigationMenusSection.tsx");

    expect(source).toContain('aria-label="Footer columns"');
    expect(source).toContain('aria-label="Selected footer column"');
    expect(source).toContain("Move ${selectedMenu.title || \"column\"} earlier");
    expect(source).toContain("Move ${selectedMenu.title || \"column\"} later");
    expect(source).toContain("<NavigationBuilder");
    expect(source).not.toContain("@dnd-kit/");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("<Accordion");
  });
});
