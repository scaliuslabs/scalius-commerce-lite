import { describe, expect, it } from "vitest";
import type { NavigationItem } from "./types";
import {
  applyNavigationDrag,
  appendNavigationItems,
  collectNavigationParentIds,
  countNavigationItems,
  findNavigationLocation,
  flattenNavigationOutline,
  getNavigationDepth,
  getNavigationDragIntent,
  getNavigationDropOperationAtPoint,
  indentNavigationItemById,
  moveNavigationItemById,
  moveNavigationItemToIndexById,
  moveNavigationItemToParentAtIndexById,
  moveNavigationItemToParentById,
  navigationItemMatchesQuery,
  outdentNavigationItemById,
  removeNavigationItemById,
  updateNavigationItemById,
} from "./navigation-workspace";

function item(
  id: string,
  label: string,
  path?: string,
  subMenu?: NavigationItem[],
): NavigationItem {
  return {
    id,
    target: path ? { type: "internal_path", path } : { type: "label" },
    labelMode: "custom",
    customLabel: label,
    ...(subMenu?.length ? { subMenu } : {}),
  };
}

const menu: NavigationItem[] = [
  item("shop", "Shop", undefined, [
    item("new", "New arrivals", "/new"),
    item("clothing", "Clothing", undefined, [
      item("shirts", "Shirts", "/shirts"),
    ]),
  ]),
  item("about", "About", "/about"),
];

const expandedMenuRows = flattenNavigationOutline(
  menu,
  collectNavigationParentIds(menu),
);

describe("navigation workspace model", () => {
  it("summarizes and locates a bounded hierarchy", () => {
    expect(countNavigationItems(menu)).toBe(5);
    expect(getNavigationDepth(menu)).toBe(3);
    expect([...collectNavigationParentIds(menu)]).toEqual(["shop", "clothing"]);
    expect(findNavigationLocation(menu, "shirts")).toMatchObject({
      index: 0,
      depth: 2,
      siblingCount: 1,
      parentId: "clothing",
    });
    expect(findNavigationLocation(menu, "shirts")?.ancestors.map((entry) => entry.id))
      .toEqual(["shop", "clothing"]);
  });

  it("keeps matching ancestors visible while searching labels and destinations", () => {
    expect(navigationItemMatchesQuery(menu[0], "shirts")).toBe(true);
    expect(navigationItemMatchesQuery(menu[0], "/shirts")).toBe(true);
    expect(navigationItemMatchesQuery(menu[1], "shirts")).toBe(false);
  });

  it("flattens only expanded branches and keeps search ancestors as context", () => {
    expect(flattenNavigationOutline(menu, new Set()).map((row) => row.item.id))
      .toEqual(["shop", "about"]);
    expect(flattenNavigationOutline(menu, new Set(["shop"])).map((row) => row.item.id))
      .toEqual(["shop", "new", "clothing", "about"]);

    const searchRows = flattenNavigationOutline(menu, new Set(), "shirts");
    expect(searchRows.map((row) => row.item.id)).toEqual(["shop", "clothing", "shirts"]);
    expect(searchRows.map((row) => row.matchesQuery)).toEqual([false, false, true]);
  });

  it("updates, appends, and removes by stable identity", () => {
    const updated = updateNavigationItemById(menu, "new", { customLabel: "Latest" });
    expect(findNavigationLocation(updated, "new")?.item.customLabel).toBe("Latest");
    expect(findNavigationLocation(menu, "new")?.item.customLabel).toBe("New arrivals");

    const appended = appendNavigationItems(menu, "clothing", [
      item("trousers", "Trousers", "/trousers"),
    ]);
    expect(findNavigationLocation(appended, "trousers")?.depth).toBe(2);
    expect(findNavigationLocation(removeNavigationItemById(appended, "clothing"), "trousers"))
      .toBeNull();
  });

  it("supports sibling, indent, outdent, and exact parent-position moves", () => {
    expect(moveNavigationItemById(menu, "about", -1).map((entry) => entry.id))
      .toEqual(["about", "shop"]);
    expect(moveNavigationItemToIndexById(menu, "about", 0).map((entry) => entry.id))
      .toEqual(["about", "shop"]);

    const indented = indentNavigationItemById(menu, "about");
    expect(findNavigationLocation(indented, "about")?.parentId).toBe("shop");
    expect(findNavigationLocation(outdentNavigationItemById(menu, "new"), "new")?.depth)
      .toBe(0);

    const movedToParent = moveNavigationItemToParentById(menu, "about", "clothing");
    expect(findNavigationLocation(movedToParent, "about")).toMatchObject({
      parentId: "clothing",
      depth: 2,
    });
    expect(moveNavigationItemToParentById(menu, "shop", "shirts")).toBe(menu);

    const exact = moveNavigationItemToParentAtIndexById(menu, "new", null, 1);
    expect(exact.map((entry) => entry.id)).toEqual(["shop", "new", "about"]);
    expect(findNavigationLocation(exact, "new")?.depth).toBe(0);
  });

  it("maps generous row hitboxes to before, inside, and after", () => {
    expect(getNavigationDropOperationAtPoint({ pointerY: 105, top: 100, height: 40 }))
      .toBe("before");
    expect(getNavigationDropOperationAtPoint({ pointerY: 120, top: 100, height: 40 }))
      .toBe("inside");
    expect(getNavigationDropOperationAtPoint({ pointerY: 137, top: 100, height: 40 }))
      .toBe("after");
  });

  it("reorders siblings without changing stable IDs or descendants", () => {
    const result = applyNavigationDrag(menu, expandedMenuRows, "about", "shop", "before");
    expect(result.changed).toBe(true);
    expect(result.intent).toMatchObject({
      type: "move",
      operation: "before",
      depth: 0,
      parentId: null,
      targetIndex: 0,
    });
    expect(result.items.map((entry) => entry.id)).toEqual(["about", "shop"]);
    expect(findNavigationLocation(result.items, "shirts")?.ancestors.map((entry) => entry.id))
      .toEqual(["shop", "clothing"]);
    expect(countNavigationItems(result.items)).toBe(countNavigationItems(menu));
  });

  it("makes inside the only nesting operation and outdents against a shallow row", () => {
    const nested = applyNavigationDrag(menu, expandedMenuRows, "about", "shop", "inside");
    expect(nested.intent).toMatchObject({
      type: "move",
      operation: "inside",
      depth: 1,
      parentId: "shop",
    });
    expect(findNavigationLocation(nested.items, "about")?.parentId).toBe("shop");

    const outdented = applyNavigationDrag(
      menu,
      expandedMenuRows,
      "clothing",
      "about",
      "before",
    );
    expect(outdented.intent).toMatchObject({ type: "move", depth: 0, parentId: null });
    expect(findNavigationLocation(outdented.items, "clothing")?.depth).toBe(0);
    expect(findNavigationLocation(outdented.items, "shirts")?.depth).toBe(1);
  });

  it("nests into a collapsed target and rejects cycles and excessive depth", () => {
    const collapsedRows = flattenNavigationOutline(menu, new Set());
    const intoCollapsed = applyNavigationDrag(menu, collapsedRows, "about", "shop", "inside");
    expect(intoCollapsed.intent).toMatchObject({
      type: "move",
      operation: "inside",
      parentId: "shop",
      targetIndex: 2,
    });

    expect(getNavigationDragIntent(menu, expandedMenuRows, "shop", "shirts", "inside"))
      .toMatchObject({
        type: "invalid",
        message: "A menu item cannot be placed inside its own branch.",
      });

    const depthLimitedMenu = [
      item("services", "Services", undefined, [
        item("design", "Design", undefined, [item("logos", "Logos")]),
      ]),
      item("catalog", "Catalog", undefined, [item("catalog-child", "Catalog child")]),
    ];
    const depthLimitedRows = flattenNavigationOutline(
      depthLimitedMenu,
      collectNavigationParentIds(depthLimitedMenu),
    );
    const tooDeep = applyNavigationDrag(
      depthLimitedMenu,
      depthLimitedRows,
      "catalog",
      "logos",
      "inside",
    );
    expect(tooDeep.changed).toBe(false);
    expect(tooDeep.intent.type).toBe("invalid");
    if (tooDeep.intent.type === "invalid") {
      expect(tooDeep.intent.message).toContain("cannot fit");
    }
  });
});
