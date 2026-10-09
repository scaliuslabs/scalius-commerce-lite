import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { readMatchingCursor } from "../../utils/bulk-matching";
import { bulkDeleteProducts, bulkRestoreProducts, bulkUpdateProducts } from "./lifecycle";
import { listMatchingProductClaims } from "./read";

const harnesses: Array<{ sqlite: { close(): void } }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

/** `count` products: every third in category Bags, every fourth a draft. */
function setup(count: number, queries: Array<{ query: string; values: readonly unknown[] }> = []) {
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    harnesses.push(harness);
    harness.sqlite.exec(`INSERT INTO categories (id, name, slug) VALUES ('cat_bags', 'Bags', 'bags'), ('cat_belts', 'Belts', 'belts');`);
    const insert = harness.sqlite.prepare(`INSERT INTO products (id, name, slug, price_minor, category_id, is_active)
        VALUES (?, ?, ?, 1000, ?, ?)`);
    harness.sqlite.exec("BEGIN");
    for (let index = 0; index < count; index += 1) {
        const id = `prd_${String(index).padStart(4, "0")}`;
        insert.run(id, `Product ${index}`, id, index % 3 === 0 ? "cat_bags" : "cat_belts", index % 4 === 0 ? 0 : 1);
    }
    harness.sqlite.exec("COMMIT");
    return harness;
}

/** Runs a matching action to the end, as the dashboard does, and returns what each slice read. */
async function walk(read: (cursor: string | undefined) => Promise<{ ids: string[]; next: string | null }>) {
    const slices: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 1_000; guard += 1) {
        const slice = await read(cursor);
        slices.push(slice.ids);
        if (!slice.next) return slices;
        cursor = slice.next;
    }
    throw new Error("the walk never ended");
}

describe("all matching products (select all N, T11)", () => {
    it("walks every product the filter matches in id-ordered slices of at most 90, inside D1's bound limits", async () => {
        const queries: Array<{ query: string; values: readonly unknown[] }> = [];
        const { db } = setup(400, queries);
        const slices = await walk(async (cursor) => {
            const slice = await listMatchingProductClaims(db, { categoryId: "cat_bags", status: "active" }, cursor);
            return { ids: slice.claims.map((claim) => claim.id), next: slice.next };
        });
        const ids = slices.flat();
        const expected = Array.from({ length: 400 }, (_, index) => index)
            .filter((index) => index % 3 === 0 && index % 4 !== 0)
            .map((index) => `prd_${String(index).padStart(4, "0")}`);
        expect(ids).toEqual(expected);
        expect(slices.every((slice) => slice.length <= 90)).toBe(true);
        for (const { values } of queries) expect(values.length).toBeLessThanOrEqual(100);
    });

    it("moves on past the rows an action takes out of the filter (trash), so nothing is skipped or acted on twice", async () => {
        const { db } = setup(200);
        const trashed: string[] = [];
        await walk(async (cursor) => {
            const slice = await listMatchingProductClaims(db, {}, cursor);
            if (slice.claims.length > 0) {
                const result = await bulkDeleteProducts(db, slice.claims, false);
                trashed.push(...result.outcomes.filter((outcome) => outcome.status === "trashed").map((outcome) => outcome.id));
            }
            return { ids: slice.claims.map((claim) => claim.id), next: slice.next };
        });
        expect(trashed).toHaveLength(200);
        expect(new Set(trashed).size).toBe(200);
        const left = await listMatchingProductClaims(db, {}, undefined);
        expect(left.claims).toEqual([]);

        // Restore walks the trashed set the same way.
        const restored: string[] = [];
        await walk(async (cursor) => {
            const slice = await listMatchingProductClaims(db, { showTrashed: true }, cursor, 8);
            if (slice.claims.length > 0) {
                const { outcomes } = await bulkRestoreProducts(db, slice.claims);
                restored.push(...outcomes.filter((outcome) => outcome.status === "restored").map((outcome) => outcome.id));
            }
            return { ids: slice.claims.map((claim) => claim.id), next: slice.next };
        });
        expect(restored).toHaveLength(200);
    });

    it("changes status by filter with each slice's own revision claims", async () => {
        const { db } = setup(120);
        await walk(async (cursor) => {
            const slice = await listMatchingProductClaims(db, { status: "draft" }, cursor);
            if (slice.claims.length > 0) await bulkUpdateProducts(db, slice.claims, { isActive: true });
            return { ids: slice.claims.map((claim) => claim.id), next: slice.next };
        });
        expect((await listMatchingProductClaims(db, { status: "draft" }, undefined)).claims).toEqual([]);
    });

    it("refuses a cursor that is not an id", () => {
        expect(readMatchingCursor(undefined)).toBeUndefined();
        expect(readMatchingCursor("prd_0001")).toBe("prd_0001");
        expect(() => readMatchingCursor("x' OR 1=1 --")).toThrow();
    });
});
