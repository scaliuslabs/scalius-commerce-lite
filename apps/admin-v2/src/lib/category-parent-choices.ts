import { categoryPlacementProblem } from "@scalius/shared/catalog-tree";
import { categoriesInTreeOrder, subtreeHeight, subtreeIds, type CategoryTreeNode } from "./category-tree";

/**
 * Where a category may go: every other category that is not inside it and
 * keeps the tree within four levels, in tree order. The server (and its
 * trigger) stay the authority; this only keeps refused choices off the list.
 */
export function parentChoices<T extends CategoryTreeNode>(selfId: string | undefined, categories: readonly T[]): T[] {
  const inside = selfId ? subtreeIds(selfId, categories) : new Set<string>();
  const height = selfId ? subtreeHeight(selfId, categories) : 0;
  return categoriesInTreeOrder(categories).filter((category) =>
    categoryPlacementProblem({
      parentDepth: category.depth ?? 0,
      subtreeHeight: height,
      parentIsInSubtree: inside.has(category.id),
    }) === null,
  );
}
