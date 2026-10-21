// Automatic promotions beyond the first few by priority, on the real migrated
// schema: the candidate read filters by what reaches the cart before its
// bound (so the 25th promotion applies when only it targets the cart, by
// product, manual collection or dynamic collection), the product page lists
// a Buy X get Y behind many other automatic promotions, and turning on one
// more than the cap fails loudly at write time instead of silently at checkout.
// Because writes cap them, the read loads every automatic promotion that is
// on through its index and parses no rule in SQL (docs/SCALE.md, finding 11).
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createMigratedSqlite, createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import type { StorefrontDiscountCart } from "./checkout-snapshot";
import { listProductBuyGetOffers, quoteStorefrontDiscount } from "./promotions.checkout";
import { MAX_ACTIVE_AUTOMATIC_PROMOTIONS } from "./promotions.evaluator";
import { activatePromotion, pausePromotion } from "./promotions.lifecycle";
import { createPromotionDraft } from "./promotions.service";
import type { CreatePromotionDraftInput } from "./promotions.validation";

const NOW = 1_900_000_000;

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

function openStore(onQuery?: (query: string, values: readonly SQLInputValue[]) => void): Database {
    sqlite = createMigratedSqlite({ provider: "d1" });
    sqlite.exec(`
        INSERT INTO categories (id, name, slug) VALUES ('cat_phones', 'Phones', 'phones'), ('cat_other', 'Other', 'other');
        INSERT INTO products (id, name, slug, price_minor, category_id) VALUES
            ('prod_phone', 'Phone', 'phone', 50000, 'cat_phones'),
            ('prod_case', 'Case', 'case', 20000, NULL),
            ('prod_elsewhere', 'Elsewhere', 'elsewhere', 10000, 'cat_other');
        INSERT INTO collections (id, name, presentation, config, is_active) VALUES
            ('col_manual', 'Manual', 'grid', '{"source":"manual","productIds":["prod_phone"]}', 1),
            ('col_dynamic', 'Dynamic', 'grid', '{"source":"dynamic","categoryIds":["cat_phones"]}', 1),
            ('col_off', 'Off', 'grid', '{"source":"manual","productIds":["prod_phone"]}', 0),
            ('col_elsewhere', 'Elsewhere', 'grid', '{"source":"dynamic","categoryIds":["cat_other"]}', 1);
    `);
    return createSqliteD1Database({ sqlite, onQuery }).db;
}

const cart: StorefrontDiscountCart = {
    currencyCode: "BDT",
    priceIncrementMinor: 100,
    lines: [{ id: "cart:0:var_phone", productId: "prod_phone", variantId: "var_phone", unitPriceMinor: 50_000, quantity: 1 }],
    shippingAmountMinor: 0,
};

const lineOff = (basisPoints: number, scope: { productIds?: string[]; collectionIds?: string[] }) => ({
    kind: "percentage_off" as const, target: "line" as const, allocation: "across" as const, config: { basisPoints, ...scope },
});

type Rule = Partial<CreatePromotionDraftInput> & Pick<CreatePromotionDraftInput, "effects" | "name">;

async function live(db: Database, rule: Rule) {
    const created = await createPromotionDraft(db, { method: "automatic", ...rule });
    return activatePromotion(db, created.id, created.revision, NOW - 3_600);
}

/** Twenty-four automatic promotions ahead by priority, none reaching the phone. */
async function crowd(db: Database) {
    for (let index = 0; index < 24; index += 1) {
        const scope = index % 3 === 0
            ? { productIds: ["prod_elsewhere"] }
            : index % 3 === 1
                ? { collectionIds: ["col_elsewhere", "col_off"] }
                : { productIds: ["prod_case"] };
        await live(db, { name: `Ahead ${index}`, priority: index, effects: [lineOff(500, scope)] });
    }
    // An unscoped discount gated by a minimum on another product cannot apply either.
    await live(db, {
        name: "Gated elsewhere",
        priority: 0,
        conditions: [{ kind: "minimum_item_quantity", config: { quantity: 1, productIds: ["prod_elsewhere"] } }],
        effects: [{ kind: "percentage_off", target: "order", allocation: "once", config: { basisPoints: 9_000 } }],
    });
}

const quote = (db: Database) => quoteStorefrontDiscount(db, { codes: [], cart, evaluatedAtEpochSeconds: NOW });
const appliedNames = async (db: Database) => (await quote(db)).applied?.discounts.map(({ promotionName }) => promotionName) ?? [];

describe("automatic promotions beyond the first twenty by priority (d1)", () => {
    it.each([
        ["a product", { productIds: ["prod_phone"] }],
        ["a manual collection", { collectionIds: ["col_manual"] }],
        ["a dynamic collection", { collectionIds: ["col_dynamic"] }],
    ])("applies the 26th when only it targets the cart through %s", async (_label, scope) => {
        const db = openStore();
        await crowd(db);
        await live(db, { name: "Last by priority", priority: 9_000, effects: [lineOff(1_000, scope)] });

        const result = await quote(db);
        expect(result.applied?.discounts.map(({ promotionName }) => promotionName)).toEqual(["Last by priority"]);
        expect(result.applied?.totalDiscountMinor).toBe(5_000);
    });

    it("reads the automatic promotions that are on through their index, parsing no rule in SQL", async () => {
        const queries: Array<{ query: string; values: readonly SQLInputValue[] }> = [];
        const db = openStore((query, values) => queries.push({ query, values }));
        await crowd(db);
        await live(db, { name: "Last by priority", priority: 9_000, effects: [lineOff(1_000, { collectionIds: ["col_dynamic"] })] });
        await live(db, { name: "Code", method: "code", codes: [{ code: "PHONE10" }], effects: [lineOff(500, { productIds: ["prod_phone"] })] });
        // History the read must not walk: automatic promotions that ended.
        sqlite!.exec(`UPDATE promotions SET ends_at = ${NOW - 60} WHERE name LIKE 'Ahead 1%'`);
        queries.length = 0;

        expect(await appliedNames(db)).toEqual(["Last by priority"]);

        const promotionReads = queries.filter(({ query }) => /^\s*select/i.test(query) && /"promotion(s|_\w+)"/.test(query));
        expect(promotionReads.length).toBeGreaterThanOrEqual(5);
        const steps = promotionReads.flatMap(({ query, values }) => {
            expect(query).not.toMatch(/json_/);
            const bound = values.map((value) => typeof value === "boolean" ? Number(value) : value);
            return (sqlite!.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...bound) as Array<{ detail: string }>).map(({ detail }) => detail);
        });
        const promotionSteps = steps.filter((detail) => /^(SEARCH|SCAN) promotions\b/.test(detail));
        expect(promotionSteps.length).toBeGreaterThan(0);
        for (const detail of promotionSteps) {
            expect(detail).toMatch(/USING (COVERING )?INDEX (promotions_automatic_live_idx \(method=\? AND status=\? AND deleted_at=\? AND ends_at[=>]\?\)|sqlite_autoindex_promotions_1 \(id=\?\))$/);
        }
        expect(steps.filter((detail) => /^SCAN promotion/.test(detail))).toEqual([]);
    });

    it("keeps a Buy X get Y whose buy side is in the cart, so its nudge still shows", async () => {
        const db = openStore();
        await crowd(db);
        await live(db, {
            name: "Phone gets a case",
            priority: 9_000,
            effects: [{
                kind: "percentage_off", target: "line", allocation: "across",
                config: { basisPoints: 10_000, productIds: ["prod_case"], getQuantity: 1, buy: { quantity: 1, productIds: ["prod_phone"] } },
            }],
        });
        const result = await quote(db);
        expect(result.applied).toBeNull();
        expect(result.offers.map(({ title }) => title)).toEqual(["Phone gets a case"]);
    });

    it("lists a product page's Buy X get Y behind other automatic promotions", async () => {
        const db = openStore();
        await crowd(db);
        await live(db, {
            name: "Phone gets a case",
            priority: 9_000,
            effects: [{
                kind: "percentage_off", target: "line", allocation: "across",
                config: { basisPoints: 10_000, productIds: ["prod_case"], getQuantity: 1, buy: { quantity: 1, productIds: ["prod_phone"] } },
            }],
        });
        const offers = await listProductBuyGetOffers(db, "prod_phone", { code: "BDT", priceIncrementMinor: 100 }, NOW);
        expect(offers.map(({ title }) => title)).toEqual(["Phone gets a case"]);
    });

    it("refuses turning on one automatic promotion beyond the cap, and allows it after one is off", async () => {
        const db = openStore();
        const on: Array<{ id: string; revision: number }> = [];
        for (let index = 0; index < MAX_ACTIVE_AUTOMATIC_PROMOTIONS; index += 1) {
            on.push(await live(db, { name: `On ${index}`, priority: index, effects: [lineOff(500, { productIds: ["prod_case"] })] }));
        }
        const extra = await createPromotionDraft(db, { method: "automatic", name: "One too many", effects: [lineOff(500, { productIds: ["prod_phone"] })] });
        await expect(activatePromotion(db, extra.id, extra.revision, NOW - 3_600)).rejects.toMatchObject({
            status: 409,
            code: "promotion_automatic_cap",
        });
        const status = sqlite!.prepare("SELECT status, revision FROM promotions WHERE id = ?").get(extra.id) as { status: string; revision: number };
        expect(status).toEqual({ status: "draft", revision: extra.revision });

        // A code discount is not automatic: it does not count.
        await live(db, { name: "Code", codes: [{ code: "PHONE10" }], method: "code", effects: [lineOff(1_000, { productIds: ["prod_phone"] })] });

        await pausePromotion(db, on[0]!.id, on[0]!.revision);
        await activatePromotion(db, extra.id, extra.revision, NOW - 3_600);
        expect(await appliedNames(db)).toEqual(["One too many"]);
    });
});
