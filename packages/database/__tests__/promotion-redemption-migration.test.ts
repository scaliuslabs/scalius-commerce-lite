import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const migrations = [
    "0028_cute_ghost_rider.sql",
    "0029_messy_silver_surfer.sql",
    "0030_messy_ultragirl.sql",
].map((filename) => readFileSync(
    resolve(import.meta.dirname, `../migrations/${filename}`),
    "utf8",
).replaceAll("--> statement-breakpoint", ""));

function expectSqliteFailure(action: () => unknown, code: string): void {
    expect(action).toThrow(new RegExp(code, "u"));
}

describe("promotion redemption migration", () => {
    let db: DatabaseSync | null = null;

    afterEach(() => {
        db?.close();
        db = null;
    });

    function setup(): DatabaseSync {
        db = new DatabaseSync(":memory:");
        db.exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE orders (
                id TEXT PRIMARY KEY NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
            );
            CREATE TABLE order_items (
                id TEXT PRIMARY KEY NOT NULL,
                order_id TEXT NOT NULL REFERENCES orders(id),
                quantity INTEGER NOT NULL
            );
            CREATE TABLE customers (id TEXT PRIMARY KEY NOT NULL);
            CREATE TABLE discounts (id TEXT PRIMARY KEY NOT NULL, code TEXT NOT NULL UNIQUE);
            ${migrations.join("\n")}
        `);
        db.exec(`
            INSERT INTO customers (id) VALUES ('cust_1'), ('cust_2'), ('cust_3');
            INSERT INTO promotions (
                id, name, method, status, revision, max_redemptions,
                max_redemptions_per_customer, max_discount_spend_minor,
                budget_currency_code
            ) VALUES (
                'promo_1', 'Budgeted code', 'code', 'active', 1, 2, 1, 150, 'BDT'
            );
            INSERT INTO promotion_codes (
                id, promotion_id, code, normalized_code, is_active
            ) VALUES ('pcode_1', 'promo_1', 'SAVE10', 'SAVE10', 1);
            INSERT INTO promotion_effects (
                id, promotion_id, kind, target, allocation, config, position
            ) VALUES (
                'peff_1', 'promo_1', 'fixed_amount_off', 'order', 'once',
                '{"amountMinor":100,"currencyCode":"BDT"}', 0
            );
        `);
        return db;
    }

    function insertOrderAndClaim(
        sqlite: DatabaseSync,
        suffix: string,
        customerId: string,
        amountMinor: number,
        currencyCode = "BDT",
    ): void {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
            sqlite.exec(`
                INSERT INTO orders (id) VALUES ('order_${suffix}');
                INSERT INTO order_items (id, order_id, quantity)
                VALUES ('item_${suffix}', 'order_${suffix}', 1);
            `);
            sqlite.prepare(`
                INSERT INTO order_discount_allocations (
                    id, order_id, order_item_id, promotion_id, effect_id,
                    promotion_revision, evaluator_version, method, promotion_name,
                    promotion_code, effect_kind, target, currency_code,
                    base_amount_minor, discount_amount_minor, quantity
                ) VALUES (
                    ?, ?, ?, 'promo_1', 'peff_1', 1, 1, 'code', 'Budgeted code',
                    'SAVE10', 'fixed_amount_off', 'order', ?, 1000, ?, 1
                )
            `).run(
                `allocation_${suffix}`,
                `order_${suffix}`,
                `item_${suffix}`,
                currencyCode,
                amountMinor,
            );
            sqlite.prepare(`
                INSERT INTO promotion_redemptions (
                    id, promotion_id, order_id, customer_id, promotion_revision,
                    promotion_code, currency_code, discount_amount_minor
                ) VALUES (?, 'promo_1', ?, ?, 1, 'SAVE10', ?, ?)
            `).run(
                `pred_${suffix}`,
                `order_${suffix}`,
                customerId,
                currencyCode,
                amountMinor,
            );
            sqlite.exec("COMMIT");
        } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
        }
    }

    it("serializes the last total, customer, currency, and spend claims and keeps them immutable", () => {
        const sqlite = setup();
        insertOrderAndClaim(sqlite, "1", "cust_1", 100);

        expectSqliteFailure(
            () => insertOrderAndClaim(sqlite, "2", "cust_1", 40),
            "PROMOTION_REDEMPTION_CUSTOMER_LIMIT",
        );
        expectSqliteFailure(
            () => insertOrderAndClaim(sqlite, "3", "cust_2", 60),
            "PROMOTION_REDEMPTION_SPEND_LIMIT",
        );
        insertOrderAndClaim(sqlite, "4", "cust_2", 50);
        sqlite.exec(`
            UPDATE promotions
            SET max_redemptions_per_customer = NULL, max_discount_spend_minor = 1000
            WHERE id = 'promo_1'
        `);
        expectSqliteFailure(
            () => insertOrderAndClaim(sqlite, "5", "cust_3", 1),
            "PROMOTION_REDEMPTION_TOTAL_LIMIT",
        );

        sqlite.exec("UPDATE promotions SET max_redemptions = 3 WHERE id = 'promo_1'");
        expectSqliteFailure(
            () => insertOrderAndClaim(sqlite, "currency", "cust_3", 1, "USD"),
            "PROMOTION_REDEMPTION_SPEND_LIMIT",
        );

        expectSqliteFailure(
            () => sqlite.exec("UPDATE promotion_redemptions SET discount_amount_minor = 1 WHERE id = 'pred_1'"),
            "PROMOTION_REDEMPTION_IMMUTABLE",
        );
        expectSqliteFailure(
            () => sqlite.exec("DELETE FROM promotion_redemptions WHERE id = 'pred_1'"),
            "PROMOTION_REDEMPTION_IMMUTABLE",
        );
    });

    it("rejects stale or paused claims and rolls the surrounding order transaction back", () => {
        const sqlite = setup();
        sqlite.exec("UPDATE promotions SET status = 'paused' WHERE id = 'promo_1'");

        expect(() => insertOrderAndClaim(sqlite, "paused", "cust_1", 50))
            .toThrow(/PROMOTION_REDEMPTION_NOT_ELIGIBLE/u);
        expect(sqlite.prepare("SELECT id FROM orders WHERE id = 'order_paused'").get()).toBeUndefined();

        sqlite.exec(`
            INSERT INTO orders (id) VALUES ('order_stale');
            INSERT INTO order_items (id, order_id, quantity)
            VALUES ('item_stale', 'order_stale', 1);
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                promotion_code, effect_kind, target, currency_code,
                base_amount_minor, discount_amount_minor, quantity
            ) VALUES (
                'allocation_stale', 'order_stale', 'item_stale', 'promo_1',
                'peff_1', 1, 1, 'code', 'Budgeted code', 'SAVE10',
                'fixed_amount_off', 'order', 'BDT', 1000, 50, 1
            );
        `);
        sqlite.exec("UPDATE promotions SET status = 'active', revision = 2 WHERE id = 'promo_1'");
        expectSqliteFailure(() => sqlite.exec(`
            INSERT INTO promotion_redemptions (
                id, promotion_id, order_id, customer_id, promotion_revision,
                promotion_code, currency_code, discount_amount_minor
            ) VALUES (
                'pred_stale', 'promo_1', 'order_stale', 'cust_1', 1,
                'SAVE10', 'BDT', 50
            )
        `), "PROMOTION_REDEMPTION_NOT_ELIGIBLE");
    });

    it("conservatively keeps cancelled and refunded claims in usage and spend budgets", () => {
        const sqlite = setup();
        insertOrderAndClaim(sqlite, "terminal", "cust_1", 100);

        sqlite.exec("UPDATE orders SET status = 'refunded' WHERE id = 'order_terminal'");
        expect(sqlite.prepare(`
            SELECT count(*) AS claims, sum(discount_amount_minor) AS spend
            FROM promotion_redemptions
            WHERE promotion_id = 'promo_1'
        `).get()).toEqual({ claims: 1, spend: 100 });
        expectSqliteFailure(
            () => sqlite.exec("DELETE FROM promotion_redemptions WHERE order_id = 'order_terminal'"),
            "PROMOTION_REDEMPTION_IMMUTABLE",
        );
    });
});
