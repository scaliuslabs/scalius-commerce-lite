import { describe, expect, it } from "vitest";
import type { NavigationItem } from "@/lib/api";
import {
  countNavigationLinks,
  dedupeNavigation,
  estimateNavLabelWidth,
  estimateNavRowFit,
  mergeNavigation,
  navigationIndexMode,
  planHeaderNavigation,
  sourceNavigation,
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

/** The category tree as the layout serves it: 25 departments x 5 x 1 x 1, flat, top levels first. */
function categoryNodes() {
  const nodes: Array<{ id: string; name: string; slug: string; parentId: string | null }> = [];
  for (let root = 0; root < 25; root += 1) nodes.push({ id: `r${root}`, name: `Dept ${root}`, slug: `dept-${root}`, parentId: null });
  for (let root = 0; root < 25; root += 1) {
    for (let group = 0; group < 5; group += 1) {
      nodes.push({ id: `r${root}g${group}`, name: `Group ${root}.${group}`, slug: `group-${root}-${group}`, parentId: `r${root}` });
    }
  }
  for (let root = 0; root < 25; root += 1) {
    for (let group = 0; group < 5; group += 1) {
      nodes.push({ id: `r${root}g${group}l`, name: `Leaf ${root}.${group}`, slug: `leaf-${root}-${group}`, parentId: `r${root}g${group}` });
    }
  }
  return nodes;
}

describe("navigation sources", () => {
  const live = [
    { title: "Shop", href: "/search" },
    { title: "Footwear", href: "/categories/dept-0" },
    { title: "Home & Living", href: "/categories/dept-1/" },
    { title: "Footwear", href: "/categories/dept-0" },
    { title: "Track your order", href: "/track-order" },
  ];

  it("keeps every target once, the first occurrence winning, top levels first", () => {
    const menu = dedupeNavigation([
      ...live,
      { title: "More", href: "/more", subMenu: [{ title: "Shop again", href: "/search?" }, { title: "Deals", href: "/deals" }] },
      { title: "Brands", subMenu: [{ title: "A", href: "/brands/a" }] },
      { title: "Brands", subMenu: [{ title: "B", href: "/brands/b" }] },
    ]);
    expect(menu.map((item) => item.title)).toEqual(["Shop", "Footwear", "Home & Living", "Track your order", "More", "Brands"]);
    // "/search?" is "/search": gone from the deeper level.
    expect(menu[4]!.subMenu!.map((item) => item.title)).toEqual(["Deals"]);
    // Two linkless groups with one name are one group.
    expect(menu[5]!.subMenu!.map((item) => item.title)).toEqual(["A", "B"]);
  });

  it("renders the tree's departments, then the menu's other items, merging same targets", () => {
    const tree = sourceNavigation("tree+menu", live, categoryNodes());
    // 25 departments in tree order, then Shop and Track your order.
    expect(tree).toHaveLength(27);
    expect(tree[0]).toMatchObject({ title: "Footwear", href: "/categories/dept-0" });
    expect(tree[0]!.subMenu).toHaveLength(5);
    expect(tree[1]!.title).toBe("Home & Living");
    expect(tree.slice(25).map((item) => item.title)).toEqual(["Shop", "Track your order"]);
    expect(navigationDepth(tree)).toBe(3);
    // The menu alone, and the tree alone.
    expect(sourceNavigation("menu", live, categoryNodes()).map((item) => item.title)).toEqual([
      "Shop",
      "Footwear",
      "Home & Living",
      "Track your order",
    ]);
    expect(sourceNavigation("category-tree", live, categoryNodes())[0]!.title).toBe("Dept 0");
  });

  it("merges a menu item's children with the department's", () => {
    const merged = mergeNavigation(
      [{ title: "Dept", href: "/d", subMenu: [{ title: "A", href: "/a" }, { title: "B", href: "/b" }] }],
      [{ title: "Department", href: "/d", subMenu: [{ title: "Deals", href: "/deals" }, { title: "B!", href: "/b" }] }],
    );
    expect(merged).toEqual([
      {
        title: "Department",
        href: "/d",
        subMenu: [
          { title: "Deals", href: "/deals" },
          { title: "B!", href: "/b" },
          { title: "A", href: "/a" },
        ],
      },
    ]);
  });
});

describe("header link plan", () => {
  const surfaces = {
    desktop: true,
    desktopRow: true,
    desktopAllLinks: true,
    drawerAllLinks: true,
    desktopWeight: 0.5,
    reserved: 20,
  };

  it("shows maxTopItems roots on every surface, the rest in More and All categories, within the budget", () => {
    const tree = sourceNavigation("category-tree", [], categoryNodes());
    const plan = planHeaderNavigation(tree, { maxTopItems: 18, linkBudget: 150, index: "always" }, surfaces);
    expect(plan.desktop).toHaveLength(18);
    expect(plan.drawer).toHaveLength(18);
    expect(plan.extras.map((item) => item.title)).toEqual(Array.from({ length: 7 }, (_, index) => `Dept ${18 + index}`));
    expect(plan.allCategories).toBe(true);
    const links =
      surfaces.reserved +
      countNavigationLinks(plan.desktop, { allLinks: true }) + plan.extras.length + 2 +
      countNavigationLinks(plan.drawer, { allLinks: true }) + 1;
    expect(links).toBeLessThanOrEqual(150);
    // Both surfaces keep children for their departments.
    expect(plan.desktop.filter((item) => item.subMenu).length).toBeGreaterThan(0);
    expect(plan.drawer.filter((item) => item.subMenu).length).toBeGreaterThan(0);
  });

  it("never hides top items when there is no index to send buyers to", () => {
    const menu = Array.from({ length: 30 }, (_, index) => ({ title: `Item ${index}`, href: `/pages/${index}` }));
    const plan = planHeaderNavigation(menu, { maxTopItems: 6, linkBudget: 150, index: "none" }, surfaces);
    expect(plan.desktop).toHaveLength(6);
    expect(plan.extras).toHaveLength(24);
    expect(plan.drawer).toHaveLength(30);
    expect(plan.allCategories).toBe(false);
    expect(plan.drawerAllCategories).toBe(false);
    expect(navigationIndexMode(false, true)).toBe("overflow");
    // A short menu over a store with categories: no "More" for it, but the drawer still reaches them all.
    const short = planHeaderNavigation(menu.slice(0, 5), { maxTopItems: 6, linkBudget: 150, index: "overflow" }, surfaces);
    expect(short.allCategories).toBe(false);
    expect(short.drawerAllCategories).toBe(true);
  });

  it("estimates a row's fit conservatively, wide scripts counted wide", () => {
    const latin = estimateNavLabelWidth("Desk & Mobile Tech", { fontPx: 14 });
    // Measured 124px in Inter 14/500; the estimate never under-counts it.
    expect(latin).toBeGreaterThanOrEqual(124);
    expect(estimateNavLabelWidth("টেলিভিশন ও হোম থিয়েটার", { fontPx: 14 })).toBeGreaterThan(140);
    expect(estimateNavRowFit(["Shop", "Footwear", "Home & Living", "Kitchen & Table"], {
      fontPx: 14,
      itemChromePx: 24,
      gapPx: 4,
      availablePx: 200,
    })).toBe(2);
  });
});
