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
