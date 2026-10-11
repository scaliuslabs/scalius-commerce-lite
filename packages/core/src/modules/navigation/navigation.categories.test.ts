// The automatic departments: only categories a buyer can reach that lead to
// public products, top levels first, bounded, served by the layout batch.
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { getLayoutData } from "../storefront/storefront.service";
import { readStoreShape, selectStoreShapeCounts } from "../storefront/store-shape";
import { STORE_SHAPE_PRODUCTS, STORE_SHAPE_TREE } from "../storefront/store-shape.fixture";
import { categoryNavigationFromRows, readCategoryNavigation, selectCategoryNavigationRows, trimCategoryNavigation } from "./navigation.categories";

async function seeded() {
  const { sqlite, db } = createSqliteD1Database();
  for (const statement of [...STORE_SHAPE_TREE, ...STORE_SHAPE_PRODUCTS]) sqlite.exec(statement);
  await rebuildCatalogProjections(db);
  return { sqlite, db };
}

// The pre-optimization join is an independent oracle for subtree membership.
const originalRows = `SELECT node.id, node.name, node.slug, node.parent_id AS parentId,
  node.canonical_path AS canonicalPath, node.image_url AS imageUrl FROM categories node
  WHERE node.status = 'published' AND node.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM category_closure lineage
      INNER JOIN categories ancestor ON ancestor.id = lineage.ancestor_id
      WHERE lineage.descendant_id = node.id AND lineage.depth > 0
        AND (ancestor.status <> 'published' OR ancestor.deleted_at IS NOT NULL)
    )
    AND EXISTS (
      SELECT 1 FROM category_closure subtree
      INNER JOIN categories descendant ON descendant.id = subtree.descendant_id
      WHERE subtree.ancestor_id = node.id AND descendant.status = 'published' AND descendant.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM product_buyer_state p WHERE p.is_public = 1 AND p.category_id = descendant.id)
    )
  ORDER BY node.depth, node.name, node.id LIMIT ?`;

describe("category navigation", () => {
  it("is empty on an empty store", async () => {
    const { db } = createSqliteD1Database();
    await expect(readCategoryNavigation(db)).resolves.toEqual({ nodes: [], truncated: false });
  });

  it("lists reachable categories that lead to public products, top levels first", async () => {
    const { db } = await seeded();
    const tree = await readCategoryNavigation(db);
    // A (via A1a, and A2a1 through the listing's subtree rule) and F are
    // roots; B (inactive only), C (draft), E (draft child) and the empty A3,
    // A1b, A1a1 are not; A2 is a draft, so A2a is unreachable.
    expect(tree.nodes.map((node) => [node.id, node.parentId])).toEqual([
      ["A", null],
      ["F", null],
      ["A1", "A"],
      ["A1a", "A1"],
    ]);
    expect(tree.truncated).toBe(false);
    expect(tree.nodes[0]).toEqual({ id: "A", name: "A", slug: "a", parentId: null, canonicalPath: null, imageUrl: null });
    // The roots are exactly what the store shape counts.
    expect((await readStoreShape(db)).topCategoryCount).toBe(tree.nodes.filter((node) => !node.parentId).length);
  });

  it("follows publication and products", async () => {
    const { sqlite, db } = await seeded();
    sqlite.exec("UPDATE categories SET status = 'published' WHERE id = 'A2'");
    expect((await readCategoryNavigation(db)).nodes.map((node) => node.id)).toEqual(["A", "F", "A1", "A2", "A1a", "A2a", "A2a1"]);
    sqlite.exec("UPDATE categories SET deleted_at = 1 WHERE id = 'F'");
    expect((await readCategoryNavigation(db)).nodes.map((node) => node.id)).not.toContain("F");
  });

  it("preserves joined subtree membership for empty trees and hidden descendants or ancestors", async () => {
    const { sqlite, db } = createSqliteD1Database();
    try {
      const original = sqlite.prepare(originalRows);
      const check = async (ids: string[]) => {
        const expected = original.all(1001);
        expect(await selectCategoryNavigationRows(db)).toEqual(expected);
        expect(await selectCategoryNavigationRows(db, 2)).toEqual(original.all(3));
        expect((await readCategoryNavigation(db)).nodes.map(({ id }) => id)).toEqual(ids);
        expect((await selectStoreShapeCounts(db))[0]?.topCategoryCount)
          .toBe(expected.filter((row) => row.parentId === null).length);
      };
      await check([]);
      for (const statement of [...STORE_SHAPE_TREE, ...STORE_SHAPE_PRODUCTS]) sqlite.exec(statement);
      await rebuildCatalogProjections(db);
      await check(["A", "F", "A1", "A1a"]);
      for (const [write, ids] of [
        ["UPDATE categories SET status = 'published' WHERE id = 'A2'", ["A", "F", "A1", "A2", "A1a", "A2a", "A2a1"]],
        ["UPDATE categories SET status = 'draft' WHERE id = 'A1a'", ["A", "F", "A2", "A2a", "A2a1"]],
        ["UPDATE categories SET deleted_at = 1 WHERE id = 'A2a1'", ["F"]],
        ["UPDATE categories SET status = 'published' WHERE id = 'A1a'", ["A", "F", "A1", "A1a"]],
        // The root still leads to a public descendant; the hidden ancestor blocks its own navigation branch.
        ["UPDATE categories SET status = 'internal' WHERE id = 'A1'", ["A", "F"]],
        ["UPDATE categories SET status = 'published', deleted_at = 1 WHERE id = 'A1'", ["A", "F"]],
        ["UPDATE categories SET deleted_at = 1 WHERE id = 'A'", ["F"]],
        ["UPDATE product_buyer_state SET is_public = 0 WHERE product_id = 'p_f'", []],
      ] as const) {
        sqlite.exec(write);
        await check([...ids]);
      }
    } finally {
      sqlite.close();
    }
  });

  it("walks each indexed subtree before looking up its published categories", async () => {
    const { sqlite, db } = await seeded();
    try {
      for (const query of [selectCategoryNavigationRows(db).toSQL(), selectStoreShapeCounts(db).toSQL()]) {
        const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params as SQLInputValue[]) as Array<{ detail: string }>;
        const details = plan.map(({ detail }) => detail);
        const closure = details.findIndex((detail) => /^SEARCH subtree(?: EXISTS)? USING COVERING INDEX \S+ \(ancestor_id=\?\)$/.test(detail));
        const category = details.findIndex((detail) => /^SEARCH subtree_category(?: EXISTS)? USING INDEX \S+ \(id=\?\)/.test(detail));
        expect(closure, JSON.stringify(details)).toBeGreaterThanOrEqual(0);
        expect(category).toBeGreaterThan(closure);
        expect(details.some((detail) => /SEARCH subtree_category.*categories_public_idx/.test(detail))).toBe(false);
      }
    } finally {
      sqlite.close();
    }
  });

  it("is cut at its limit, parents before children", async () => {
    const { sqlite, db } = await seeded();
    sqlite.exec("UPDATE categories SET status = 'published' WHERE id = 'A2'");
    const tree = categoryNavigationFromRows(await selectCategoryNavigationRows(db, 3), 3);
    expect(tree).toMatchObject({ truncated: true });
    expect(tree.nodes.map((node) => node.id)).toEqual(["A", "F", "A1"]);
  });

  it("gives the header every root first, then each root's first children", () => {
    const nodes = [
      ...["a", "b", "c"].map((id) => ({ id, name: id, slug: id, parentId: null, canonicalPath: null, imageUrl: null })),
      ...["a", "b", "c"].flatMap((parent) =>
        [1, 2, 3].map((n) => ({ id: `${parent}${n}`, name: `${parent}${n}`, slug: `${parent}${n}`, parentId: parent, canonicalPath: null, imageUrl: null }))),
    ];
    const cut = trimCategoryNavigation({ nodes, truncated: false }, 7);
    expect(cut.truncated).toBe(true);
    expect(cut.nodes.map((node) => node.id)).toEqual(["a", "b", "c", "a1", "a2", "b1", "c1"]);
    expect(trimCategoryNavigation({ nodes, truncated: false }, 50).nodes).toHaveLength(12);
  });

  it("rides the layout batch", async () => {
    const { db } = await seeded();
    const layout = await getLayoutData(db);
    expect(layout.categoryTree).toEqual(await readCategoryNavigation(db));
  });
});
