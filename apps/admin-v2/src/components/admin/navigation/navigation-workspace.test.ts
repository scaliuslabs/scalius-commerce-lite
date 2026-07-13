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
  indentNavigationItemById,
  moveNavigationItemById,
  moveNavigationItemToIndexById,
  moveNavigationItemToParentById,
  navigationItemMatchesQuery,
  outdentNavigationItemById,
  removeNavigationItemById,
  updateNavigationItemById,
} from "./navigation-workspace";

const menu: NavigationItem[] = [
  {
    id: "shop",
    title: "Shop",
    subMenu: [
      { id: "new", title: "New arrivals", href: "/new" },
      {
        id: "clothing",
        title: "Clothing",
        subMenu: [{ id: "shirts", title: "Shirts", href: "/shirts" }],
      },
    ],
  },
  { id: "about", title: "About", href: "/about" },
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
    expect(findNavigationLocation(menu, "shirts")?.ancestors.map((item) => item.id)).toEqual([
      "shop",
      "clothing",
    ]);
  });

  it("keeps matching ancestors visible while searching labels and destinations", () => {
    expect(navigationItemMatchesQuery(menu[0], "shirts")).toBe(true);
    expect(navigationItemMatchesQuery(menu[0], "/shirts")).toBe(true);
    expect(navigationItemMatchesQuery(menu[1], "shirts")).toBe(false);
  });

  it("flattens only expanded branches and keeps search ancestors as context", () => {
    expect(flattenNavigationOutline(menu, new Set()).map((row) => row.item.id)).toEqual([
      "shop",
      "about",
    ]);
    expect(
      flattenNavigationOutline(menu, new Set(["shop"])).map((row) => row.item.id),
    ).toEqual(["shop", "new", "clothing", "about"]);

    const searchRows = flattenNavigationOutline(menu, new Set(), "shirts");
    expect(searchRows.map((row) => row.item.id)).toEqual(["shop", "clothing", "shirts"]);
    expect(searchRows.map((row) => row.matchesQuery)).toEqual([false, false, true]);
  });

  it("updates, appends, and removes by stable identity rather than filtered row index", () => {
    const updated = updateNavigationItemById(menu, "new", { title: "Latest" });
    expect(findNavigationLocation(updated, "new")?.item.title).toBe("Latest");
    expect(findNavigationLocation(menu, "new")?.item.title).toBe("New arrivals");

    const appended = appendNavigationItems(menu, "clothing", [
      { id: "trousers", title: "Trousers", href: "/trousers" },
    ]);
    expect(findNavigationLocation(appended, "trousers")?.depth).toBe(2);

    const removed = removeNavigationItemById(appended, "clothing");
    expect(findNavigationLocation(removed, "clothing")).toBeNull();
    expect(findNavigationLocation(removed, "trousers")).toBeNull();
  });

  it("moves siblings and supports deterministic indent and outdent", () => {
    const moved = moveNavigationItemById(menu, "about", -1);
    expect(moved.map((item) => item.id)).toEqual(["about", "shop"]);

    const indented = indentNavigationItemById(menu, "about");
    expect(indented.map((item) => item.id)).toEqual(["shop"]);
    expect(findNavigationLocation(indented, "about")?.parentId).toBe("shop");

    const outdented = outdentNavigationItemById(menu, "new");
    expect(outdented.map((item) => item.id)).toEqual(["shop", "new", "about"]);
    expect(findNavigationLocation(outdented, "new")?.depth).toBe(0);
  });

  it("jumps directly to a sibling position or valid parent", () => {
    const movedToStart = moveNavigationItemToIndexById(menu, "about", 0);
    expect(movedToStart.map((item) => item.id)).toEqual(["about", "shop"]);

    const movedToParent = moveNavigationItemToParentById(menu, "about", "clothing");
    expect(findNavigationLocation(movedToParent, "about")).toMatchObject({
      parentId: "clothing",
      depth: 2,
    });

    expect(moveNavigationItemToParentById(menu, "shop", "shirts")).toBe(menu);
  });

  it("refuses an indent that would push descendants beyond three public levels", () => {
    const unchanged = indentNavigationItemById(menu[0].subMenu ?? [], "clothing", 2, 0);
    expect(unchanged).toEqual(menu[0].subMenu);
  });

  it("projects explicit before/after insertions without changing stable IDs or descendants", () => {
    const result = applyNavigationDrag(
      menu,
      expandedMenuRows,
      "about",
      "shop",
      0,
      "before",
    );

    expect(result.changed).toBe(true);
    expect(result.intent).toMatchObject({
      type: "move",
      edge: "before",
      depth: 0,
      parentId: null,
      targetIndex: 0,
    });
    expect(result.items.map((item) => item.id)).toEqual(["about", "shop"]);
    expect(findNavigationLocation(result.items, "shirts")?.ancestors.map((item) => item.id))
      .toEqual(["shop", "clothing"]);
    expect(countNavigationItems(result.items)).toBe(countNavigationItems(menu));
  });

  it("uses projected depth lanes to nest and outdent complete branches atomically", () => {
    const nested = applyNavigationDrag(
      menu,
      expandedMenuRows,
      "about",
      "shop",
      24,
      "after",
    );

    expect(nested.changed).toBe(true);
    expect(nested.intent).toMatchObject({ type: "move", depth: 1, parentId: "shop" });
    expect(findNavigationLocation(nested.items, "about")).toMatchObject({
      parentId: "shop",
      depth: 1,
    });

    const outdented = applyNavigationDrag(
      menu,
      expandedMenuRows,
      "clothing",
      "about",
      -24,
      "before",
    );
    expect(outdented.changed).toBe(true);
    expect(outdented.intent).toMatchObject({ type: "move", depth: 0, parentId: null });
    expect(findNavigationLocation(outdented.items, "clothing")?.depth).toBe(0);
    expect(findNavigationLocation(outdented.items, "shirts")?.depth).toBe(1);
  });

  it("supports cross-parent vertical insertion and safely expands collapsed targets", () => {
    const crossParent = applyNavigationDrag(
      menu,
      expandedMenuRows,
      "new",
      "about",
      -24,
      "after",
    );
    expect(crossParent.changed).toBe(true);
    expect(crossParent.intent).toMatchObject({
      type: "move",
      depth: 0,
      parentId: null,
      targetIndex: 2,
    });
    expect(crossParent.items.map((item) => item.id)).toEqual(["shop", "about", "new"]);

    const collapsedRows = flattenNavigationOutline(menu, new Set());
    const intoCollapsed = applyNavigationDrag(
      menu,
      collapsedRows,
      "about",
      "shop",
      24,
      "after",
    );
    expect(intoCollapsed.intent).toMatchObject({
      type: "move",
      depth: 1,
      parentId: "shop",
      targetIndex: 0,
    });
    expect(findNavigationLocation(intoCollapsed.items, "about")?.parentId).toBe("shop");
    expect(findNavigationLocation(intoCollapsed.items, "about")?.index).toBe(0);
  });

  it("rejects cycles and projections where a complete branch cannot fit", () => {
    const cycle = getNavigationDragIntent(
      menu,
      expandedMenuRows,
      "shop",
      "shirts",
      48,
      "after",
    );
    expect(cycle).toMatchObject({
      type: "invalid",
      message: "A menu item cannot be placed inside its own branch.",
    });

    const depthLimitedMenu: NavigationItem[] = [
      {
        id: "services",
        title: "Services",
        subMenu: [
          {
            id: "design",
            title: "Design",
            subMenu: [{ id: "logos", title: "Logos" }],
          },
        ],
      },
      {
        id: "catalog",
        title: "Catalog",
        subMenu: [{ id: "catalog-child", title: "Catalog child" }],
      },
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
      48,
      "before",
    );
    expect(tooDeep.changed).toBe(false);
    expect(tooDeep.intent.type).toBe("invalid");
    if (tooDeep.intent.type === "invalid") {
      expect(tooDeep.intent.message).toContain("cannot fit");
    }
  });
});
