/**
 * Category tree and template-assignment rules shared by the API, the
 * dashboard and the storefront (migration 0088).
 *
 * The database is the authority: triggers keep `categories.depth`, the id
 * `path` ('/root/child/') and `category_closure` exact from `parent_id`
 * alone, and refuse cycles, trashed parents and a fifth level. These helpers
 * let callers explain a refusal before they send it and read the stored path.
 */
import { z } from "zod";

/** Deepest 0-based depth: a tree has at most four levels. */
export const CATEGORY_TREE_MAX_DEPTH = 3;
export const CATEGORY_TREE_MAX_LEVELS = CATEGORY_TREE_MAX_DEPTH + 1;

/** The ancestor ids of a stored path, root first, ending with the category itself. */
export function categoryPathIds(path: string): string[] {
  if (!path.startsWith("/") || !path.endsWith("/") || path.length < 3) {
    throw new RangeError("A category path is '/root/…/self/'.");
  }
  const ids = path.slice(1, -1).split("/");
  if (ids.some((id) => id.length === 0) || ids.length > CATEGORY_TREE_MAX_LEVELS) {
    throw new RangeError("A category path has one to four non-empty segments.");
  }
  return ids;
}

/** The 0-based depth a stored path encodes. */
export function categoryDepthFromPath(path: string): number {
  return categoryPathIds(path).length - 1;
}

export type CategoryPlacementProblem = "cycle" | "too_deep";

/**
 * Why moving a category (whose subtree is `subtreeHeight` levels below it,
 * 0 for a leaf) under a parent at `parentDepth` would be refused, or null.
 * `parentDepth` is null for a move to the root. `parentIsInSubtree` is true
 * when the new parent is the category itself or one of its descendants.
 */
export function categoryPlacementProblem(input: {
  parentDepth: number | null;
  subtreeHeight: number;
  parentIsInSubtree: boolean;
}): CategoryPlacementProblem | null {
  if (input.parentIsInSubtree) return "cycle";
  const depth = input.parentDepth === null ? 0 : input.parentDepth + 1;
  return depth + input.subtreeHeight > CATEGORY_TREE_MAX_DEPTH ? "too_deep" : null;
}

/**
 * A product page or listing configuration named in the theme document
 * (`products.page_template`, `categories/collections/brands.listing_template`).
 * NULL means the theme's default for that page type.
 */
export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const templateIdSchema = z.string().regex(TEMPLATE_ID_PATTERN, "Use lowercase letters, numbers and dashes.");
export const templateAssignmentSchema = templateIdSchema.nullable();
export type TemplateAssignment = z.infer<typeof templateAssignmentSchema>;
