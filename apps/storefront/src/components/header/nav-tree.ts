/**
 * The one tree every menu renders from: the theme's navigation source
 * (`blocks.navigation.source`), the merchant's header menu (Online store ->
 * Navigation, up to three levels), the reachable category tree (up to four,
 * `navigationFromCategoryTree`) or the tree's departments followed by the
 * menu's other items (`sourceNavigation`), each target once. Every menu
 * pattern (dropdown, cascading, mega, drill-in drawer, departments rail,
 * category bar) renders it unchanged.
 *
 * Large trees are drilled into, never dumped: `planHeaderNavigation` gives
 * each surface its share of the theme's link budget and shows at most
 * `maxTopItems` top entries, the rest behind "More" or "All categories"
 * (/categories); `pruneNavigation` cuts a rendering to its share, top levels
 * first, so deep levels live on their category pages.
 */
import type { NavigationItem } from "@/lib/api";

/** Links the whole header HTML may carry (SYNTHESIS.md section 7; Star Tech ships 1,634). */
export const HEADER_LINK_BUDGET = 150;
/** Links outside the menus: logo, account, track order, top bar, tabs, shortcuts. */
export const HEADER_FIXED_LINKS = 24;
/** Levels any menu renders (categories allow 4; manual menus 3). */
export const NAVIGATION_MAX_DEPTH = 4;

/** A category as the tree read will serve it (Phase 1a), nested or flat with `parentId`. */
export interface CategoryTreeNode {
  id: string;
  name: string;
  slug: string;
  /** A same-store `/categories/<slug>` override; blank uses the slug route. */
  canonicalPath?: string | null;
  imageUrl?: string | null;
  parentId?: string | null;
  children?: CategoryTreeNode[];
}

/** Menu items with a title, children normalised to arrays, depth capped. */
export function navigationTree(items: readonly NavigationItem[] | null | undefined, depth = 1): NavigationItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => typeof item?.title === "string" && item.title.trim().length > 0)
    .map((item) => {
      const children = depth < NAVIGATION_MAX_DEPTH ? navigationTree(item.subMenu, depth + 1) : [];
      const node: NavigationItem = { ...item, title: item.title.trim() };
      if (children.length > 0) node.subMenu = children;
      else delete node.subMenu;
      return node;
    });
}

function categoryHref(node: CategoryTreeNode): string {
  const override = node.canonicalPath?.trim();
  return override && override.startsWith("/categories/") ? override : `/categories/${encodeURIComponent(node.slug)}`;
}

/**
 * The category tree as a menu: nested nodes as they are, or a flat list
 * linked by `parentId` (roots are nodes without a known parent; cycles and
 * orphans cannot loop because each node is placed once).
 */
export function navigationFromCategoryTree(nodes: readonly CategoryTreeNode[]): NavigationItem[] {
  const flat = nodes.some((node) => node.parentId !== undefined && !node.children);
  const toItem = (node: CategoryTreeNode, children: NavigationItem[]): NavigationItem => ({
    id: node.id,
    title: node.name,
    href: categoryHref(node),
    ...(node.imageUrl ? { imageUrl: node.imageUrl } : {}),
    ...(children.length > 0 ? { subMenu: children } : {}),
  });
  if (!flat) {
    const nested = (list: readonly CategoryTreeNode[], depth: number): NavigationItem[] =>
      list.map((node) => toItem(node, depth < NAVIGATION_MAX_DEPTH ? nested(node.children ?? [], depth + 1) : []));
    return navigationTree(nested(nodes, 1));
  }
  const ids = new Set(nodes.map((node) => node.id));
  const byParent = new Map<string | null, CategoryTreeNode[]>();
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) && node.parentId !== node.id ? node.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), node]);
  }
  const placed = new Set<string>();
  const build = (parent: string | null, depth: number): NavigationItem[] =>
    (byParent.get(parent) ?? [])
      .filter((node) => !placed.has(node.id) && placed.add(node.id))
      .map((node) => toItem(node, depth < NAVIGATION_MAX_DEPTH ? build(node.id, depth + 1) : []));
  return navigationTree(build(null, 1));
}

export function navigationDepth(items: readonly NavigationItem[]): number {
  if (items.length === 0) return 0;
  return 1 + Math.max(...items.map((item) => navigationDepth(item.subMenu ?? [])));
}

export interface NavigationLinkCost {
  /** A parent that has a link and children adds a "Shop all" / "All X" link (panels and drill levels). */
  allLinks?: boolean;
}

/** The anchors a rendering of this tree emits. */
export function countNavigationLinks(items: readonly NavigationItem[], cost: NavigationLinkCost = {}): number {
  return items.reduce((sum, item) => {
    const children = item.subMenu ?? [];
    const own = item.href ? 1 : 0;
    const all = cost.allLinks && item.href && children.length > 0 ? 1 : 0;
    return sum + own + all + countNavigationLinks(children, cost);
  }, 0);
}

interface Slot {
  item: NavigationItem;
  path: number[];
  parent: Slot | null;
  kept: boolean;
  keptChildren: number;
}

/**
 * The tree cut to at most `maxLinks` anchors. Level by level (every top
 * item before any second-level item), and within a level round-robin across
 * parents, so each department keeps its first links. A parent whose
 * children were cut keeps its own link (its category page lists the rest);
 * a parent without a link and without kept children is dropped.
 */
export function pruneNavigation(
  items: readonly NavigationItem[],
  maxLinks: number,
  cost: NavigationLinkCost = {},
): NavigationItem[] {
  const tree = navigationTree(items);
  if (countNavigationLinks(tree, cost) <= maxLinks) return tree;

  let used = 0;
  let level: Slot[] = tree.map((item, index) => ({ item, path: [index], parent: null, kept: false, keptChildren: 0 }));
  const kept = new Set<string>();
  while (level.length > 0) {
    // Round-robin: the first child of every parent, then the second...
    const byParent = new Map<Slot | null, Slot[]>();
    for (const slot of level) byParent.set(slot.parent, [...(byParent.get(slot.parent) ?? []), slot]);
    const queues = [...byParent.values()];
    const order: Slot[] = [];
    for (let rank = 0; queues.some((queue) => rank < queue.length); rank += 1) {
      for (const queue of queues) if (rank < queue.length) order.push(queue[rank]!);
    }
    const next: Slot[] = [];
    for (const slot of order) {
      if (slot.parent && !slot.parent.kept) continue;
      const own = slot.item.href ? 1 : 0;
      const parent = slot.parent;
      const allLink = cost.allLinks && parent?.item.href && parent.keptChildren === 0 ? 1 : 0;
      if (used + own + allLink > maxLinks) continue;
      used += own + allLink;
      slot.kept = true;
      if (parent) parent.keptChildren += 1;
      kept.add(slot.path.join("."));
      (slot.item.subMenu ?? []).forEach((child, index) =>
        next.push({ item: child, path: [...slot.path, index], parent: slot, kept: false, keptChildren: 0 }));
    }
    level = next;
  }

  const rebuild = (list: readonly NavigationItem[], prefix: number[]): NavigationItem[] =>
    list.flatMap((item, index) => {
      const path = [...prefix, index];
      if (!kept.has(path.join("."))) return [];
      const children = rebuild(item.subMenu ?? [], path);
      if (!item.href && children.length === 0) return [];
      const node: NavigationItem = { ...item };
      if (children.length > 0) node.subMenu = children;
      else delete node.subMenu;
      return [node];
    });
  return rebuild(tree, []);
}

/**
 * Each menu rendering's share of the header's link budget: the budget
 * minus the fixed links, split evenly across the renderings (a desktop menu
 * and a phone drawer are two; one drawer serving both is one).
 */
export function navigationLinkShare(renderings: number, reserved = 0): number {
  return Math.floor((HEADER_LINK_BUDGET - HEADER_FIXED_LINKS - reserved) / Math.max(1, renderings));
}

/** Top-level links for a shortcut row (phone shortcuts, a row beside "All"): linked items, a linkless parent's links. */
export function navigationShortcuts(items: readonly NavigationItem[], max: number): NavigationItem[] {
  return items
    .flatMap((item) => (item.href ? [item] : (item.subMenu ?? []).filter((child) => child.href)))
    .slice(0, max)
    .map(({ subMenu: _children, ...item }) => item);
}

// ── Sources: the menu, the category tree, or both ───────────────────────

const LOCAL_ORIGIN = "https://store.invalid";

/**
 * What a link points at, for de-duplication: the same-store path (no
 * trailing slash, case-folded) plus its query, or the full external URL.
 * Items without a link have no target.
 */
export function navigationTargetKey(href: string | undefined): string | null {
  const value = href?.trim();
  if (!value || value.startsWith("#")) return null;
  try {
    const url = new URL(value, LOCAL_ORIGIN);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    const origin = url.origin === LOCAL_ORIGIN ? "" : url.origin;
    return `${origin}${path.toLowerCase()}${url.search}`;
  } catch {
    return value.toLowerCase();
  }
}

/** The label a buyer reads, compared without case or spacing differences. */
function labelKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Every target once: the first occurrence wins, top levels before deeper
 * ones (breadth-first), so a department keeps its place and a repeat deeper
 * down disappears with its children (the kept one's page lists them). Among
 * siblings, linkless items with the same label merge into one group.
 */
export function dedupeNavigation(items: readonly NavigationItem[]): NavigationItem[] {
  const tree = navigationTree(items);
  const seen = new Set<string>();
  const claimed = new Set<NavigationItem>();
  let level: NavigationItem[] = tree;
  while (level.length > 0) {
    const next: NavigationItem[] = [];
    for (const item of level) {
      const key = navigationTargetKey(item.href);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      claimed.add(item);
      next.push(...(item.subMenu ?? []));
    }
    level = next;
  }
  const rebuild = (list: readonly NavigationItem[]): NavigationItem[] => {
    const out: NavigationItem[] = [];
    const groups = new Map<string, NavigationItem>();
    for (const item of list) {
      if (!claimed.has(item)) continue;
      const children = rebuild(item.subMenu ?? []);
      const group = item.href ? undefined : groups.get(labelKey(item.title));
      if (group) {
        group.subMenu = [...(group.subMenu ?? []), ...children];
        continue;
      }
      if (!item.href && children.length === 0) continue;
      const node: NavigationItem = { ...item };
      if (children.length > 0) node.subMenu = children;
      else delete node.subMenu;
      if (!node.href) groups.set(labelKey(node.title), node);
      out.push(node);
    }
    return out;
  };
  return rebuild(tree);
}

/**
 * The tree's items followed by the menu's: a menu item whose target is
 * already present at the same level merges into it (the tree's position,
 * the menu's label and link attributes, the menu's children first, then the
 * tree's, merged the same way); the rest are appended in menu order.
 */
export function mergeNavigation(tree: readonly NavigationItem[], menu: readonly NavigationItem[]): NavigationItem[] {
  return mergeLevels(tree, menu, "second");
}

/** `first`'s items then `second`'s; a shared target keeps `first`'s position and `labels`' label and link attributes. */
function mergeLevels(
  first: readonly NavigationItem[],
  second: readonly NavigationItem[],
  labels: "first" | "second",
): NavigationItem[] {
  const out: NavigationItem[] = first.map((item) => ({ ...item }));
  const byKey = new Map<string, number>();
  out.forEach((item, index) => {
    const key = navigationTargetKey(item.href);
    if (key !== null && !byKey.has(key)) byKey.set(key, index);
  });
  for (const item of second) {
    const key = navigationTargetKey(item.href);
    const index = key === null ? undefined : byKey.get(key);
    if (index === undefined) {
      out.push({ ...item });
      if (key !== null) byKey.set(key, out.length - 1);
      continue;
    }
    const base = out[index]!;
    const [labelled, other] = labels === "second" ? [item, base] : [base, item];
    // The labelled side (the merchant's menu) lists its children first.
    const children = mergeLevels(labelled.subMenu ?? [], other.subMenu ?? [], "first");
    const merged: NavigationItem = { ...other, ...labelled };
    const imageUrl = labelled.imageUrl ?? other.imageUrl;
    if (imageUrl) merged.imageUrl = imageUrl;
    if (children.length > 0) merged.subMenu = children;
    else delete merged.subMenu;
    out[index] = merged;
  }
  return out;
}

export type NavigationSource = "menu" | "category-tree" | "tree+menu";

/** The tree every header surface renders for a resolved navigation source, each target once. */
export function sourceNavigation(
  source: NavigationSource,
  menu: readonly NavigationItem[] | null | undefined,
  categories: readonly CategoryTreeNode[] | null | undefined,
): NavigationItem[] {
  const menuTree = navigationTree(menu);
  const tree = navigationFromCategoryTree(categories ?? []);
  // A tree source without a tree (none reachable, or an API without it) renders the menu.
  if (source === "menu" || tree.length === 0) return dedupeNavigation(menuTree);
  if (source === "category-tree") return dedupeNavigation(tree);
  return dedupeNavigation(mergeNavigation(tree, menuTree));
}

// ── The header's link budget, across its surfaces ───────────────────────

/** Roots beyond `maxTopItems` a row's "More" list still names before "All categories". */
export const NAVIGATION_MORE_EXTRAS = 12;

export interface HeaderNavigationSurfaces {
  /** A desktop menu renders in the header HTML (not only the shared drill drawer). */
  desktop: boolean;
  /** The desktop menu is a row with a "More" list (its extras cost links). */
  desktopRow: boolean;
  /** Desktop panels add a "Shop all X" link per parent; drill levels an "All X". */
  desktopAllLinks: boolean;
  drawerAllLinks: boolean;
  /** The desktop panels' share of what is left once every root is placed (the drawer's levels get the rest). */
  desktopWeight: number;
  /** Links already spoken for: logo, account, utilities, socials, shortcut rows. */
  reserved: number;
}

/**
 * When surfaces end with "All categories" (the /categories index):
 * - `always`: the navigation comes from the category tree, which the header
 *   shows only in part;
 * - `overflow`: a menu with more top items than a surface shows;
 * - `none`: the store has no reachable category, so there is no index and
 *   drawers list every top item.
 */
export type NavigationIndexMode = "always" | "overflow" | "none";

export function navigationIndexMode(treeSourced: boolean, hasCategories: boolean): NavigationIndexMode {
  if (!hasCategories) return "none";
  return treeSourced ? "always" : "overflow";
}

export interface HeaderNavigationPlan {
  /** The roots every surface shows (at most `maxTopItems`), with the desktop's share of their children. */
  desktop: NavigationItem[];
  /** The same roots with the drawer's share of their children. */
  drawer: NavigationItem[];
  /** Roots past `maxTopItems`, childless, for a row's "More" list. */
  extras: NavigationItem[];
  /** Desktop surfaces end with "All categories" (/categories): some of the tree is not in them. */
  allCategories: boolean;
  /** Drawers end with "All categories" whenever the store has categories (a phone reaches every one). */
  drawerAllCategories: boolean;
}

/**
 * Splits the header's link budget (theme `navigation.linkBudget`) across
 * its surfaces: first every surface's roots (at most `maxTopItems`, a row's
 * extras and the "All categories" links), then what is left, top levels
 * first, between the desktop panels and the drawer's levels. What does not
 * fit is one click away on its parent's page and on /categories.
 */
export function planHeaderNavigation(
  tree: readonly NavigationItem[],
  options: { maxTopItems: number; linkBudget: number; index: NavigationIndexMode },
  surfaces: HeaderNavigationSurfaces,
): HeaderNavigationPlan {
  const bare = ({ subMenu: _children, ...item }: NavigationItem): NavigationItem => item;
  const top = Math.max(1, options.maxTopItems);
  const indexed = options.index !== "none";
  const roots = tree.slice(0, top);
  // Without an index, a drawer lists every top item and "More" every extra.
  const drawerRoots = indexed ? roots : tree;
  const extras = surfaces.desktop && surfaces.desktopRow
    ? tree.slice(roots.length, indexed ? roots.length + NAVIGATION_MORE_EXTRAS : undefined).map(bare)
    : [];
  const allCategories = options.index === "always" || (options.index === "overflow" && tree.length > roots.length);
  const index = allCategories ? 1 : 0;
  const drawerIndex = indexed ? 1 : 0;
  const desktopLinks = countNavigationLinks(roots.map(bare));
  const drawerLinks = countNavigationLinks(drawerRoots.map(bare));
  // A desktop row also carries its extras, "All categories" in "More" and its no-script twin.
  const desktopRoots = surfaces.desktop ? desktopLinks + extras.length + index * (surfaces.desktopRow ? 2 : 1) : 0;
  const free = Math.max(0, options.linkBudget - surfaces.reserved - (drawerLinks + drawerIndex) - desktopRoots);
  const desktopFree = surfaces.desktop ? Math.floor(free * surfaces.desktopWeight) : 0;
  return {
    desktop: surfaces.desktop ? pruneNavigation(roots, desktopLinks + desktopFree, { allLinks: surfaces.desktopAllLinks }) : [],
    drawer: pruneNavigation(drawerRoots, drawerLinks + free - desktopFree, { allLinks: surfaces.drawerAllLinks }),
    extras,
    allCategories,
    drawerAllCategories: indexed,
  };
}

// ── Fitting a row before any script runs ────────────────────────────────

/**
 * A conservative width (px) for a top-level link label: wide glyphs counted
 * wide, so a row that "fits" by this estimate fits on screen. It decides
 * which items a server-rendered row shows without JavaScript.
 */
export function estimateNavLabelWidth(title: string, options: { fontPx: number; uppercase?: boolean }): number {
  let em = 0;
  for (const char of title) {
    if (/\s/.test(char)) em += 0.3;
    else if (/[ঀ-৿]/.test(char)) em += /[ঁ-ঃ়-্ৗ]/.test(char) ? 0.2 : 0.75;
    else if (options.uppercase || /[A-Z0-9&@%]/.test(char)) em += 0.72;
    else if (/[a-z]/.test(char)) em += 0.56;
    else em += 0.62;
  }
  return Math.ceil(em * options.fontPx * (options.uppercase ? 1.08 : 1));
}

/** How many leading items fit in `availablePx` (each with its padding and chrome). */
export function estimateNavRowFit(
  titles: readonly string[],
  options: { fontPx: number; uppercase?: boolean; itemChromePx: number; gapPx: number; availablePx: number },
): number {
  let used = 0;
  for (let index = 0; index < titles.length; index += 1) {
    const width = estimateNavLabelWidth(titles[index]!, options) + options.itemChromePx + (index > 0 ? options.gapPx : 0);
    if (used + width > options.availablePx) return index;
    used += width;
  }
  return titles.length;
}
