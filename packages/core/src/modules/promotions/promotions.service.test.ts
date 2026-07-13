import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, describe, expect, it } from "vitest";

import {
    createPromotionDraft,
    getPromotionAggregate,
    listPromotionDrafts,
    previewPersistedPromotion,
    updatePromotionDraft,
} from "./promotions.service";

const migration28 = readFileSync(
    resolve(import.meta.dirname, "../../../../database/migrations/0028_cute_ghost_rider.sql"),
    "utf8",
).replaceAll("--> statement-breakpoint", "");
const migration29 = readFileSync(
    resolve(import.meta.dirname, "../../../../database/migrations/0029_messy_silver_surfer.sql"),
    "utf8",
).replaceAll("--> statement-breakpoint", "");
const migration30 = readFileSync(
    resolve(import.meta.dirname, "../../../../database/migrations/0030_messy_ultragirl.sql"),
    "utf8",
).replaceAll("--> statement-breakpoint", "");

function baseDraft() {
    return {
        name: "Ten percent code",
        title: null,
        method: "code" as const,
        priority: 100,
        conflictPolicy: "best" as const,
        startsAtEpochSeconds: null,
        endsAtEpochSeconds: null,
        timezone: "Asia/Dhaka",
        codes: [{ code: "SAVE10", isActive: true }],
        conditions: [],
        effects: [{
            kind: "percentage_off" as const,
            target: "order" as const,
            allocation: "once" as const,
            config: { basisPoints: 1_000 },
        }],
    };
}

describe("promotion aggregate service", () => {
    let sqlite: DatabaseSync | null = null;

    afterEach(() => {
        sqlite?.close();
        sqlite = null;
    });

    function createDb(): Database {
        sqlite = new DatabaseSync(":memory:");
        sqlite.exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE orders (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE order_items (
                id TEXT PRIMARY KEY NOT NULL,
                order_id TEXT NOT NULL REFERENCES orders(id),
                quantity INTEGER NOT NULL
            );
            CREATE TABLE discounts (
                id TEXT PRIMARY KEY NOT NULL,
                code TEXT NOT NULL UNIQUE
            );
            CREATE TABLE customers (id TEXT PRIMARY KEY NOT NULL);
            ${migration28}
            ${migration29}
            ${migration30}
        `);

        function executeQuery(query: string, params: unknown[], method: string) {
            const statement = sqlite!.prepare(query);
            statement.setReturnArrays(true);
            if (method === "run") {
                statement.run(...params);
                return { rows: [] as unknown[][] };
            }
            if (method === "get") {
                const row = statement.get(...params) as unknown[] | undefined;
                return { rows: row ?? [] };
            }
            return { rows: statement.all(...params) as unknown[][] };
        }

        return drizzle(
            async (query, params, method) => executeQuery(query, params, method),
            async (queries) => {
                sqlite!.exec("BEGIN IMMEDIATE");
                try {
                    const results = queries.map(({ sql, params, method }) =>
                        executeQuery(sql, params, method));
                    sqlite!.exec("COMMIT");
                    return results;
                } catch (error) {
                    sqlite!.exec("ROLLBACK");
                    throw error;
                }
            },
            { schema },
        ) as unknown as Database;
    }

    it("creates, reads, and previews one atomic code draft", async () => {
        const db = createDb();
        const created = await createPromotionDraft(db, baseDraft());
        expect(created).toMatchObject({ revision: 1, status: "draft" });

        const aggregate = await getPromotionAggregate(db, created.id);
        expect(aggregate).toMatchObject({
            id: created.id,
            revision: 1,
            method: "code",
            status: "draft",
            codes: [{ code: "SAVE10", isActive: true }],
            effects: [{ target: "order", kind: "percentage_off" }],
        });

        const preview = await previewPersistedPromotion(db, {
            promotionId: created.id,
            expectedRevision: 1,
            cart: {
                currencyCode: "BDT",
                lines: [{
                    id: "line_1",
                    productId: "prod_1",
                    variantId: "sku_1",
                    unitPriceMinor: 10_000,
                    quantity: 1,
                }],
                shippingAmountMinor: 600,
                submittedCodes: ["save10"],
                evaluatedAtEpochSeconds: 1_800_000_000,
            },
        });
        expect(preview).toMatchObject({
            assumedActive: true,
            promotionRevision: 1,
            applied: {
                promotionId: created.id,
                promotionCode: "SAVE10",
                totalDiscountMinor: 1_000,
            },
        });
    });

    it("retires a referenced effect, preserves its allocation, and rejects stale replacement", async () => {
        const db = createDb();
        const created = await createPromotionDraft(db, baseDraft());
        const aggregate = await getPromotionAggregate(db, created.id);
        const originalEffect = aggregate!.effects[0]!;

        sqlite!.exec(`
            INSERT INTO orders (id) VALUES ('order_1');
            INSERT INTO order_items (id, order_id, quantity)
            VALUES ('item_1', 'order_1', 1);
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                promotion_code, effect_kind, target, currency_code,
                base_amount_minor, discount_amount_minor, quantity
            ) VALUES (
                'allocation_1', 'order_1', 'item_1', '${created.id}',
                '${originalEffect.id}', 1, 1, 'code', 'Ten percent code',
                'SAVE10', 'percentage_off', 'order', 'BDT', 10000, 1000, 1
            );
        `);

        const replacement = {
            ...baseDraft(),
            expectedRevision: 1,
            effects: [{
                kind: "free" as const,
                target: "shipping" as const,
                allocation: "once" as const,
                config: {},
            }],
        };
        await expect(updatePromotionDraft(db, created.id, replacement)).resolves.toMatchObject({
            revision: 2,
        });
        expect(sqlite!.prepare(`
            SELECT COUNT(*) AS count
            FROM order_discount_allocations
            WHERE effect_id = ?
        `).get(originalEffect.id)).toMatchObject({ count: 1 });
        expect(sqlite!.prepare(`
            SELECT deleted_at
            FROM promotion_effects
            WHERE id = ?
        `).get(originalEffect.id)).toMatchObject({ deleted_at: expect.any(Number) });

        await expect(updatePromotionDraft(db, created.id, replacement)).rejects.toMatchObject({
            code: "PROMOTION_REVISION_CONFLICT",
            details: { expectedRevision: 1, currentRevision: 2 },
        });
    });

    it("enriches bounded list results with committed usage and spend", async () => {
        const db = createDb();
        const created = await createPromotionDraft(db, baseDraft());
        sqlite!.exec(`
            UPDATE promotions SET status = 'active' WHERE id = '${created.id}';
            INSERT INTO customers (id) VALUES ('cust_1');
            INSERT INTO orders (id) VALUES ('order_usage');
            INSERT INTO order_items (id, order_id, quantity)
            VALUES ('item_usage', 'order_usage', 1);
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                promotion_code, effect_kind, target, currency_code,
                base_amount_minor, discount_amount_minor, quantity
            ) SELECT
                'allocation_usage', 'order_usage', 'item_usage', '${created.id}', id,
                1, 1, 'code', 'Ten percent code', 'SAVE10',
                'percentage_off', 'order', 'BDT', 10000, 1000, 1
            FROM promotion_effects
            WHERE promotion_id = '${created.id}' AND deleted_at IS NULL;
            INSERT INTO promotion_redemptions (
                id, promotion_id, order_id, customer_id, promotion_revision,
                promotion_code, currency_code, discount_amount_minor
            ) VALUES (
                'pred_usage', '${created.id}', 'order_usage', 'cust_1', 1,
                'SAVE10', 'BDT', 1000
            );
        `);

        await expect(listPromotionDrafts(db)).resolves.toEqual([
            expect.objectContaining({
                id: created.id,
                redemptionCount: 1,
                discountSpendMinor: 1_000,
            }),
        ]);
    });
});
