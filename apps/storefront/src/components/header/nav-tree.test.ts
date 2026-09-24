import { describe, expect, it } from "vitest";
import type { NavigationItem } from "@/lib/api";
import {
  countNavigationLinks,
  navigationDepth,
  navigationFromCategoryTree,
  navigationLinkShare,
  navigationTree,
  pruneNavigation,
} from "./nav-tree";

/** A Star Tech-scale tree: 18 departments x 12 children x 6 brands. */
function deepTree(): NavigationItem[] {
  return Array.from({ length: 18 }, (_, top) => ({
    id: `d${top}`,
    title: `Department ${top}`,
    href: `/categories/d${top}`,
    subMenu: Array.from({ length: 12 }, (_, child) => ({
      id: `d${top}-${child}`,
      title: `Child ${top}.${child}`,
      href: `/categories/d${top}-${child}`,
      subMenu: Array.from({ length: 6 }, (_, leaf) => ({
        id: `d${top}-${child}-${leaf}`,
        title: `Brand ${leaf}`,
        href: `/categories/d${top}-${child}-${leaf}`,
      })),
    })),
  }));
}

describe("navigation tree", () => {
  it("drops untitled items and normalises children", () => {
    expect(
      navigationTree([
        { title: " Women ", href: "/w", subMenu: [{ title: "" }, { title: "Sarees", href: "/s", subMenu: [] }] },
        { title: "" },
      ] as NavigationItem[]),
    ).toEqual([{ title: "Women", href: "/w", subMenu: [{ title: "Sarees", href: "/s" }] }]);
  });

  it("builds the menu from a nested or flat category tree", () => {
    const nested = navigationFromCategoryTree([
      {
        id: "c1",
        name: "Laptop",
        slug: "laptop",
        imageUrl: "https://cdn.test/laptop.jpg",
        children: [{ id: "c2", name: "Gaming laptop", slug: "gaming-laptop", canonicalPath: "/categories/gaming" }],
      },
    ]);
    expect(nested).toEqual([
      {
        id: "c1",
        title: "Laptop",
        href: "/categories/laptop",
        imageUrl: "https://cdn.test/laptop.jpg",
        subMenu: [{ id: "c2", title: "Gaming laptop", href: "/categories/gaming" }],
      },
    ]);
    const flat = navigationFromCategoryTree([
      { id: "a", name: "A", slug: "a", parentId: null },
      { id: "b", name: "B", slug: "b", parentId: "a" },
      { id: "c", name: "C", slug: "c", parentId: "b" },
      // A cycle and an orphan cannot loop or vanish.
      { id: "x", name: "X", slug: "x", parentId: "x" },
      { id: "o", name: "O", slug: "o", parentId: "missing" },
    ]);
    expect(flat.map((item) => item.title)).toEqual(["A", "X", "O"]);
    expect(navigationDepth(flat)).toBe(3);
  });

  it("counts the anchors a rendering emits", () => {
    const tree = deepTree();
    expect(countNavigationLinks(tree)).toBe(18 + 18 * 12 + 18 * 12 * 6);
    expect(countNavigationLinks(tree, { allLinks: true })).toBe(18 + 18 * 12 + 18 * 12 * 6 + 18 + 18 * 12);
  });

  it("drills large trees in: top levels first, round-robin across departments", () => {
    const share = navigationLinkShare(2);
    const pruned = pruneNavigation(deepTree(), share);
    expect(countNavigationLinks(pruned)).toBeLessThanOrEqual(share);
    // Every department survives with its own link.
    expect(pruned).toHaveLength(18);
    // Each department keeps its first children, in order.
    expect(pruned.every((item) => (item.subMenu?.length ?? 0) >= 2)).toBe(true);
    expect(pruned[0]!.subMenu!.map((child) => child.title).slice(0, 2)).toEqual(["Child 0.0", "Child 0.1"]);
    // The third level is cut before the second is complete.
    expect(pruned.some((item) => item.subMenu?.some((child) => child.subMenu))).toBe(false);
  });

  it("charges the extra 'all' link a parent's panel carries", () => {
    const pruned = pruneNavigation(deepTree(), 60, { allLinks: true });
    expect(countNavigationLinks(pruned, { allLinks: true })).toBeLessThanOrEqual(60);
  });

  it("keeps a small tree whole and drops linkless parents whose children were cut", () => {
    const small = [{ title: "Sale", href: "/sale" }, { title: "Men", subMenu: [{ title: "Panjabi", href: "/p" }] }];
    expect(pruneNavigation(small, 10)).toEqual(small);
    expect(pruneNavigation(small, 1)).toEqual([{ title: "Sale", href: "/sale" }]);
  });
});
