/** A category as the form options list it: enough to draw the tree. */
export interface CategoryTreeNode {
  id: string;
  name: string;
  parentId?: string | null;
  depth?: number;
}

export const CATEGORY_PATH_SEPARATOR = " › ";

/** Names from the top level down to the category itself (the stored path, as names). */
export function categoryPathNames(id: string, byId: ReadonlyMap<string, CategoryTreeNode>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  // The database refuses cycles; the guard only keeps a stale list from looping.
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names;
}

export function categoryPathLabel(id: string, byId: ReadonlyMap<string, CategoryTreeNode>): string {
  return categoryPathNames(id, byId).join(CATEGORY_PATH_SEPARATOR);
}

export function indexCategories<T extends CategoryTreeNode>(categories: readonly T[]): Map<string, T> {
  return new Map(categories.map((category) => [category.id, category]));
}

/** The categories in tree order (each parent followed by its children, names A–Z). */
export function categoriesInTreeOrder<T extends CategoryTreeNode>(categories: readonly T[]): T[] {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(categories.map((category) => category.id));
  for (const category of categories) {
    // A parent missing from the list (trashed) shows its children at the top level.
    const parent = category.parentId && ids.has(category.parentId) ? category.parentId : null;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(category);
    byParent.set(parent, siblings);
  }
  const ordered: T[] = [];
  const visit = (parent: string | null) => {
    const children = (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      ordered.push(child);
      visit(child.id);
    }
  };
  visit(null);
  return ordered;
}

/** How many levels sit below the category (0 for a leaf). */
export function subtreeHeight(id: string, categories: readonly CategoryTreeNode[]): number {
  const children = new Map<string, string[]>();
  for (const category of categories) {
    if (!category.parentId) continue;
    const list = children.get(category.parentId) ?? [];
    list.push(category.id);
    children.set(category.parentId, list);
  }
  const height = (node: string, guard: number): number =>
    guard > 4 ? 0 : Math.max(0, ...(children.get(node) ?? []).map((child) => 1 + height(child, guard + 1)));
  return height(id, 0);
}

/** The category itself and everything under it. */
export function subtreeIds(id: string, categories: readonly CategoryTreeNode[]): Set<string> {
  const inside = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const category of categories) {
      if (category.parentId && inside.has(category.parentId) && !inside.has(category.id)) {
        inside.add(category.id);
        grew = true;
      }
    }
  }
  return inside;
}
