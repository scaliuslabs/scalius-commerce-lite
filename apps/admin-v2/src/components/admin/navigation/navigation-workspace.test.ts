import { describe, expect, it } from "vitest";
import type { NavigationItem } from "./types";
import {
  appendNavigationItems,
  collectNavigationParentIds,
  countNavigationItems,
  findNavigationLocation,
  getNavigationDepth,
  indentNavigationItemById,
  moveNavigationItemById,
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

  it("refuses an indent that would push descendants beyond three public levels", () => {
    const unchanged = indentNavigationItemById(menu[0].subMenu ?? [], "clothing", 2, 0);
    expect(unchanged).toEqual(menu[0].subMenu);
  });
});
