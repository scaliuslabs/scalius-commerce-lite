import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("navigation workspace boundaries", () => {
  it("uses one searchable hierarchy and selected-item inspector instead of simultaneous row inputs", () => {
    const source = readSource("./NavigationBuilder.tsx");
    const mapSource = readSource("./NavigationMap.tsx");

    expect(source).toContain('aria-label="Find menu item"');
    expect(source).toContain('aria-label="Selected menu item"');
    expect(source).toContain("Collapse all");
    expect(source).toContain("Expand all");
    expect(source).toContain("matchingItems");
    expect(source).toContain("<NavigationMap");
    expect(mapSource).toContain('aria-label={depth === 0 ? "Menu map"');
    expect(mapSource).toContain("[content-visibility:auto]");
    expect(source).not.toContain("<Table");
    expect(source).not.toContain("@dnd-kit/");
  });

  it("keeps deterministic keyboard and touch arrangement controls in the inspector", () => {
    const source = readSource("./NavigationBuilder.tsx");

    expect(source).toContain("Position and nesting");
    expect(source).toContain("Earlier");
    expect(source).toContain("Later");
    expect(source).toContain("Make child");
    expect(source).toContain("Up a level");
    expect(source).toContain("canIndentNavigationItem");
    expect(source).toContain("MAX_NAV_DEPTH");
    expect(source).toContain("MAX_NAV_ITEMS");
  });

  it("keeps editing responsive without maintaining a second mobile implementation", () => {
    const source = readSource("./NavigationBuilder.tsx");

    expect(source).toContain("useIsMobile");
    expect(source).toContain("scrollIntoView");
    expect(source).toContain("lg:grid-cols-");
    expect(source).not.toContain("MobileNavigationTree");
    expect(source).not.toContain("SortableNavigationEditor");
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
