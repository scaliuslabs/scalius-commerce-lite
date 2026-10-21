// A collection's handle (migration 0170): derived from the name on create and
// suffixed until free (trash included), typed ones refused when taken, and
// changed on edit under the version.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createCollection, updateCollection } from "./collections.service";
import { createCollectionSchema, updateCollectionSchema } from "./collections.validation";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

describe("collection handles", () => {
    it("derive from the name, stay unique and change on edit", async () => {
        const harness = createSqliteD1Database();
        sqlite = harness.sqlite;
        const db = harness.db;
        const draft = { name: "Hot Deals", presentation: "grid", isActive: false, config: { source: "manual" } };

        const first = await createCollection(db, createCollectionSchema.parse(draft));
        const second = await createCollection(db, createCollectionSchema.parse(draft));
        expect([first.slug, second.slug]).toEqual(["hot-deals", "hot-deals-2"]);
        harness.sqlite.exec(`UPDATE collections SET deleted_at = unixepoch() WHERE id = '${second.id}'`);
        // A trashed collection keeps its handle.
        expect((await createCollection(db, createCollectionSchema.parse(draft))).slug).toBe("hot-deals-3");

        await expect(createCollection(db, createCollectionSchema.parse({ ...draft, slug: "hot-deals-2" }))).rejects.toThrow(/handle/);
        const typed = await createCollection(db, createCollectionSchema.parse({ ...draft, slug: "eid-picks" }));
        expect(typed.slug).toBe("eid-picks");

        const renamed = await updateCollection(db, first.id, updateCollectionSchema.parse({ expectedVersion: first.version, slug: "deals" }));
        expect(renamed.slug).toBe("deals");
        await expect(updateCollection(db, first.id, updateCollectionSchema.parse({ expectedVersion: renamed.version, slug: "eid-picks" }))).rejects.toThrow(/handle/);
        expect(createCollectionSchema.safeParse({ ...draft, slug: "Hot Deals" }).success).toBe(false);
    });
});
