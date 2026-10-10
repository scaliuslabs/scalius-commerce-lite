import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { listPromotionPage } from "./promotions.service";

const harnesses: Array<{ sqlite: { close(): void } }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

/**
 * 130 discounts (more than one page and the old 90-row read), one of them
 * with 2,000 bulk-generated codes, each with one effect.
 */
function setup(queries: Array<{ query: string; values: readonly unknown[] }> = []) {
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    harnesses.push(harness);
    const now = Math.floor(Date.now() / 1_000);
    const promotion = harness.sqlite.prepare(`INSERT INTO promotions (id, name, method, status, starts_at, ends_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const effect = harness.sqlite.prepare(`INSERT INTO promotion_effects (id, promotion_id, kind, target, allocation, config, position)
        VALUES (?, ?, 'percentage_off', 'order', 'once', '{"basisPoints":1000}', 0)`);
    const code = harness.sqlite.prepare("INSERT INTO promotion_codes (id, promotion_id, code, normalized_code, is_active) VALUES (?, ?, ?, ?, 1)");
    harness.sqlite.exec("BEGIN");
    for (let index = 0; index < 130; index += 1) {
        const id = `promo_${String(index).padStart(3, "0")}`;
        // 0–39 active, 40–59 scheduled, 60–79 expired, the rest drafts.
        const status = index < 80 ? "active" : "draft";
        const startsAt = index >= 40 && index < 60 ? now + 86_400 : null;
        const endsAt = index >= 60 && index < 80 ? now - 86_400 : null;
        promotion.run(id, index === 7 ? "Eid bulk codes" : `Discount ${index}`, "code", status, startsAt, endsAt, now - index);
        effect.run(`eff_${id}`, id);
        code.run(`code_${id}`, id, `SAVE${index}`, `SAVE${index}`);
    }
    for (let index = 0; index < 2_000; index += 1) {
        const value = `EID${String(index).padStart(5, "0")}`;
        code.run(`code_eid_${index}`, "promo_007", value, value);
    }
    harness.sqlite.exec("COMMIT");
    return harness;
}

describe("discounts list (server search, views and pages)", () => {
    it("pages every discount newest edit first, each row with one code and the count of the rest", async () => {
        const queries: Array<{ query: string; values: readonly unknown[] }> = [];
        const { db } = setup(queries);
        const first = await listPromotionPage(db, { page: 1, limit: 50 });
        expect(first.pagination).toMatchObject({ total: 130, totalPages: 3, page: 1 });
        expect(first.discounts.map((row) => row.id).slice(0, 2)).toEqual(["promo_000", "promo_001"]);
        const third = await listPromotionPage(db, { page: 3, limit: 50 });
        expect(third.discounts).toHaveLength(30);
        const bulk = first.discounts.find((row) => row.id === "promo_007")!;
        expect(bulk.codes).toHaveLength(1);
        expect(bulk.codeCount).toBe(2_001);
        for (const { values } of queries) expect(values.length).toBeLessThanOrEqual(100);
    });

    it("filters by view the way the status badge reads", async () => {
        const { db } = setup();
        expect((await listPromotionPage(db, { view: "active", limit: 90 })).pagination.total).toBe(40);
        expect((await listPromotionPage(db, { view: "scheduled", limit: 90 })).pagination.total).toBe(20);
        expect((await listPromotionPage(db, { view: "expired", limit: 90 })).pagination.total).toBe(20);
    });

    it("searches a name anywhere, or a code from its start, among thousands of codes", async () => {
        const { db } = setup();
        expect((await listPromotionPage(db, { search: "bulk" })).discounts.map((row) => row.id)).toEqual(["promo_007"]);
        expect((await listPromotionPage(db, { search: "eid0199" })).discounts.map((row) => row.id)).toEqual(["promo_007"]);
        expect((await listPromotionPage(db, { search: "SAVE12" })).discounts.map((row) => row.id).sort()).toEqual(["promo_012", "promo_120", "promo_121", "promo_122", "promo_123", "promo_124", "promo_125", "promo_126", "promo_127", "promo_128", "promo_129"]);
    });

    it("sorts by title both ways", async () => {
        const { db } = setup();
        const ascending = await listPromotionPage(db, { sort: "titleAsc", limit: 3 });
        expect(ascending.discounts.map((row) => row.name)).toEqual(["Discount 0", "Discount 1", "Discount 10"]);
        const descending = await listPromotionPage(db, { sort: "titleDesc", limit: 1 });
        expect(descending.discounts[0]!.name).toBe("Eid bulk codes");
    });
});
