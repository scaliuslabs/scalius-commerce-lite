// A write that sets a row to the values it already has leaves `updated_at`
// (a sitemap lastmod) and the lastmod cache key alone; a real change moves both.
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { categories, pages } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { truthfulUpdatedAt } from "./truthful-updated-at";

describe("truthfulUpdatedAt", () => {
    it("moves updated_at (and lm:seo) only when a set column really changes", async () => {
        const { sqlite, db } = createSqliteD1Database();
        sqlite.exec(`
            INSERT INTO categories (id, name, slug, status, no_index, updated_at) VALUES ('cat_a', 'A', 'a', 'published', 0, 1700000000);
            INSERT INTO pages (id, title, slug, content, is_published, updated_at) VALUES ('pg_a', 'About', 'about', '<p>x</p>', 1, 1700000000);
        `);
        const lastmodSeq = () => (sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = 'lm:seo'").get() as { seq: number } | undefined)?.seq ?? 0;
        const before = lastmodSeq();
        const save = (values: Record<string, unknown>) => db.update(categories)
            .set(truthfulUpdatedAt(categories, { ...values, revision: sql`${categories.revision} + 1`, updatedAt: sql`unixepoch()` }))
            .where(eq(categories.id, "cat_a")).run();

        // Same values (a boolean, a null and text): revision moves, lastmod does not.
        await save({ name: "A", status: "published", noIndex: false, description: null });
        expect(sqlite.prepare("SELECT revision, updated_at AS updatedAt FROM categories").get()).toEqual({ revision: 2, updatedAt: 1700000000 });
        expect(lastmodSeq()).toBe(before);
        await db.update(pages).set(truthfulUpdatedAt(pages, { title: "About", isPublished: true, updatedAt: sql`unixepoch()` }))
            .where(eq(pages.id, "pg_a")).run();
        expect(sqlite.prepare("SELECT updated_at AS updatedAt FROM pages").get()).toEqual({ updatedAt: 1700000000 });

        // One real change: the lastmod and its key move.
        await save({ name: "A", noIndex: true });
        expect((sqlite.prepare("SELECT updated_at AS updatedAt FROM categories").get() as { updatedAt: number }).updatedAt).toBeGreaterThan(1700000000);
        expect(lastmodSeq()).toBeGreaterThan(before);
    });
});
