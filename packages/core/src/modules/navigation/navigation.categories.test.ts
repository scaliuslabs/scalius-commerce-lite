// The automatic departments: only categories a buyer can reach that lead to
// public products, top levels first, bounded, served by the layout batch.
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { getLayoutData } from "../storefront/storefront.service";
import { readStoreShape } from "../storefront/store-shape";
import { STORE_SHAPE_PRODUCTS, STORE_SHAPE_TREE } from "../storefront/store-shape.fixture";
import { categoryNavigationFromRows, readCategoryNavigation, selectCategoryNavigationRows } from "./navigation.categories";

async function seeded() {
  const { sqlite, db } = createSqliteD1Database();
  for (const statement of [...STORE_SHAPE_TREE, ...STORE_SHAPE_PRODUCTS]) sqlite.exec(statement);
  await rebuildCatalogProjections(db);
  return { sqlite, db };
}

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

  it("is cut at its limit, parents before children", async () => {
    const { sqlite, db } = await seeded();
    sqlite.exec("UPDATE categories SET status = 'published' WHERE id = 'A2'");
    const tree = categoryNavigationFromRows(await selectCategoryNavigationRows(db, 3), 3);
    expect(tree).toMatchObject({ truncated: true });
    expect(tree.nodes.map((node) => node.id)).toEqual(["A", "F", "A1"]);
  });

  it("rides the layout batch", async () => {
    const { db } = await seeded();
    const layout = await getLayoutData(db);
    expect(layout.categoryTree).toEqual(await readCategoryNavigation(db));
  });
});
