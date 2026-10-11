// PostgreSQL parity for the category guards that read collection configs: the
// active dynamic collection check (hide, trash) and the permanent delete that
// removes a membership in the delete's own batch. Both read the config with
// json_valid() as a predicate, which PostgreSQL types as boolean. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable server; the test creates and drops
// its own database.
import { afterAll, describe, expect, it } from "vitest";

import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { ValidationError } from "@scalius/core/errors";

import { bulkDeleteCategories, updateCategoryStatus } from "./categories.service";
import { loadCategoryChildBlockers, loadCategoryTrashedParentBlockers } from "./categories.tree";

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

describe.runIf(postgresUrl)("category guards on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    it("blocks hiding or deleting a category an active dynamic collection reads, and prunes an inactive one", async () => {
        const { db, client } = await createNativePostgres({ label: "categories" });
        await client.query(`
            INSERT INTO categories (id, name, slug, status, revision, deleted_at) VALUES
                ('cat_delete', 'Delete', 'delete', 'draft', 1, 1700000000),
                ('cat_keep', 'Keep', 'keep', 'published', 1, NULL);
        `);
        const collection = (id: string, isActive: boolean, categoryIds: string[]) => client.query(
            "INSERT INTO collections (id, name, presentation, config, is_active) VALUES ($1, $1, 'grid', $2, $3)",
            [id, JSON.stringify({ source: "dynamic", categoryIds }), isActive ? 1 : 0],
        );
        const categoryExists = async (id: string) => (await client.query("SELECT 1 FROM categories WHERE id = $1", [id])).rowCount === 1;

        // Hiding: an active dynamic collection that lists the category refuses it.
        await collection("col_live", true, ["cat_keep"]);
        await expect(updateCategoryStatus(db, "cat_keep", { expectedRevision: 1, status: "draft" }))
            .rejects.toBeInstanceOf(ValidationError);
        await client.query("UPDATE collections SET is_active = 0 WHERE id = 'col_live'");
        await expect(updateCategoryStatus(db, "cat_keep", { expectedRevision: 1, status: "draft" }))
            .resolves.toMatchObject({ status: "draft" });

        // Permanent delete: an active dynamic collection would lose its source.
        await collection("col_featured", true, ["cat_delete"]);
        await expect(bulkDeleteCategories(db, [{ id: "cat_delete", expectedRevision: 1 }], true)).rejects.toThrow("without a source");
        expect(await categoryExists("cat_delete")).toBe(true);

        // An inactive one only loses that membership, in the delete's own batch.
        await client.query("UPDATE collections SET is_active = 0 WHERE id = 'col_featured'");
        await collection("col_seasonal", false, ["cat_delete", "cat_keep"]);
        await bulkDeleteCategories(db, [{ id: "cat_delete", expectedRevision: 1 }], true);
        expect(await categoryExists("cat_delete")).toBe(false);
        const configs = (await client.query("SELECT id, config, version FROM collections WHERE id IN ('col_seasonal', 'col_featured') ORDER BY id")).rows;
        expect(configs.map((row) => [row.id, JSON.parse(row.config), row.version])).toEqual([
            ["col_featured", { source: "dynamic", categoryIds: [] }, expect.any(Number)],
            ["col_seasonal", { source: "dynamic", categoryIds: ["cat_keep"] }, 2],
        ]);

        await client.query(`INSERT INTO categories (id,name,slug,parent_id) VALUES
          ('cat_parent','Parent','parent',NULL),('cat_child','Child','child','cat_parent')`);
        const expected = [{ id: "cat_child", name: "Child", parentId: "cat_parent" }];
        expect(await loadCategoryChildBlockers(db, JSON.stringify([{ id: "cat_parent" }]), { liveOnly: true })).toEqual(expected);
        await client.query("UPDATE categories SET deleted_at = 1 WHERE id = 'cat_parent'");
        expect(await loadCategoryTrashedParentBlockers(db, JSON.stringify([{ id: "cat_child" }]))).toEqual(expected);
    });
});
