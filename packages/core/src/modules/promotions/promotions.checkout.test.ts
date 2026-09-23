import type { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import {
    evaluateStorefrontPromotionCode,
    resolvePromotionCustomerIdByPhone,
    verifyPromotionCheckoutSnapshot,
} from "./promotions.checkout";
import { activatePromotion, pausePromotion } from "./promotions.lifecycle";
import { PromotionRevisionConflictError } from "./promotions.revision";
import { createPromotionDraft } from "./promotions.service";

function orderSql(orderId: string, itemId: string): string {
    return `
        INSERT OR IGNORE INTO products (id, name, slug, price) VALUES ('product_promo', 'Promo product', 'promo-product', 100);
        INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount, shipping_charge)
        VALUES ('${orderId}', 'Buyer', '+8801700000009', 'Address', 'city', 'zone', 100, 0);
        INSERT INTO order_items (id, order_id, product_id, quantity, price)
        VALUES ('${itemId}', '${orderId}', 'product_promo', 1, 100);
    `;
}

describe("promotion checkout authority", () => {
    let sqlite: DatabaseSync | null = null;

    afterEach(() => {
        sqlite?.close();
        sqlite = null;
    });

    function setup(): Database {
        const fixture = createSqliteD1Database();
        sqlite = fixture.sqlite;
        sqlite.exec(`INSERT INTO customers (id, name, phone) VALUES
            ('cust_1', 'One', '+8801700000001'),
            ('cust_2', 'Two', '+8801700000002');`);
        return fixture.db;
    }

    it("activates by revision, evaluates exact allocations, and honors claimed limits", async () => {
        const db = setup();
        const created = await createPromotionDraft(db, {
            name: "Checkout ten percent",
            title: null,
            method: "code",
            priority: 100,
            conflictPolicy: "best",
            startsAtEpochSeconds: null,
            endsAtEpochSeconds: null,
            timezone: "Asia/Dhaka",
            maxRedemptions: 2,
            maxRedemptionsPerCustomer: 1,
            maxDiscountSpendMinor: 2_000,
            budgetCurrencyCode: "BDT",
            codes: [
                { code: "SAVE10", isActive: true },
                { code: "OLD10", isActive: false },
            ],
            conditions: [],
            effects: [{
                kind: "percentage_off",
                target: "order",
                allocation: "once",
                config: { basisPoints: 1_000 },
            }],
        });
        const activated = await activatePromotion(db, created.id, 1);
        expect(activated).toEqual({ id: created.id, revision: 2, status: "active" });

        const cart = {
            currencyCode: "BDT" as const,
            lines: [{
                id: "cart:0:sku_1",
                productId: "prod_1",
                variantId: "sku_1",
                unitPriceMinor: 10_000,
                quantity: 1,
            }],
            shippingAmountMinor: 500,
            evaluatedAtEpochSeconds: 1_900_000_000,
        };
        const resolution = await evaluateStorefrontPromotionCode(db, {
            code: " save10 ",
            cart,
            customerId: "cust_1",
        });
        expect(resolution).toMatchObject({
            matched: true,
            valid: true,
            evaluation: {
                applied: {
                    promotionRevision: 2,
                    totalDiscountMinor: 1_000,
                    promotionCode: "SAVE10",
                },
            },
        });
        if (!resolution.matched || !resolution.valid) throw new Error("Expected valid promotion");
        await expect(verifyPromotionCheckoutSnapshot(db, {
            cart: {
                currencyCode: cart.currencyCode,
                lines: cart.lines,
                shippingAmountMinor: cart.shippingAmountMinor,
                submittedCodes: ["SAVE10"],
            },
            applied: resolution.evaluation.applied,
        }, "cust_1", cart.evaluatedAtEpochSeconds)).resolves.toMatchObject({
            totalDiscountMinor: 1_000,
        });

        sqlite!.exec(`
            ${orderSql("order_1", "item_1")}
            INSERT INTO order_discount_allocations (
                id, order_id, order_item_id, promotion_id, effect_id,
                promotion_revision, evaluator_version, method, promotion_name,
                promotion_code, effect_kind, target, currency_code,
                base_amount_minor, discount_amount_minor, quantity
            ) SELECT
                'allocation_1', 'order_1', 'item_1', '${created.id}', id,
                2, 1, 'code', 'Checkout ten percent', 'SAVE10',
                'percentage_off', 'order', 'BDT', 10000, 1000, 1
            FROM promotion_effects
            WHERE promotion_id = '${created.id}' AND deleted_at IS NULL;
            INSERT INTO promotion_redemptions (
                id, promotion_id, order_id, customer_id, promotion_revision,
                promotion_code, currency_code, discount_amount_minor
            ) VALUES (
                'pred_1', '${created.id}', 'order_1', 'cust_1', 2,
                'SAVE10', 'BDT', 1000
            );
        `);
        await expect(evaluateStorefrontPromotionCode(db, {
            code: "SAVE10",
            cart,
            customerId: "cust_1",
        })).resolves.toMatchObject({
            matched: true,
            valid: false,
            reason: "customer_redemption_limit_reached",
        });
        const guestCustomerId = await resolvePromotionCustomerIdByPhone(db, "+8801700000001");
        expect(guestCustomerId).toBe("cust_1");
        await expect(evaluateStorefrontPromotionCode(db, {
            code: "SAVE10",
            cart,
            customerId: guestCustomerId,
        })).resolves.toMatchObject({
            valid: false,
            reason: "customer_redemption_limit_reached",
        });
        await expect(evaluateStorefrontPromotionCode(db, {
            code: "SAVE10",
            cart: { ...cart, currencyCode: "USD" },
            customerId: "cust_2",
        })).resolves.toMatchObject({
            valid: false,
            reason: "budget_currency_mismatch",
        });
        await expect(evaluateStorefrontPromotionCode(db, {
            code: "OLD10",
            cart,
            customerId: "cust_2",
        })).resolves.toMatchObject({
            matched: true,
            valid: false,
            reason: "code_not_submitted",
        });

        await expect(pausePromotion(db, created.id, 1)).rejects.toBeInstanceOf(
            PromotionRevisionConflictError,
        );
        await expect(pausePromotion(db, created.id, 2)).resolves.toEqual({
            id: created.id,
            revision: 3,
            status: "paused",
        });
    });

    it("requires an active code and an effect before activation", async () => {
        const db = setup();
        const created = await createPromotionDraft(db, {
            name: "Activation guard",
            title: null,
            method: "code",
            priority: 100,
            conflictPolicy: "best",
            startsAtEpochSeconds: null,
            endsAtEpochSeconds: null,
            timezone: "Asia/Dhaka",
            maxRedemptions: null,
            maxRedemptionsPerCustomer: null,
            maxDiscountSpendMinor: null,
            budgetCurrencyCode: null,
            codes: [{ code: "GUARD10", isActive: false }],
            conditions: [],
            effects: [{
                kind: "percentage_off",
                target: "order",
                allocation: "once",
                config: { basisPoints: 1_000 },
            }],
        });

        await expect(activatePromotion(db, created.id, 1)).rejects.toThrow(
            "Activate at least one promotion code",
        );
        sqlite!.exec(`
            UPDATE promotion_codes SET is_active = 1 WHERE promotion_id = '${created.id}';
            DELETE FROM promotion_effects WHERE promotion_id = '${created.id}';
        `);
        await expect(activatePromotion(db, created.id, 1)).rejects.toThrow(
            "Add at least one promotion effect",
        );
    });
});
