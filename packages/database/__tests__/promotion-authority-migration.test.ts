import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
    resolve(import.meta.dirname, "../migrations/0028_cute_ghost_rider.sql"),
    "utf8",
).replaceAll("--> statement-breakpoint", "");

const orderAuthority = `
    CREATE TABLE orders (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE order_items (
        id TEXT PRIMARY KEY NOT NULL,
        order_id TEXT NOT NULL REFERENCES orders(id),
        quantity INTEGER NOT NULL
    );
`;

const promotionFixtures = `
    INSERT INTO orders (id) VALUES ('order_1'), ('order_2');
    INSERT INTO order_items (id, order_id, quantity) VALUES
        ('item_1', 'order_1', 2),
        ('item_2', 'order_1', 1);
    INSERT INTO promotions (
        id, name, method, status, priority, conflict_policy, timezone, revision
    ) VALUES
        ('promo_auto', 'Automatic ten percent', 'automatic', 'active', 100, 'best', 'Asia/Dhaka', 2),
        ('promo_code', 'Code ten percent', 'code', 'active', 100, 'best', 'Asia/Dhaka', 4);
    INSERT INTO promotion_codes (
        id, promotion_id, code, normalized_code, is_active
    ) VALUES ('code_1', 'promo_code', 'SAVE10', 'SAVE10', 1);
    INSERT INTO promotion_effects (
        id, promotion_id, kind, target, allocation, config, position
    ) VALUES
        ('effect_order', 'promo_auto', 'percentage_off', 'order', 'once', '{"basisPoints":1000}', 0),
        ('effect_line', 'promo_auto', 'fixed_amount_off', 'line', 'across', '{"amountMinor":100,"currencyCode":"BDT"}', 1),
        ('effect_shipping', 'promo_auto', 'free', 'shipping', 'once', '{}', 2),
        ('effect_code', 'promo_code', 'percentage_off', 'order', 'once', '{"basisPoints":1000}', 0);
`;

function runSql(sql: string) {
    return spawnSync("sqlite3", [":memory:"], {
        input: `.bail on
            PRAGMA foreign_keys = ON;
            ${orderAuthority}
            ${migration}
            ${promotionFixtures}
            ${sql}
        `,
        encoding: "utf8",
    });
}

const validOrderAllocation = `
    INSERT INTO order_discount_allocations (
        id, order_id, order_item_id, promotion_id, effect_id, promotion_revision,
        evaluator_version, method, promotion_name, effect_kind, target,
        currency_code, base_amount_minor, discount_amount_minor, quantity
    ) VALUES (
        'allocation_order', 'order_1', 'item_1', 'promo_auto', 'effect_order', 2,
        1, 'automatic', 'Automatic ten percent', 'percentage_off', 'order',
        'BDT', 1000, 100, 2
    );
`;

describe("promotion authority migration", () => {
    it("persists exact merchandise-line and shipping allocation snapshots", () => {
        const result = runSql(`
            ${validOrderAllocation}
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                effect_kind, target, currency_code, base_amount_minor,
                discount_amount_minor, quantity
            ) VALUES (
                'allocation_line', 'order_1', 'item_1', 'promo_auto', 'effect_line',
                2, 1, 'automatic', 'Automatic ten percent',
                'fixed_amount_off', 'line', 'BDT', 500, 100, 2
            );
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                effect_kind, target, currency_code, base_amount_minor,
                discount_amount_minor, quantity
            ) VALUES (
                'allocation_order_second', 'order_1', 'item_2', 'promo_auto', 'effect_order',
                2, 1, 'automatic', 'Automatic ten percent',
                'percentage_off', 'order', 'BDT', 500, 50, 1
            );
            INSERT INTO order_discount_allocations (
                id, order_id, promotion_id, effect_id, promotion_revision,
                evaluator_version, method, promotion_name, effect_kind, target,
                currency_code, base_amount_minor, discount_amount_minor
            ) VALUES (
                'allocation_shipping', 'order_1', 'promo_auto', 'effect_shipping', 2,
                1, 'automatic', 'Automatic ten percent', 'free', 'shipping',
                'BDT', 100, 100
            );
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                promotion_code, effect_kind, target, currency_code,
                base_amount_minor, discount_amount_minor, quantity
            ) VALUES (
                'allocation_code', 'order_1', 'item_1', 'promo_code', 'effect_code',
                4, 1, 'code', 'Code ten percent', 'SAVE10',
                'percentage_off', 'order', 'BDT', 1000, 100, 2
            );
            SELECT id || ':' || target || ':' || discount_amount_minor
            FROM order_discount_allocations ORDER BY id;
            PRAGMA foreign_key_check;
        `);

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim().split("\n")).toEqual([
            "allocation_code:order:100",
            "allocation_line:line:100",
            "allocation_order:order:100",
            "allocation_order_second:order:50",
            "allocation_shipping:shipping:100",
        ]);
    });

    it("keeps code ownership aligned with promotion method", () => {
        const wrongParent = runSql(`
            INSERT INTO promotion_codes (
                id, promotion_id, code, normalized_code, is_active
            ) VALUES ('code_invalid', 'promo_auto', 'NOPE10', 'NOPE10', 1);
        `);
        expect(wrongParent.status).not.toBe(0);
        expect(wrongParent.stderr).toMatch(/PROMOTION_CODE_METHOD_MISMATCH/u);

        const methodChange = runSql(`
            UPDATE promotions SET method = 'automatic' WHERE id = 'promo_code';
        `);
        expect(methodChange.status).not.toBe(0);
        expect(methodChange.stderr).toMatch(/PROMOTION_CODE_METHOD_MISMATCH/u);
    });

    it("rejects condition and effect arguments that do not match their kinds", () => {
        const invalidCondition = runSql(`
            INSERT INTO promotion_conditions (
                id, promotion_id, kind, config, position
            ) VALUES (
                'condition_invalid', 'promo_auto',
                'minimum_merchandise_subtotal', '{"quantity":2}', 0
            );
        `);
        expect(invalidCondition.status).not.toBe(0);
        expect(invalidCondition.stderr).toMatch(/promotion_conditions_config_shape/u);

        const invalidEffect = runSql(`
            INSERT INTO promotion_effects (
                id, promotion_id, kind, target, allocation, config, position
            ) VALUES (
                'effect_invalid', 'promo_auto', 'percentage_off', 'order', 'once',
                '{"basisPoints":"1000"}', 3
            );
        `);
        expect(invalidEffect.status).not.toBe(0);
        expect(invalidEffect.stderr).toMatch(/promotion_effects_config_shape/u);
    });

    it("rejects stale or cross-authority allocation references", () => {
        const staleRevision = runSql(`
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id, promotion_revision,
                evaluator_version, method, promotion_name, effect_kind, target,
                currency_code, base_amount_minor, discount_amount_minor, quantity
            ) VALUES (
                'allocation_stale', 'order_1', 'item_1', 'promo_auto', 'effect_order', 1,
                1, 'automatic', 'Automatic ten percent', 'percentage_off', 'order',
                'BDT', 1000, 100, 2
            );
        `);
        expect(staleRevision.status).not.toBe(0);
        expect(staleRevision.stderr).toMatch(/ORDER_DISCOUNT_ALLOCATION_REFERENCE_MISMATCH/u);

        const wrongEffect = runSql(`
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id, promotion_revision,
                evaluator_version, method, promotion_name, effect_kind, target,
                currency_code, base_amount_minor, discount_amount_minor, quantity
            ) VALUES (
                'allocation_crossed', 'order_1', 'item_1', 'promo_auto', 'effect_code', 2,
                1, 'automatic', 'Automatic ten percent', 'percentage_off', 'order',
                'BDT', 1000, 100, 2
            );
        `);
        expect(wrongEffect.status).not.toBe(0);
        expect(wrongEffect.stderr).toMatch(/ORDER_DISCOUNT_ALLOCATION_REFERENCE_MISMATCH/u);

        const wrongOrderItem = runSql(`
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                effect_kind, target, currency_code, base_amount_minor,
                discount_amount_minor, quantity
            ) VALUES (
                'allocation_wrong_item', 'order_2', 'item_1', 'promo_auto', 'effect_line',
                2, 1, 'automatic', 'Automatic ten percent',
                'fixed_amount_off', 'line', 'BDT', 500, 100, 2
            );
        `);
        expect(wrongOrderItem.status).not.toBe(0);
        expect(wrongOrderItem.stderr).toMatch(/ORDER_DISCOUNT_ALLOCATION_REFERENCE_MISMATCH/u);

        const wrongQuantity = runSql(`
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                effect_kind, target, currency_code, base_amount_minor,
                discount_amount_minor, quantity
            ) VALUES (
                'allocation_wrong_quantity', 'order_1', 'item_1', 'promo_auto',
                'effect_line', 2, 1, 'automatic', 'Automatic ten percent',
                'fixed_amount_off', 'line', 'BDT', 500, 100, 1
            );
        `);
        expect(wrongQuantity.status).not.toBe(0);
        expect(wrongQuantity.stderr).toMatch(/ORDER_DISCOUNT_ALLOCATION_REFERENCE_MISMATCH/u);

        const inactiveCode = runSql(`
            UPDATE promotion_codes SET is_active = 0 WHERE id = 'code_1';
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                promotion_code, effect_kind, target, currency_code,
                base_amount_minor, discount_amount_minor, quantity
            ) VALUES (
                'allocation_inactive_code', 'order_1', 'item_1',
                'promo_code', 'effect_code', 4, 1, 'code', 'Code ten percent',
                'SAVE10', 'percentage_off', 'order', 'BDT', 1000, 100, 2
            );
        `);
        expect(inactiveCode.status).not.toBe(0);
        expect(inactiveCode.stderr).toMatch(/ORDER_DISCOUNT_ALLOCATION_REFERENCE_MISMATCH/u);
    });

    it("makes committed allocation facts immutable", () => {
        const update = runSql(`
            ${validOrderAllocation}
            UPDATE order_discount_allocations
            SET discount_amount_minor = 149
            WHERE id = 'allocation_order';
        `);
        expect(update.status).not.toBe(0);
        expect(update.stderr).toMatch(/ORDER_DISCOUNT_ALLOCATION_IMMUTABLE/u);

        const deletion = runSql(`
            ${validOrderAllocation}
            DELETE FROM order_discount_allocations WHERE id = 'allocation_order';
        `);
        expect(deletion.status).not.toBe(0);
        expect(deletion.stderr).toMatch(/ORDER_DISCOUNT_ALLOCATION_IMMUTABLE/u);
    });
});
