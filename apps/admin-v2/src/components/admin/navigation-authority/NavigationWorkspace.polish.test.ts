import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(file: string) {
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

const workspace = read("NavigationWorkspace.tsx");
const index = read("NavigationMenusIndex.tsx");
const editor = read("NavigationMenuEditor.tsx");
const tree = read("NavigationMenuTree.tsx");
const locations = read("NavigationLocationsFields.tsx");
const model = read("navigation-authority-model.ts");
const surfaces = [index, editor, tree, locations];

/**
 * Boundaries for the Navigation screens. These guard the decisions that are
 * easy to undo by accident: the shared shell owns the chrome, the copy stays
 * short and truthful about draft versus published, and the controls stay
 * usable on a phone.
 */
describe("navigation workspace polish boundaries", () => {
  it("routes between the menus list and one menu's editor without owning chrome", () => {
    expect(workspace).toContain("NavigationMenusIndex");
    expect(workspace).toContain("NavigationMenuEditor");
    // The dispatcher renders no UI of its own.
    expect(workspace).not.toContain("components/ui/");
    expect(workspace.split("\n").length).toBeLessThan(80);
  });

  it("builds every surface from the shared admin shell", () => {
    for (const source of surfaces) {
      expect(source).toContain('from "~/components/admin/shell"');
    }
    expect(index).toContain("<IndexTable");
    expect(index).toContain("<IndexFilters");
    expect(index).toContain("<EmptyState");
    expect(index).toContain("<PageHeader");
    expect(editor).toContain("<PageHeader");
    expect(editor).toContain("<SettingsSection");
    expect(editor).toContain("<ContextualSaveBar");
    expect(editor).toContain("<SkeletonPage");
    // Ad hoc badges belong to the shell, not to these screens.
    for (const source of surfaces) {
      expect(source).not.toContain("components/ui/badge");
    }
    // Only the editor writes a heading, and only through the shell's
    // inline-title escape hatch — the one place the operator edits the name.
    expect(editor).toContain("renderTitle={");
    expect(editor.match(/<h1/g) ?? []).toHaveLength(1);
    expect(editor).toContain('aria-label="Rename menu"');
    for (const source of [index, tree, locations]) {
      expect(source).not.toContain("<h1");
    }
  });

  it("opens history and trash in the shared editor sheet", () => {
    const history = read("NavigationHistorySheet.tsx");
    const trash = read("NavigationMenuTrashSheet.tsx");

    for (const source of [history, trash]) {
      expect(source).toContain("<EditorSheet");
      // The sheet chrome (header, close button, scrolling body) is the shell's.
      expect(source).not.toContain("components/ui/sheet");
    }
  });

  it("marks trashing a menu as destructive through the menu primitive", () => {
    expect(index).toContain('variant="destructive"');
    expect(index).not.toContain("text-destructive focus:text-destructive");
  });

  it("is honest that draft changes are stored but not live", () => {
    expect(editor).toContain("Draft changes are not published yet");
    expect(editor).toContain("This menu is not published yet");
    expect(editor).toContain("Discard draft");
    // Item edits are already persisted, so a "leave without saving" prompt
    // would be a lie. The bar must not block navigation.
    expect(editor).toContain("blockNavigation={false}");
    expect(editor).toContain("Discard draft changes?");
    // A menu with nothing live has no revision to discard back to, so the bar
    // drops Discard instead of offering a dead button.
    expect(editor).toContain("hideDiscard={!publishState.canDiscardDraft}");
    expect(model).toContain("canDiscardDraft");
  });

  it("keeps the resource readiness diagnostic visible", () => {
    expect(model).toContain("return item.targetId ? label : `${label} unavailable`;");
    expect(tree).toContain("isDestinationUnavailable");
    expect(tree).toContain("TriangleAlert");
  });

  it("states the consequence of destructive and blocking actions", () => {
    expect(editor).toContain("Items and publication history can be restored later.");
    expect(editor).toContain("AlertDialog");
    expect(index).toContain("AlertDialog");
    expect(index).toContain("describeMenuTrashBlock");
    expect(model).toContain("storefront ${");
    expect(read("NavigationMenuTrashSheet.tsx"))
      .toContain("Restored menus stay unpublished and unassigned.");
    expect(read("NavigationCreateMenuDialog.tsx"))
      .toContain("Customers see item labels, not this name.");
  });

  it("drops the resting-state chips for muted hints", () => {
    expect(tree).toContain("· follows source");
    expect(tree).not.toContain(">Follows source<");
    expect(tree).toContain("· hidden");
    expect(editor).toContain("Clear search to arrange items.");
    expect(editor).not.toContain("Build reusable menus, publish safely");
    expect(editor).not.toContain("Drag to an edge or inside another item");
  });

  it("offers an add row at every level of the tree", () => {
    expect(tree).toContain('data-testid="navigation-add-item-row"');
    expect(tree).toContain("Add menu item under ${parentLabel}");
  });

  it("keeps touch targets and keyboard reordering practical", () => {
    expect(tree).toContain("size-11");
    expect(tree).toContain("KeyboardSensor");
    expect(tree).toContain("Move earlier");
    expect(tree).toContain("Move later");
    expect(tree).toContain("Nest under previous");
    expect(tree).toContain("Move up a level");
    expect(index).toContain("size-11 sm:size-9");
    expect(editor).toContain("min-h-11 sm:min-h-9");
    expect(locations).toContain("min-h-11");
  });
});
