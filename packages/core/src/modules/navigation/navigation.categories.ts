// The category tree as the storefront's automatic departments (theme
// `blocks.navigation.source` = `category-tree` or `tree+menu`, and the
// `/categories` index). One bounded statement that joins the layout batch.
//
// A node is listed when a buyer can reach it and it leads somewhere: it is
// published and live, every ancestor is too (`category_closure`), and its
// published subtree holds a public product (`product_buyer_state.is_public`),
// the same rule the store shape counts roots with (store-shape.ts
// `topCategoryCount`), so the theme facts and the rendered tree agree.
// Rows come top levels first (depth, then name), so a cut at the limit keeps
// every parent of a kept node.
import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

/** Rows one read considers (top levels first); the `/categories` index lists them all. */
export const CATEGORY_NAVIGATION_NODE_LIMIT = 1000;
/**
 * Nodes the layout carries: the header never renders more than the
 * navigation link budget (150 anchors) across all its surfaces.
 */
export const CATEGORY_NAVIGATION_LAYOUT_NODES = 150;

export interface CategoryNavigationNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  /** A same-store `/categories/<slug>` override; null uses the slug route. */
  canonicalPath: string | null;
  imageUrl: string | null;
}

export interface CategoryNavigationTree {
  nodes: CategoryNavigationNode[];
  /** More nodes qualify than the layout carries (the deepest levels are cut first). */
  truncated: boolean;
}

const published = (alias: string) => sql.raw(`${alias}."status" = 'published' AND ${alias}."deleted_at" IS NULL`);

/**
 * The reachable tree, top levels first, at most `limit + 1` rows (the extra
 * row only says the tree was cut). Columns are qualified by hand: drizzle
 * renders a column inside a raw subquery unqualified.
 */
export function selectCategoryNavigationRows(db: Database, limit = CATEGORY_NAVIGATION_NODE_LIMIT) {
  return db
    .select({
      id: sql<string>`node."id"`,
      name: sql<string>`node."name"`,
      slug: sql<string>`node."slug"`,
      parentId: sql<string | null>`node."parent_id"`,
      canonicalPath: sql<string | null>`node."canonical_path"`,
      imageUrl: sql<string | null>`node."image_url"`,
    })
    .from(sql`"categories" AS node`)
    .where(sql`${published("node")}
      AND NOT EXISTS (
        SELECT 1 FROM "category_closure" lineage
        INNER JOIN "categories" lineage_category ON lineage_category."id" = lineage."ancestor_id"
        WHERE lineage."descendant_id" = node."id" AND lineage."depth" > 0
          AND (lineage_category."status" <> 'published' OR lineage_category."deleted_at" IS NOT NULL)
      )
      AND EXISTS (
        SELECT 1 FROM "category_closure" subtree
        INNER JOIN "categories" subtree_category ON subtree_category."id" = subtree."descendant_id"
        WHERE subtree."ancestor_id" = node."id" AND ${published("subtree_category")}
          AND EXISTS (
            SELECT 1 FROM "product_buyer_state" own_product
            WHERE own_product."is_public" = 1 AND own_product."category_id" = subtree_category."id"
          )
      )`)
    .orderBy(sql`node."depth"`, sql`node."name"`, sql`node."id"`)
    .limit(limit + 1);
}

type Row = { id: string; name: string; slug: string; parentId: string | null; canonicalPath: string | null; imageUrl: string | null };

/** The tree from the rows (the extra row marks it truncated). */
export function categoryNavigationFromRows(rows: readonly Row[], limit = CATEGORY_NAVIGATION_NODE_LIMIT): CategoryNavigationTree {
  return {
    nodes: rows.slice(0, limit).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug),
      parentId: row.parentId ?? null,
      canonicalPath: row.canonicalPath?.trim() || null,
      imageUrl: row.imageUrl?.trim() || null,
    })),
    truncated: rows.length > limit,
  };
}

/** The whole reachable tree (bounded), for the `/categories` index. */
export async function readCategoryNavigation(db: Database): Promise<CategoryNavigationTree> {
  return categoryNavigationFromRows(await selectCategoryNavigationRows(db));
}

/**
 * The tree cut to `maxNodes` for the header: level by level, round-robin
 * across parents, so every root comes first and each keeps its first
 * children (the rows arrive parents first, so a kept node's parent is kept).
 */
export function trimCategoryNavigation(tree: CategoryNavigationTree, maxNodes = CATEGORY_NAVIGATION_LAYOUT_NODES): CategoryNavigationTree {
  if (tree.nodes.length <= maxNodes) return tree;
  const byParent = new Map<string | null, CategoryNavigationNode[]>();
  for (const node of tree.nodes) byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);
  const kept = new Set<string>();
  let level: Array<string | null> = [null];
  while (level.length > 0 && kept.size < maxNodes) {
    const queues = level.map((parent) => byParent.get(parent) ?? []).filter((queue) => queue.length > 0);
    const next: string[] = [];
    for (let rank = 0; kept.size < maxNodes && queues.some((queue) => rank < queue.length); rank += 1) {
      for (const queue of queues) {
        const node = queue[rank];
        if (!node || kept.size >= maxNodes) continue;
        kept.add(node.id);
        next.push(node.id);
      }
    }
    level = next;
  }
  return { nodes: tree.nodes.filter((node) => kept.has(node.id)), truncated: true };
}
