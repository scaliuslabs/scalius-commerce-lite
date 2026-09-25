import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { HOME_MAX_PRODUCT_LISTS, type HomeProductListRequest } from "@scalius/shared/storefront-theme";
import { describe, expect, it } from "vitest";
import { planHomeProductLists } from "./home-lists";

// D1 refuses a statement over 100 KB of SQL (SQLITE_TOOBIG). A home list's
// id query can be large (the on-sale list carries the pricing projection),
// and every statement that scopes by it must stay well under the limit.
const D1_STATEMENT_BYTES = 100_000;

const sources: HomeProductListRequest["source"][] = [
    { kind: "on-sale" },
    { kind: "newest" },
    { kind: "popular" },
    { kind: "category", categoryId: "cat_one" },
];

describe("home list statements", () => {
    it("stay under D1's statement length for the largest home a theme can ask for", async () => {
        const { db } = createSqliteD1Database();
        const lists: HomeProductListRequest[] = Array.from({ length: HOME_MAX_PRODUCT_LISTS }, (_, index) => {
            const source = sources[index % sources.length]!;
            return { key: `${source.kind}:${index}`, source, limit: 48 };
        });
        const { statements } = planHomeProductLists(db, lists);
        expect(statements.length).toBeGreaterThan(0);
        for (const statement of statements) {
            const { sql } = (statement as unknown as { toSQL(): { sql: string } }).toSQL();
            expect(new TextEncoder().encode(sql).length).toBeLessThan(D1_STATEMENT_BYTES * 0.6);
            // And each one runs.
            await expect(Promise.resolve(statement)).resolves.toBeDefined();
        }
    });
});
