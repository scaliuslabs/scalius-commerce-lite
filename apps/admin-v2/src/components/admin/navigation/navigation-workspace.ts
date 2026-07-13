import type { NavigationItem } from "./types";
import {
  canIndentNavigationItem,
  getNavigationItemHref,
  getNavigationItemLabel,
  MAX_NAV_DEPTH,
} from "./types";

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

export const NAVIGATION_TREE_INDENT = 24;

export type NavigationDropOperation = "before" | "inside" | "after";

export function getNavigationDropOperationAtPoint({
  pointerY,
  top,
  height,
}: {
  pointerY: number;
  top: number;
  height: number;
}): NavigationDropOperation {
  if (!Number.isFinite(pointerY) || !Number.isFinite(top) || height <= 0) {
    return "before";
  }
  const offset = pointerY - top;
  if (offset <= height * 0.25) return "before";
  if (offset >= height * 0.75) return "after";
  return "inside";
}

export type NavigationDragIntent =
  | {
      type: "move";
      activeId: string;
      overId: string;
      operation: NavigationDropOperation;
      depth: number;
      targetIndex: number;
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
  const ownText = `${getNavigationItemLabel(item)} ${getNavigationItemHref(item) ?? ""}`.toLocaleLowerCase();
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
        const ownText = `${getNavigationItemLabel(item)} ${getNavigationItemHref(item) ?? ""}`.toLocaleLowerCase();
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

/**
 * Move one complete branch to an exact parent and sibling index in a single
 * immutable operation. `targetIndex` is measured against the destination
 * siblings after the moving branch has been removed.
 */
export function moveNavigationItemToParentAtIndexById(
  items: NavigationItem[],
  id: string,
  newParentId: string | null,
  targetIndex: number,
  maxDepth = MAX_NAV_DEPTH,
): NavigationItem[] {
  const source = findNavigationLocation(items, id);
  if (!source) return items;

  if (newParentId) {
    if (
      newParentId === id ||
      findNavigationLocation(source.item.subMenu ?? [], newParentId)
    ) {
      return items;
    }

    const parent = findNavigationLocation(items, newParentId);
    if (
      !parent ||
      parent.depth + 1 + getNavigationDepth([source.item]) > maxDepth
    ) {
      return items;
    }
  } else if (getNavigationDepth([source.item]) > maxDepth) {
    return items;
  }

  const stripped = removeNavigationItemById(items, id);
  const siblings = getNavigationSiblings(stripped, newParentId);
  if (!siblings) return items;

  return insertNavigationItemAt(
    stripped,
    newParentId,
    Math.min(Math.max(targetIndex, 0), siblings.length),
    source.item,
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

function insertNavigationItemAt(
  items: NavigationItem[],
  parentId: string | null,
  targetIndex: number,
  insertedItem: NavigationItem,
): NavigationItem[] {
  if (!parentId) {
    const next = [...items];
    next.splice(Math.min(Math.max(targetIndex, 0), next.length), 0, insertedItem);
    return next;
  }

  return items.map((item) => {
    if (item.id === parentId) {
      const children = [...(item.subMenu ?? [])];
      children.splice(
        Math.min(Math.max(targetIndex, 0), children.length),
        0,
        insertedItem,
      );
      return { ...item, subMenu: children };
    }
    if (!item.subMenu?.length) return item;
    return {
      ...item,
      subMenu: insertNavigationItemAt(
        item.subMenu,
        parentId,
        targetIndex,
        insertedItem,
      ),
    };
  });
}

function getNavigationSiblings(
  items: NavigationItem[],
  parentId: string | null,
): NavigationItem[] | null {
  if (!parentId) return items;
  return findNavigationLocation(items, parentId)?.item.subMenu ?? null;
}

function getDescendantIds(item: NavigationItem): Set<string> {
  const result = new Set<string>();
  const visit = (children: NavigationItem[]) => {
    for (const child of children) {
      result.add(child.id);
      visit(child.subMenu ?? []);
    }
  };
  visit(item.subMenu ?? []);
  return result;
}

function hasSameNavigationStructure(
  first: NavigationItem[],
  second: NavigationItem[],
): boolean {
  if (first.length !== second.length) return false;
  return first.every((item, index) => (
    item.id === second[index].id &&
    hasSameNavigationStructure(item.subMenu ?? [], second[index].subMenu ?? [])
  ));
}

/**
 * Convert an explicit target-row operation back into the nested menu. The top
 * and bottom hitboxes preserve the target's parent; the middle hitbox is the
 * only operation that creates a child. Hierarchy does not depend on horizontal
 * drag distance.
 */
export function getNavigationDragIntent(
  items: NavigationItem[],
  visibleRows: NavigationOutlineRow[],
  activeId: string,
  overId: string | null,
  operation: NavigationDropOperation,
  maxDepth = MAX_NAV_DEPTH,
): NavigationDragIntent {
  const source = findNavigationLocation(items, activeId);
  const target = overId
    ? visibleRows.find((row) => row.item.id === overId) ?? null
    : null;

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

  const descendantIds = getDescendantIds(source.item);
  if (descendantIds.has(overId)) {
    return {
      type: "invalid",
      activeId,
      overId,
      message: "A menu item cannot be placed inside its own branch.",
    };
  }

  if (!visibleRows.some((row) => row.item.id === overId)) {
    return {
      type: "invalid",
      activeId,
      overId,
      message: "That branch is not an available drop position.",
    };
  }

  const subtreeDepth = getNavigationDepth([source.item]);
  const depth = operation === "inside" ? target.depth + 1 : target.depth;
  if (depth + subtreeDepth > maxDepth) {
    return {
      type: "invalid",
      activeId,
      overId,
      message: `That branch cannot fit at this position within the ${maxDepth}-level menu limit.`,
    };
  }

  const strippedItems = removeNavigationItemById(items, activeId);
  const parentId = operation === "inside" ? overId : target.parentId;
  const siblings = getNavigationSiblings(strippedItems, parentId);
  if (!siblings) {
    return {
      type: "invalid",
      activeId,
      overId,
      message: "That menu branch is no longer available.",
    };
  }

  const strippedTarget = findNavigationLocation(strippedItems, overId);
  if (!strippedTarget) {
    return {
      type: "invalid",
      activeId,
      overId,
      message: "That menu item is no longer available.",
    };
  }
  const targetIndex = operation === "inside"
    ? siblings.length
    : strippedTarget.index + (operation === "after" ? 1 : 0);
  const parentItem = parentId
    ? findNavigationLocation(strippedItems, parentId)?.item
    : undefined;
  const parentTitle = parentItem ? getNavigationItemLabel(parentItem) : "";

  return {
    type: "move",
    activeId,
    overId,
    operation,
    depth,
    targetIndex,
    parentId,
    message: operation === "inside"
      ? `Place ${getNavigationItemLabel(source.item)} inside ${getNavigationItemLabel(target.item)}.`
      : `Place ${getNavigationItemLabel(source.item)} ${operation} ${getNavigationItemLabel(target.item)}${parentTitle ? ` under ${parentTitle}` : " at top level"}.`,
  };
}

export function applyNavigationDrag(
  items: NavigationItem[],
  visibleRows: NavigationOutlineRow[],
  activeId: string,
  overId: string | null,
  operation: NavigationDropOperation,
  maxDepth = MAX_NAV_DEPTH,
): NavigationDragResult {
  const intent = getNavigationDragIntent(
    items,
    visibleRows,
    activeId,
    overId,
    operation,
    maxDepth,
  );

  if (intent.type === "invalid") {
    return { items, intent, changed: false };
  }

  const source = findNavigationLocation(items, activeId);
  if (!source) return { items, intent, changed: false };

  const next = insertNavigationItemAt(
    removeNavigationItemById(items, activeId),
    intent.parentId,
    intent.targetIndex,
    source.item,
  );
  const changed = !hasSameNavigationStructure(items, next);

  return {
    items: changed ? next : items,
    intent,
    changed,
  };
}
