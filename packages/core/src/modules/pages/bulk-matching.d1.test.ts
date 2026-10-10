import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { bulkDeletePages, listMatchingPageClaims, restorePages } from "./pages.service";

const harnesses: Array<{ sqlite: { close(): void } }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

describe("all matching blog posts (T11)", () => {
    it("trashes and restores every post the filter matches, slice by slice, and leaves pages alone", async () => {
        const harness = createSqliteD1Database();
        harnesses.push(harness);
        const insert = harness.sqlite.prepare("INSERT INTO pages (id, title, slug, content, content_type) VALUES (?, ?, ?, '', ?)");
        harness.sqlite.exec("BEGIN");
        for (let index = 0; index < 200; index += 1) {
            insert.run(`pg_${String(index).padStart(4, "0")}`, `Post ${index}`, `post-${index}`, index < 190 ? "article" : "page");
        }
        harness.sqlite.exec("COMMIT");
        const { db } = harness;

        const walk = async (trashed: boolean, write: (claims: Array<{ id: string; expectedRevision: number }>) => Promise<void>) => {
            let done = 0;
            let cursor: string | undefined;
            for (let guard = 0; guard < 50; guard += 1) {
                const slice = await listMatchingPageClaims(db, { contentType: "article", showTrashed: trashed }, cursor);
                if (slice.claims.length > 0) await write(slice.claims);
                done += slice.claims.length;
                if (!slice.next) return done;
                cursor = slice.next;
            }
            throw new Error("the walk never ended");
        };

        expect(await walk(false, (claims) => bulkDeletePages(db, claims, false))).toBe(190);
        expect((await listMatchingPageClaims(db, { contentType: "article" }, undefined)).claims).toEqual([]);
        expect((await listMatchingPageClaims(db, { contentType: "page" }, undefined)).claims).toHaveLength(10);
        expect(await walk(true, (claims) => restorePages(db, claims))).toBe(190);
    });
});
