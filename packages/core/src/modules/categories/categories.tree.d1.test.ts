import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import { afterEach, describe, expect, it } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import { createCategorySchema, updateCategorySchema } from "./categories.validation";
import {
    bulkDeleteCategories,
    createCategory,
    getCategoryById,
    restoreCategories,
    updateCategory,
} from "./categories.service";
import { CategoryRevisionConflictError, CategoryStateConflictError } from "./categories.revision";
import {
    CATEGORY_TREE_LINK_LIMIT,
    CategoryPlacementError,
    getCategoryAncestors,
    getPublicCategoryBreadcrumb,
    getPublicCategoryChildren,
    getPublicCategoryTree,
    listCategoryChildren,
    moveCategory,
} from "./categories.tree";
import { getPublicCategoryBySlug } from "./categories.storefront";
import { getStorefrontCategoryProducts } from "../catalog/listing";

type Captured = { sql: string; params: readonly SQLInputValue[] };

let sqlite: DatabaseSync | null = null;
afterEach(() => {
    sqlite?.close();
    sqlite = null;
});

function database(onQuery?: (sql: string, params: readonly SQLInputValue[]) => void) {
    const harness = createSqliteD1Database(onQuery ? { onQuery } : {});
    sqlite = harness.sqlite;
    return harness.db;
}

function fields(name: string, slug: string, extra: Record<string, unknown> = {}) {
    return createCategorySchema.parse({
        name,
        slug,
        description: null,
        metaTitle: null,
        metaDescription: null,
        image: null,
        status: "published",
        ...extra,
    });
}

async function create(db: Database, name: string, slug: string, parentId: string | null = null) {
    return (await createCategory(db, fields(name, slug, { parentId }))).id;
}

function shape(id: string) {
    return { ...(sqlite!.prepare("SELECT parent_id AS parentId, depth, path, revision FROM categories WHERE id = ?").get(id) as object) };
}

function closure(id: string) {
    return sqlite!.prepare(
        "SELECT ancestor_id AS ancestor, depth FROM category_closure WHERE descendant_id = ? ORDER BY depth",
    ).all(id).map((row) => ({ ...row }));
}

async function refusal(promise: Promise<unknown>) {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CategoryPlacementError);
    return (error as CategoryPlacementError).reason;
}

async function chain(db: Database, levels: number) {
    const ids: string[] = [];
    for (let level = 0; level < levels; level += 1) {
        ids.push(await create(db, `Level ${level}`, `level-${level}`, ids.at(-1) ?? null));
    }
    return ids;
}

describe("category tree writes through the service", () => {
    it("places a new category under its parent and keeps depth, path and closure from the triggers", async () => {
        const db = database();
        const [root, child] = await chain(db, 2);

        expect(shape(child!)).toEqual({ parentId: root, depth: 1, path: `/${root}/${child}/`, revision: 1 });
        expect(closure(child!)).toEqual([{ ancestor: child, depth: 0 }, { ancestor: root, depth: 1 }]);
        expect(await getCategoryAncestors(db, child!)).toMatchObject([{ id: root, depth: 0 }, { id: child, depth: 1 }]);
        const detail = await getCategoryById(db, child!);
        expect(detail).toMatchObject({ parentId: root, depth: 1, listingTemplate: null });
    });

    it("refuses a cycle: under itself or under one of its descendants", async () => {
        const db = database();
        const [root, child, grandchild] = await chain(db, 3);

        expect(await refusal(moveCategory(db, root!, { expectedRevision: 1, parentId: root! }))).toBe("cycle");
        expect(await refusal(moveCategory(db, root!, { expectedRevision: 1, parentId: grandchild! }))).toBe("cycle");
        expect(await refusal(updateCategory(db, root!, updateCategorySchema.parse({
            ...fields("Level 0", "level-0"),
            expectedRevision: 1,
            status: "published",
            parentId: child,
        })))).toBe("cycle");
        expect(shape(root!)).toMatchObject({ parentId: null, depth: 0, revision: 1 });
    });

    it("refuses a fifth level on create and on a move of a whole subtree", async () => {
        const db = database();
        const levels = await chain(db, 4);
        expect(await refusal(createCategory(db, fields("Too deep", "too-deep", { parentId: levels[3] })))).toBe("too_deep");

        // A two-level subtree fits under depth 1 (reaching depth 3) but not under depth 2.
        const top = await create(db, "Other", "other");
        const leaf = await create(db, "Other leaf", "other-leaf", top);
        expect(await refusal(moveCategory(db, top, { expectedRevision: 1, parentId: levels[2]! }))).toBe("too_deep");
        await expect(moveCategory(db, top, { expectedRevision: 1, parentId: levels[1]! }))
            .resolves.toEqual({ revision: 2, parentId: levels[1], changed: true });
        expect(shape(leaf)).toMatchObject({ depth: 3, path: `/${levels[0]}/${levels[1]}/${top}/${leaf}/` });
        expect(closure(leaf).map((row) => row.ancestor)).toEqual([leaf, top, levels[1], levels[0]]);
    });

    it("refuses a trashed or missing parent", async () => {
        const db = database();
        const parent = await create(db, "Seasonal", "seasonal");
        const other = await create(db, "Gifts", "gifts");
        await bulkDeleteCategories(db, [{ id: parent, expectedRevision: 1 }]);

        expect(await refusal(createCategory(db, fields("Eid", "eid", { parentId: parent })))).toBe("parent_unavailable");
        expect(await refusal(createCategory(db, fields("Eid", "eid", { parentId: "cat_missing" })))).toBe("parent_unavailable");
        expect(await refusal(moveCategory(db, other, { expectedRevision: 1, parentId: parent }))).toBe("parent_unavailable");
    });

    it("refuses a stale revision and a trashed category", async () => {
        const db = database();
        const [root, child] = await chain(db, 2);
        const other = await create(db, "Other", "other");

        await expect(moveCategory(db, child!, { expectedRevision: 7, parentId: other }))
            .rejects.toBeInstanceOf(CategoryRevisionConflictError);
        await moveCategory(db, child!, { expectedRevision: 1, parentId: other });
        await expect(moveCategory(db, child!, { expectedRevision: 1, parentId: root! }))
            .rejects.toBeInstanceOf(CategoryRevisionConflictError);
        expect(shape(child!)).toMatchObject({ parentId: other, revision: 2 });

        await bulkDeleteCategories(db, [{ id: child!, expectedRevision: 2 }]);
        await expect(moveCategory(db, child!, { expectedRevision: 3, parentId: null }))
            .rejects.toBeInstanceOf(CategoryStateConflictError);
    });

    it("keeps the revision when the parent does not change, and moves back to the top level", async () => {
        const db = database();
        const [root, child] = await chain(db, 2);
        await expect(moveCategory(db, child!, { expectedRevision: 1, parentId: root! }))
            .resolves.toEqual({ revision: 1, parentId: root, changed: false });
        await expect(moveCategory(db, child!, { expectedRevision: 1, parentId: null }))
            .resolves.toEqual({ revision: 2, parentId: null, changed: true });
        expect(shape(child!)).toMatchObject({ depth: 0, path: `/${child}/` });
        expect(closure(child!)).toEqual([{ ancestor: child, depth: 0 }]);
    });

    it("leaves the trigger as the authority when the parent is trashed after the pre-check", async () => {
        let raced = false;
        let target = "";
        const db = database((query, params) => {
            if (raced || !/^update "categories" set .*"parent_id" = \?/i.test(query) || !params.includes(target)) return;
            raced = true;
            sqlite!.prepare("UPDATE categories SET deleted_at = unixepoch() WHERE id = ?").run(target);
        });
        target = await create(db, "Target", "target");
        const moved = await create(db, "Moved", "moved");

        expect(await refusal(moveCategory(db, moved, { expectedRevision: 1, parentId: target }))).toBe("parent_unavailable");
        expect(raced).toBe(true);
        expect(shape(moved)).toMatchObject({ parentId: null, revision: 1 });
    });
});

describe("category trash rules", () => {
    it("refuses to trash a category with live sub-categories unless they go in the same selection", async () => {
        const db = database();
        const [root, child] = await chain(db, 2);

        const error = await bulkDeleteCategories(db, [{ id: root!, expectedRevision: 1 }]).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).details).toMatchObject({ subcategories: [{ id: child }] });

        await bulkDeleteCategories(db, [{ id: root!, expectedRevision: 1 }, { id: child!, expectedRevision: 1 }]);
        expect(shape(child!)).toMatchObject({ parentId: root, depth: 1 });
    });

    it("refuses to restore a sub-category whose parent stays in trash", async () => {
        const db = database();
        const [root, child] = await chain(db, 2);
        await bulkDeleteCategories(db, [{ id: root!, expectedRevision: 1 }, { id: child!, expectedRevision: 1 }]);

        await expect(restoreCategories(db, [{ id: child!, expectedRevision: 2 }])).rejects.toBeInstanceOf(ValidationError);
        await restoreCategories(db, [{ id: root!, expectedRevision: 2 }, { id: child!, expectedRevision: 2 }]);
        expect(sqlite!.prepare("SELECT count(*) AS live FROM categories WHERE deleted_at IS NULL").get()).toEqual({ live: 2 });
    });

    it("deletes a trashed subtree permanently only as a whole, deepest first", async () => {
        const db = database();
        const [root, child, grandchild] = await chain(db, 3);
        const claims = [
            { id: root!, expectedRevision: 1 },
            { id: child!, expectedRevision: 1 },
            { id: grandchild!, expectedRevision: 1 },
        ];
        await bulkDeleteCategories(db, claims);
        const trashed = claims.map((claim) => ({ ...claim, expectedRevision: 2 }));

        await expect(bulkDeleteCategories(db, trashed.slice(0, 2), true)).rejects.toBeInstanceOf(ValidationError);
        await bulkDeleteCategories(db, trashed, true);
        expect(sqlite!.prepare("SELECT count(*) AS rows FROM categories").get()).toEqual({ rows: 0 });
        expect(sqlite!.prepare("SELECT count(*) AS rows FROM category_closure").get()).toEqual({ rows: 0 });
    });
});

describe("category tree reads", () => {
    function seedStore(db: Database) {
        return (async () => {
            const [electronics, phones, android] = await chain(db, 3);
            const hidden = await create(db, "Hidden", "hidden", electronics);
            const underHidden = await create(db, "Under hidden", "under-hidden", hidden);
            sqlite!.exec(`UPDATE categories SET status = 'draft' WHERE id = '${hidden}'`);
            sqlite!.exec(`
                INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at) VALUES
                    ('prod_root', 'Root item', 1000, 'root-item', '${electronics}', 1, 1700000003),
                    ('prod_leaf', 'Leaf item', 2000, 'leaf-item', '${android}', 1, 1700000002),
                    ('prod_hidden', 'Hidden item', 3000, 'hidden-item', '${hidden}', 1, 1700000001);
                INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES
                    ('var_root', 'prod_root', 'SKU-ROOT', 1000, 3, 1, 1),
                    ('var_leaf', 'prod_leaf', 'SKU-LEAF', 2000, 3, 1, 1),
                    ('var_hidden', 'prod_hidden', 'SKU-HIDDEN', 3000, 3, 1, 1);
            `);
            return { electronics: electronics!, phones: phones!, android: android!, hidden, underHidden };
        })();
    }

    it("serves the storefront tree top levels first and hides branches under a hidden category", async () => {
        const db = database();
        const store = await seedStore(db);
        const tree = await getPublicCategoryTree(db);

        expect(tree.truncated).toBe(false);
        expect(tree.nodes.map((node) => [node.id, node.parentId, node.depth])).toEqual([
            [store.electronics, null, 0],
            [store.phones, store.electronics, 1],
            [store.android, store.phones, 2],
        ]);
    });

    it(`caps the storefront tree at ${CATEGORY_TREE_LINK_LIMIT} links, never cutting a parent before its children`, async () => {
        const db = database();
        const values = Array.from({ length: CATEGORY_TREE_LINK_LIMIT + 10 }, (_, index) =>
            `('cat_bulk_${String(index).padStart(3, "0")}', 'Bulk ${String(index).padStart(3, "0")}', 'bulk-${index}', 'published')`);
        sqlite!.exec(`INSERT INTO categories (id, name, slug, status) VALUES ${values.join(", ")}`);
        const root = await create(db, "AAA root", "aaa-root");
        await create(db, "Child", "child-of-root", root);

        const tree = await getPublicCategoryTree(db);
        expect(tree.truncated).toBe(true);
        expect(tree.nodes).toHaveLength(CATEGORY_TREE_LINK_LIMIT);
        expect(tree.nodes.every((node) => node.depth === 0)).toBe(true);
    });

    it("reads children, breadcrumbs and the category page's tree context", async () => {
        const db = database();
        const store = await seedStore(db);

        expect((await getPublicCategoryChildren(db, "level-0")).map((child) => child.id)).toEqual([store.phones]);
        expect((await listCategoryChildren(db, store.electronics)).map((child) => [child.id, child.childCount]))
            .toEqual([[store.hidden, 1], [store.phones, 1]]);
        expect((await getPublicCategoryBreadcrumb(db, "level-2")).map((item) => item.id))
            .toEqual([store.electronics, store.phones, store.android]);
        // A hidden ancestor is left out of the public breadcrumb.
        sqlite!.exec(`UPDATE categories SET status = 'published' WHERE id = '${store.hidden}'`);
        sqlite!.exec(`UPDATE categories SET status = 'published' WHERE id = '${store.underHidden}'`);
        sqlite!.exec(`UPDATE categories SET status = 'draft' WHERE id = '${store.hidden}'`);
        expect((await getPublicCategoryBreadcrumb(db, "under-hidden")).map((item) => item.id))
            .toEqual([store.electronics, store.underHidden]);

        const page = await getPublicCategoryBySlug(db, "level-0");
        expect(page).toMatchObject({ id: store.electronics, parentId: null, depth: 0 });
        expect(page!.children.map((child) => child.id)).toEqual([store.phones]);
        expect(page!.breadcrumb.map((item) => item.id)).toEqual([store.electronics]);
    });

    it("lists a category's published subtree, leaving out a draft descendant's products", async () => {
        const db = database();
        const store = await seedStore(db);
        const category = await getPublicCategoryBySlug(db, "level-0");

        const flat = await getStorefrontCategoryProducts(db, category!, { page: 1, limit: 20 });
        const subtree = await getStorefrontCategoryProducts(db, category!, { page: 1, limit: 20 }, { includeDescendants: true });

        expect(flat.products.map((product) => product.id)).toEqual(["prod_root"]);
        expect(subtree.products.map((product) => [product.id, product.category?.id])).toEqual([
            ["prod_root", store.electronics],
            ["prod_leaf", store.android],
        ]);
    });
});

describe("category tree read plans", () => {
    it("reads every tree statement through an index with at most 90 bound parameters", async () => {
        const queries: Captured[] = [];
        const db = database((sql, params) => queries.push({ sql, params }));
        const [root] = await chain(db, 3);
        queries.length = 0;

        await getPublicCategoryTree(db);
        await getPublicCategoryChildren(db, "level-0");
        await getPublicCategoryBreadcrumb(db, "level-2");
        await getPublicCategoryBySlug(db, "level-1");
        await listCategoryChildren(db, root!);
        await moveCategory(db, root!, { expectedRevision: 1, parentId: null });

        expect(queries.length).toBeGreaterThan(0);
        for (const query of queries) {
            expect(query.params.length).toBeLessThanOrEqual(90);
            if (!/^\s*select/i.test(query.sql)) continue;
            const plan = sqlite!.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params)
                .map((step) => String(step.detail)).join("\n");
            expect(plan, query.sql).not.toMatch(/SCAN category_closure\b/);
        }
    });
});
