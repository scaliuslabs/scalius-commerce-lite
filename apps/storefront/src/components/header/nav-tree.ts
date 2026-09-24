/**
 * The one tree every menu renders from. Today it comes from the merchant's
 * header menu (Online store -> Navigation, up to three levels); once
 * categories have parents (catalogue Phase 1a) an automatic menu comes from
 * the category tree through `navigationFromCategoryTree`, and every menu
 * pattern (dropdown, cascading, mega, drill-in drawer, departments rail,
 * category bar) renders it unchanged.
 *
 * Large trees are drilled into, never dumped: `pruneNavigation` keeps a
 * rendering within its share of the header's link budget, top levels first,
 * so deep levels live on their category pages.
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
