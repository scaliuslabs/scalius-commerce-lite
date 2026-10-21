// Automatic promotion candidates on PostgreSQL. The scale proof of
// 2026-10-21 (docs/SCALE.md, finding 11) found checkout 4 times slower: the
// candidate read opened every automatic promotion's rule and collection JSON
// row by row through the SQLite compatibility functions, about 12,500
// json_each calls an order. Writes cap the automatic promotions that are on,
// so the read now loads all of them through their index and parses nothing.
// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server as its
// superuser (the test counts function calls with track_functions).
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";

import { promotionCandidateIdsSql, quoteStorefrontDiscount } from "./promotions.checkout";
import { activatePromotion } from "./promotions.lifecycle";
import { createPromotionDraft } from "./promotions.service";
import type { CreatePromotionDraftInput } from "./promotions.validation";

afterAll(closeNativePostgres);

const NOW = 1_900_000_000;
const JSON_FUNCTIONS = ["json_each", "json_each_jsonb", "json_type", "json_valid", "json_extract"];

describe.runIf(nativePostgresUrl())("automatic promotion candidates on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    it("applies the last automatic promotion by priority and calls no JSON function per promotion", async () => {
        const { db, client, name } = await createNativePostgres({ label: "promotion_candidates" });
        await client.query(`
            INSERT INTO categories (id, name, slug) VALUES ('cat_phones', 'Phones', 'phones');
            INSERT INTO products (id, name, slug, price_minor, category_id) VALUES
                ('prod_phone', 'Phone', 'phone', 50000, 'cat_phones'),
                ('prod_case', 'Case', 'case', 20000, NULL);
            INSERT INTO collections (id, name, presentation, config, is_active) VALUES
                ('col_phones', 'Phones', 'grid', '{"source":"manual","productIds":["prod_case"]}', 1);
        `);
        const live = async (rule: Partial<CreatePromotionDraftInput> & Pick<CreatePromotionDraftInput, "effects" | "name">) => {
            const created = await createPromotionDraft(db, { method: "automatic", ...rule });
            return activatePromotion(db, created.id, created.revision, NOW - 3_600);
        };
        const lineOff = (basisPoints: number, scope: { productIds?: string[]; collectionIds?: string[] }) => ({
            kind: "percentage_off" as const, target: "line" as const, allocation: "across" as const, config: { basisPoints, ...scope },
        });
        // Thirty automatic promotions ahead by priority that do not reach the phone.
        for (let index = 0; index < 30; index += 1) {
            await live({
                name: `Ahead ${index}`,
                priority: index,
                effects: [lineOff(500, index % 2 === 0 ? { productIds: ["prod_case"] } : { collectionIds: ["col_phones"] })],
            });
        }
        await live({ name: "Last by priority", priority: 9_000, effects: [lineOff(1_000, { productIds: ["prod_phone"] })] });

        const cart = {
            currencyCode: "BDT",
            priceIncrementMinor: 100,
            lines: [{ id: "cart:0:var_phone", productId: "prod_phone", variantId: "var_phone", unitPriceMinor: 50_000, quantity: 1 }],
            shippingAmountMinor: 0,
        };
        // Count the compatibility functions' calls of new sessions (each adapter operation opens one).
        await client.query(`ALTER DATABASE "${name}" SET track_functions = 'pl'`);
        await client.query("SELECT pg_stat_reset()");
        const quote = await quoteStorefrontDiscount(db, { codes: [], cart, evaluatedAtEpochSeconds: NOW });
        expect(quote.applied?.discounts.map(({ promotionName }) => promotionName)).toEqual(["Last by priority"]);
        expect(quote.applied?.totalDiscountMinor).toBe(5_000);

        await new Promise((done) => setTimeout(done, 300)); // the adapter's sessions exit and flush their counters
        const calls = await client.query(`SELECT funcname, calls FROM pg_stat_user_functions
            WHERE funcname = ANY($1) AND calls > 0 ORDER BY funcname`, [JSON_FUNCTIONS]);
        // Thirty-one promotions, and only the collection lookup's two bound id
        // lists remain: one json_each a statement, one json_type an id in it.
        expect(calls.rows.map((row) => ({ funcname: row.funcname, calls: Number(row.calls) }))).toEqual([
            { funcname: "json_each", calls: 2 },
            { funcname: "json_type", calls: 2 },
        ]);

        const plan = (await db.all<Record<string, string> | string[]>(sql`EXPLAIN (VERBOSE)
            SELECT * FROM promotion_effects WHERE promotion_id IN ${promotionCandidateIdsSql(["PHONE10"], NOW, true)}`))
            .map((row) => String(Array.isArray(row) ? row[0] : Object.values(row)[0])).join("\n");
        // A candidate statement, codes included: no JSON function in any plan node or filter.
        expect(plan).toContain("promotion_codes_identity_unique");
        expect(plan).not.toMatch(/json_/);
    });
});
