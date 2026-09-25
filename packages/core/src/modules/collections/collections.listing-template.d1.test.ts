// `collections.listing_template` (0090): NULL is the theme's default listing.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createCollection, getCollectionSection, listCollections, updateCollection } from "./collections.service";
import { createCollectionSchema, updateCollectionSchema } from "./collections.validation";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

describe("collection listing template", () => {
    it("is assigned on create and edit, cleared with null, and kept when omitted", async () => {
        const harness = createSqliteD1Database();
        sqlite = harness.sqlite;
        const db = harness.db;
        const draft = { name: "Eid picks", presentation: "grid", isActive: false, config: { source: "manual" } };

        const plain = await createCollection(db, createCollectionSchema.parse(draft));
        expect(plain.listingTemplate).toBeNull();
        const created = await createCollection(db, createCollectionSchema.parse({ ...draft, listingTemplate: "shelves" }));
        expect(created.listingTemplate).toBe("shelves");

        const renamed = await updateCollection(db, created.id, updateCollectionSchema.parse({ expectedVersion: created.version, name: "Eid gifts" }));
        expect(renamed.listingTemplate).toBe("shelves");
        const cleared = await updateCollection(db, created.id, updateCollectionSchema.parse({ expectedVersion: renamed.version, listingTemplate: null }));
        expect(cleared.listingTemplate).toBeNull();
        await updateCollection(db, created.id, updateCollectionSchema.parse({ expectedVersion: cleared.version, listingTemplate: "grid-dense" }));

        await expect(getCollectionSection(db, created.id, "summary")).resolves.toMatchObject({ collection: { listingTemplate: "grid-dense" } });
        const listed = await listCollections(db, { page: 1, limit: 10 });
        expect(listed.collections.map((row) => row.listingTemplate).sort()).toEqual(["grid-dense", null].sort());

        for (const listingTemplate of ["Shelves", "grid_dense", "", "x".repeat(41)]) {
            expect(updateCollectionSchema.safeParse({ expectedVersion: 1, listingTemplate }).success, listingTemplate).toBe(false);
        }
    });
});
