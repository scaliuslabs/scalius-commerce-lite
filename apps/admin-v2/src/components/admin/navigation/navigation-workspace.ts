import type { NavigationItem } from "./types";
import { canIndentNavigationItem, MAX_NAV_DEPTH } from "./types";

export interface NavigationLocation {
  item: NavigationItem;
  index: number;
  depth: number;
  siblingCount: number;
  parentId: string | null;
  ancestors: NavigationItem[];
}

export interface NavigationOutlineRow extends NavigationLocation {
  hasChildren: boolean;
  isExpanded: boolean;
  matchesQuery: boolean;
}

export const NAVIGATION_DRAG_INDENT_THRESHOLD = 32;

export type NavigationDragIntent =
  | {
      type: "reorder";
      activeId: string;
      overId: string;
      targetIndex: number;
      parentId: string | null;
      message: string;
    }
  | {
      type: "nest";
      activeId: string;
      overId: string;
      parentId: string;
      message: string;
    }
  | {
      type: "outdent";
      activeId: string;
      overId: string;
      parentId: string | null;
      message: string;
    }
  | {
      type: "invalid";
      activeId: string;
      overId: string | null;
      message: string;
    };

export interface NavigationDragResult {
  items: NavigationItem[];
  intent: NavigationDragIntent;
  changed: boolean;
}

export function countNavigationItems(items: NavigationItem[]): number {
  return items.reduce(
    (total, item) =>
      total + 1 + countNavigationItems(item.subMenu ?? []),
    0,
  );
}

export function getNavigationDepth(items: NavigationItem[]): number {
  if (items.length === 0) return 0;
  return Math.max(
    ...items.map((item) => 1 + getNavigationDepth(item.subMenu ?? [])),
  );
}

export function collectNavigationParentIds(
  items: NavigationItem[],
  result = new Set<string>(),
): Set<string> {
  for (const item of items) {
    if (item.subMenu?.length) {
      result.add(item.id);
      collectNavigationParentIds(item.subMenu, result);
    }
  }
  return result;
}

export function findNavigationLocation(
  items: NavigationItem[],
  id: string,
  depth = 0,
  parentId: string | null = null,
  ancestors: NavigationItem[] = [],
): NavigationLocation | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.id === id) {
      return {
        item,
        index,
        depth,
        siblingCount: items.length,
        parentId,
        ancestors,
      };
    }

    const childLocation = findNavigationLocation(
      item.subMenu ?? [],
      id,
      depth + 1,
      item.id,
      [...ancestors, item],
    );
    if (childLocation) return childLocation;
  }

  return null;
}

export function navigationItemMatchesQuery(
  item: NavigationItem,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  const ownText = `${item.title} ${item.href ?? ""}`.toLocaleLowerCase();
  return (
    ownText.includes(normalizedQuery) ||
    (item.subMenu ?? []).some((child) =>
      navigationItemMatchesQuery(child, normalizedQuery),
    )
  );
}

/**
 * Build the visible menu outline in one traversal. Search keeps matching items
 * and their ancestors, so merchants never lose hierarchy context. Outside
 * search, collapsed branches are not added to the render list at all.
 */
export function flattenNavigationOutline(
  items: NavigationItem[],
  expandedIds: ReadonlySet<string>,
  normalizedQuery = "",
): NavigationOutlineRow[] {
  const visibleSearchIds = new Set<string>();
  const matchingSearchIds = new Set<string>();

  if (normalizedQuery) {
    const collectSearchVisibility = (
      currentItems: NavigationItem[],
      ancestorIds: string[],
    ): boolean => {
      let branchMatches = false;

      for (const item of currentItems) {
        const ownText = `${item.title} ${item.href ?? ""}`.toLocaleLowerCase();
        const ownMatch = ownText.includes(normalizedQuery);
        const childMatch = collectSearchVisibility(item.subMenu ?? [], [
          ...ancestorIds,
          item.id,
        ]);

        if (!ownMatch && !childMatch) continue;
        branchMatches = true;
        visibleSearchIds.add(item.id);
        if (ownMatch) matchingSearchIds.add(item.id);
        for (const ancestorId of ancestorIds) visibleSearchIds.add(ancestorId);
      }

      return branchMatches;
    };

    collectSearchVisibility(items, []);
  }

  const rows: NavigationOutlineRow[] = [];

  const visit = (
    currentItems: NavigationItem[],
    depth: number,
    parentId: string | null,
    ancestors: NavigationItem[],
  ) => {
    for (let index = 0; index < currentItems.length; index += 1) {
      const item = currentItems[index];
      if (normalizedQuery && !visibleSearchIds.has(item.id)) continue;

      const children = item.subMenu ?? [];
      const hasChildren = children.length > 0;
      const isExpanded = hasChildren && (
        Boolean(normalizedQuery) || expandedIds.has(item.id)
      );

      rows.push({
        item,
        index,
        depth,
        siblingCount: currentItems.length,
        parentId,
        ancestors,
        hasChildren,
        isExpanded,
        matchesQuery: !normalizedQuery || matchingSearchIds.has(item.id),
      });

      if (isExpanded) {
        visit(children, depth + 1, item.id, [...ancestors, item]);
      }
    }
  };

  visit(items, 0, null, []);
  return rows;
}

export function updateNavigationItemById(
  items: NavigationItem[],
  id: string,
  updates: Partial<NavigationItem>,
): NavigationItem[] {
  return items.map((item) => {
    if (item.id === id) return { ...item, ...updates };
    if (!item.subMenu?.length) return item;
    return {
      ...item,
      subMenu: updateNavigationItemById(item.subMenu, id, updates),
    };
  });
}

export function removeNavigationItemById(
  items: NavigationItem[],
  id: string,
): NavigationItem[] {
  return items
    .filter((item) => item.id !== id)
    .map((item) =>
      item.subMenu?.length
        ? {
            ...item,
            subMenu: removeNavigationItemById(item.subMenu, id),
          }
        : item,
    );
}

export function appendNavigationItems(
  items: NavigationItem[],
  parentId: string | null,
  addedItems: NavigationItem[],
): NavigationItem[] {
  if (!parentId) return [...items, ...addedItems];
  return items.map((item) => {
    if (item.id === parentId) {
      return { ...item, subMenu: [...(item.subMenu ?? []), ...addedItems] };
    }
    if (!item.subMenu?.length) return item;
    return {
      ...item,
      subMenu: appendNavigationItems(item.subMenu, parentId, addedItems),
    };
  });
}

function moveInArray<T>(items: T[], oldIndex: number, newIndex: number): T[] {
  if (
    oldIndex === newIndex ||
    oldIndex < 0 ||
    newIndex < 0 ||
    oldIndex >= items.length ||
    newIndex >= items.length
  ) {
    return items;
  }
  const next = [...items];
  const [moved] = next.splice(oldIndex, 1);
  next.splice(newIndex, 0, moved);
  return next;
}

export function moveNavigationItemById(
  items: NavigationItem[],
  id: string,
  direction: -1 | 1,
): NavigationItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) return moveInArray(items, index, index + direction);

  return items.map((item) =>
    item.subMenu?.length
      ? {
          ...item,
          subMenu: moveNavigationItemById(item.subMenu, id, direction),
        }
      : item,
  );
}

export function moveNavigationItemToIndexById(
  items: NavigationItem[],
  id: string,
  newIndex: number,
): NavigationItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) return moveInArray(items, index, newIndex);

  return items.map((item) =>
    item.subMenu?.length
      ? {
          ...item,
          subMenu: moveNavigationItemToIndexById(item.subMenu, id, newIndex),
        }
      : item,
  );
}

export function moveNavigationItemToParentById(
  items: NavigationItem[],
  id: string,
  newParentId: string | null,
  maxDepth = MAX_NAV_DEPTH,
): NavigationItem[] {
  const source = findNavigationLocation(items, id);
  if (!source || source.parentId === newParentId) return items;

  if (newParentId) {
    // A node cannot be moved below itself or any of its descendants.
    if (
      newParentId === id ||
      findNavigationLocation(source.item.subMenu ?? [], newParentId)
    ) {
      return items;
    }

    const target = findNavigationLocation(items, newParentId);
    if (
      !target ||
      target.depth + 1 + getNavigationDepth([source.item]) > maxDepth
    ) {
      return items;
    }
  }

  return appendNavigationItems(
    removeNavigationItemById(items, id),
    newParentId,
    [source.item],
  );
}

export function indentNavigationItemById(
  items: NavigationItem[],
  id: string,
  maxDepth = MAX_NAV_DEPTH,
  depth = 0,
): NavigationItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) {
    const item = items[index];
    const previous = items[index - 1];
    if (!previous || !canIndentNavigationItem(item, depth, maxDepth)) {
      return items;
    }
    const next = items.filter((_, itemIndex) => itemIndex !== index);
    next[index - 1] = {
      ...previous,
      subMenu: [...(previous.subMenu ?? []), item],
    };
    return next;
  }

  return items.map((item) =>
    item.subMenu?.length
      ? {
          ...item,
          subMenu: indentNavigationItemById(
            item.subMenu,
            id,
            maxDepth,
            depth + 1,
          ),
        }
      : item,
  );
}

export function outdentNavigationItemById(
  items: NavigationItem[],
  id: string,
): NavigationItem[] {
  for (let parentIndex = 0; parentIndex < items.length; parentIndex += 1) {
    const parent = items[parentIndex];
    const children = parent.subMenu ?? [];
    const childIndex = children.findIndex((child) => child.id === id);
    if (childIndex >= 0) {
      const child = children[childIndex];
      const next = [...items];
      next[parentIndex] = {
        ...parent,
        subMenu: children.filter((_, index) => index !== childIndex),
      };
      next.splice(parentIndex + 1, 0, child);
      return next;
    }
  }

  return items.map((item) =>
    item.subMenu?.length
      ? {
          ...item,
          subMenu: outdentNavigationItemById(item.subMenu, id),
        }
      : item,
  );
}

/**
 * Convert a flat outline drag into one deliberate tree command. A vertical
 * drop only reorders siblings. Moving right nests the complete branch below
 * the item under the pointer; moving left outdents one level. Ambiguous
 * cross-parent vertical drops are rejected so a branch never changes level by
 * accident.
 */
export function getNavigationDragIntent(
  items: NavigationItem[],
  activeId: string,
  overId: string | null,
  horizontalDelta: number,
  maxDepth = MAX_NAV_DEPTH,
): NavigationDragIntent {
  const source = findNavigationLocation(items, activeId);
  const target = overId ? findNavigationLocation(items, overId) : null;

  if (!source || !target || !overId) {
    return {
      type: "invalid",
      activeId,
      overId,
      message: "No menu item is available at that drop position.",
    };
  }

  if (activeId === overId) {
    return {
      type: "invalid",
      activeId,
      overId,
      message: "The item is already in that position.",
    };
  }

  if (horizontalDelta >= NAVIGATION_DRAG_INDENT_THRESHOLD) {
    if (
      target.item.id === source.item.id ||
      findNavigationLocation(source.item.subMenu ?? [], target.item.id)
    ) {
      return {
        type: "invalid",
        activeId,
        overId,
        message: "A menu item cannot be nested inside its own branch.",
      };
    }

    const subtreeDepth = getNavigationDepth([source.item]);
    if (target.depth + 1 + subtreeDepth > maxDepth) {
      return {
        type: "invalid",
        activeId,
        overId,
        message: `That branch would exceed the ${maxDepth}-level menu limit.`,
      };
    }

    if (source.parentId === target.item.id) {
      return {
        type: "invalid",
        activeId,
        overId,
        message: `${source.item.title || "This item"} is already nested under ${target.item.title || "that item"}.`,
      };
    }

    return {
      type: "nest",
      activeId,
      overId,
      parentId: target.item.id,
      message: `Nest ${source.item.title || "item"} under ${target.item.title || "item"}.`,
    };
  }

  if (horizontalDelta <= -NAVIGATION_DRAG_INDENT_THRESHOLD) {
    if (source.depth === 0) {
      return {
        type: "invalid",
        activeId,
        overId,
        message: `${source.item.title || "This item"} is already at the top level.`,
      };
    }

    const nextParentId = source.ancestors.at(-2)?.id ?? null;
    return {
      type: "outdent",
      activeId,
      overId,
      parentId: nextParentId,
      message: `Move ${source.item.title || "item"} up one level.`,
    };
  }

  if (source.parentId !== target.parentId) {
    return {
      type: "invalid",
      activeId,
      overId,
      message: "Vertical dragging only reorders items with the same parent. Drag right to nest, left to move up a level, or use Parent.",
    };
  }

  return {
    type: "reorder",
    activeId,
    overId,
    targetIndex: target.index,
    parentId: source.parentId,
    message: `Place ${source.item.title || "item"} at position ${target.index + 1}.`,
  };
}

export function applyNavigationDrag(
  items: NavigationItem[],
  activeId: string,
  overId: string | null,
  horizontalDelta: number,
  maxDepth = MAX_NAV_DEPTH,
): NavigationDragResult {
  const intent = getNavigationDragIntent(
    items,
    activeId,
    overId,
    horizontalDelta,
    maxDepth,
  );

  if (intent.type === "invalid") {
    return { items, intent, changed: false };
  }

  const next = intent.type === "reorder"
    ? moveNavigationItemToIndexById(items, activeId, intent.targetIndex)
    : intent.type === "nest"
      ? moveNavigationItemToParentById(items, activeId, intent.parentId, maxDepth)
      : outdentNavigationItemById(items, activeId);

  return {
    items: next,
    intent,
    changed: next !== items,
  };
}
