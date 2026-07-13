import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration28 = readFileSync(
    resolve(import.meta.dirname, "../migrations/0028_cute_ghost_rider.sql"),
    "utf8",
).replaceAll("--> statement-breakpoint", "");
const migration29 = readFileSync(
    resolve(import.meta.dirname, "../migrations/0029_messy_silver_surfer.sql"),
    "utf8",
).replaceAll("--> statement-breakpoint", "");

const prerequisiteAuthority = `
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
`;

const promotionFixture = `
    INSERT INTO orders (id) VALUES ('order_1');
    INSERT INTO order_items (id, order_id, quantity)
    VALUES ('item_1', 'order_1', 1);
    INSERT INTO promotions (
        id, name, method, status, priority, conflict_policy, timezone, revision
    ) VALUES (
        'promo_1', 'Ten percent', 'code', 'active', 100, 'best', 'Asia/Dhaka', 2
    );
    INSERT INTO promotion_codes (
        id, promotion_id, code, normalized_code, is_active
    ) VALUES ('pcode_1', 'promo_1', 'SAVE10', 'SAVE10', 1);
    INSERT INTO promotion_effects (
        id, promotion_id, kind, target, allocation, config, position
    ) VALUES (
        'effect_1', 'promo_1', 'percentage_off', 'order', 'once',
        '{"basisPoints":1000}', 0
    );
    INSERT INTO order_discount_allocations (
        id, order_id, order_item_id, promotion_id, effect_id, promotion_revision,
        evaluator_version, method, promotion_name, promotion_code, effect_kind,
        target, currency_code, base_amount_minor, discount_amount_minor, quantity
    ) VALUES (
        'allocation_1', 'order_1', 'item_1', 'promo_1', 'effect_1', 2,
        1, 'code', 'Ten percent', 'SAVE10', 'percentage_off', 'order',
        'BDT', 1000, 100, 1
    );
`;

function runSql(sql: string) {
    return spawnSync("sqlite3", [":memory:"], {
        input: `.bail on
            PRAGMA foreign_keys = ON;
            ${prerequisiteAuthority}
            ${migration28}
            ${migration29}
            ${sql}
        `,
        encoding: "utf8",
    });
}

describe("promotion CRUD migration", () => {
    it("soft-retires a used effect and permits one replacement for the same target", () => {
        const result = runSql(`
            ${promotionFixture}
            UPDATE promotion_effects SET deleted_at = unixepoch()
            WHERE id = 'effect_1';
            INSERT INTO promotion_effects (
                id, promotion_id, kind, target, allocation, config, position
            ) VALUES (
                'effect_2', 'promo_1', 'fixed_amount_off', 'order', 'once',
                '{"amountMinor":200,"currencyCode":"BDT"}', 0
            );
            SELECT
                allocation.id || ':' || allocation.effect_id || ':' || effect.deleted_at
            FROM order_discount_allocations AS allocation
            JOIN promotion_effects AS effect ON effect.id = allocation.effect_id;
            PRAGMA foreign_key_check;
        `);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toMatch(/^allocation_1:effect_1:\d+$/u);

        const duplicateActiveTarget = runSql(`
            ${promotionFixture}
            INSERT INTO promotion_effects (
                id, promotion_id, kind, target, allocation, config, position
            ) VALUES (
                'effect_2', 'promo_1', 'fixed_amount_off', 'order', 'once',
                '{"amountMinor":200,"currencyCode":"BDT"}', 1
            );
        `);
        expect(duplicateActiveTarget.status).not.toBe(0);
        expect(duplicateActiveTarget.stderr).toMatch(
            /UNIQUE constraint failed: promotion_effects\.promotion_id, promotion_effects\.target/u,
        );
    });

    it("reserves code identity across legacy and typed promotion tables in either order", () => {
        const legacyFirst = runSql(`
            INSERT INTO discounts (id, code) VALUES ('disc_1', ' save10 ');
            INSERT INTO promotions (
                id, name, method, status, priority, conflict_policy, timezone, revision
            ) VALUES ('promo_1', 'Code', 'code', 'draft', 100, 'best', 'Asia/Dhaka', 1);
            INSERT INTO promotion_codes (
                id, promotion_id, code, normalized_code, is_active
            ) VALUES ('pcode_1', 'promo_1', 'SAVE10', 'SAVE10', 1);
        `);
        expect(legacyFirst.status).not.toBe(0);
        expect(legacyFirst.stderr).toMatch(/PROMOTION_CODE_IDENTITY_CONFLICT/u);

        const promotionFirst = runSql(`
            INSERT INTO promotions (
                id, name, method, status, priority, conflict_policy, timezone, revision
            ) VALUES ('promo_1', 'Code', 'code', 'draft', 100, 'best', 'Asia/Dhaka', 1);
            INSERT INTO promotion_codes (
                id, promotion_id, code, normalized_code, is_active
            ) VALUES ('pcode_1', 'promo_1', 'SAVE10', 'SAVE10', 1);
            INSERT INTO discounts (id, code) VALUES ('disc_1', ' save10 ');
        `);
        expect(promotionFirst.status).not.toBe(0);
        expect(promotionFirst.stderr).toMatch(/PROMOTION_CODE_IDENTITY_CONFLICT/u);
    });
});
