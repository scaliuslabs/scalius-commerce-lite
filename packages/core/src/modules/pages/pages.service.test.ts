import { describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { publicPageVisibilityCondition } from "./pages.service";

describe("publicPageVisibilityCondition", () => {
    it("requires published, not deleted, and not scheduled for the future", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(publicPageVisibilityCondition());

        expect(query.sql).toContain('"pages"."deleted_at" is null');
        expect(query.sql).toContain('"pages"."is_published" = ?');
        expect(query.sql).toContain('"pages"."published_at" is null');
        expect(query.sql).toContain('"pages"."published_at" <= unixepoch()');
        expect(query.params).toEqual([1]);
    });
});
