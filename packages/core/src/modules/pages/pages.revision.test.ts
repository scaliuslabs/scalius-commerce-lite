import { describe, expect, it } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
    normalizePageRevisionClaims,
    pageRevisionClaimsMatchCondition,
} from "./pages.revision";

describe("page revision claims", () => {
    it("normalizes valid claims and rejects duplicate or over-limit batches", () => {
        expect(normalizePageRevisionClaims([
            { id: " page_1 ", expectedRevision: 2 },
        ], 90)).toEqual([{ id: "page_1", expectedRevision: 2 }]);

        expect(() => normalizePageRevisionClaims([
            { id: "page_1", expectedRevision: 1 },
            { id: "page_1", expectedRevision: 2 },
        ], 90)).toThrow(/unique IDs/i);

        expect(() => normalizePageRevisionClaims(
            Array.from({ length: 91 }, (_, index) => ({
                id: `page_${index}`,
                expectedRevision: 1,
            })),
            90,
        )).toThrow(/at most 90/i);
    });

    it("guards both revision and lifecycle state in one SQL predicate", () => {
        const dialect = new SQLiteSyncDialect();
        const query = dialect.sqlToQuery(pageRevisionClaimsMatchCondition(
            [{ id: "page_1", expectedRevision: 4 }],
            "trashed",
        ));

        expect(query.sql).toContain("json_each(?)");
        expect(query.sql).toContain('"pages"."revision"');
        expect(query.sql).toContain('"pages"."deleted_at" IS NOT NULL');
        expect(query.params).toEqual([
            JSON.stringify([{ id: "page_1", expectedRevision: 4 }]),
            1,
        ]);
    });
});
