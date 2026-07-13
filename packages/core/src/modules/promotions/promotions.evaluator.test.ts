import { describe, expect, it } from "vitest";

import {
    evaluatePromotionCandidates,
    PROMOTION_EVALUATOR_VERSION,
    PromotionEvaluationInputError,
    type PromotionCandidate,
    type PromotionEvaluationCart,
} from "./promotions.evaluator";

const evaluatedAtEpochSeconds = 1_800_000_000;

function cart(
    overrides: Partial<PromotionEvaluationCart> = {},
): PromotionEvaluationCart {
    return {
        currencyCode: "BDT",
        lines: [
            {
                id: "line_a",
                productId: "prod_a",
                variantId: "var_a",
                unitPriceMinor: 500,
                quantity: 2,
            },
            {
                id: "line_b",
                productId: "prod_b",
                variantId: "var_b",
                unitPriceMinor: 500,
                quantity: 1,
            },
        ],
        shippingAmountMinor: 100,
        submittedCodes: [],
        evaluatedAtEpochSeconds,
        ...overrides,
    };
}

function candidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
    return {
        id: "promo_default",
        revision: 3,
        name: "Default promotion",
        method: "automatic",
        status: "active",
        priority: 100,
        conflictPolicy: "best",
        startsAtEpochSeconds: null,
        endsAtEpochSeconds: null,
        codes: [],
        conditions: [],
        effects: [
            {
                id: "effect_order",
                kind: "percentage_off",
                target: "order",
                allocation: "once",
                config: { basisPoints: 1_000 },
            },
        ],
        ...overrides,
    };
}

describe("promotion evaluator", () => {
    it("evaluates an automatic percentage promotion into immutable allocation facts", () => {
        const result = evaluatePromotionCandidates({
            cart: cart(),
            candidates: [candidate()],
        });

        expect(result).toEqual({
            evaluatorVersion: PROMOTION_EVALUATOR_VERSION,
            applied: {
                promotionId: "promo_default",
                promotionRevision: 3,
                promotionName: "Default promotion",
                method: "automatic",
                promotionCode: null,
                totalDiscountMinor: 150,
                allocations: [
                    {
                        promotionId: "promo_default",
                        promotionRevision: 3,
                        evaluatorVersion: PROMOTION_EVALUATOR_VERSION,
                        promotionName: "Default promotion",
                        promotionCode: null,
                        method: "automatic",
                        effectId: "effect_order",
                        effectKind: "percentage_off",
                        target: "order",
                        lineId: "line_a",
                        quantity: 2,
                        currencyCode: "BDT",
                        baseAmountMinor: 1_000,
                        discountAmountMinor: 100,
                    },
                    {
                        promotionId: "promo_default",
                        promotionRevision: 3,
                        evaluatorVersion: PROMOTION_EVALUATOR_VERSION,
                        promotionName: "Default promotion",
                        promotionCode: null,
                        method: "automatic",
                        effectId: "effect_order",
                        effectKind: "percentage_off",
                        target: "order",
                        lineId: "line_b",
                        quantity: 1,
                        currencyCode: "BDT",
                        baseAmountMinor: 500,
                        discountAmountMinor: 50,
                    },
                ],
            },
            rejected: [],
            unmatchedCodes: [],
        });
    });

    it("normalizes submitted codes and reports only codes unknown to every candidate", () => {
        const result = evaluatePromotionCandidates({
            cart: cart({ submittedCodes: [" save10 ", "not-a-code"] }),
            candidates: [candidate({
                id: "promo_code",
                name: "Code promotion",
                method: "code",
                codes: [{ code: "SAVE10", isActive: true }],
            })],
        });

        expect(result.applied).toMatchObject({
            promotionId: "promo_code",
            promotionCode: "SAVE10",
            method: "code",
        });
        expect(result.unmatchedCodes).toEqual(["NOT-A-CODE"]);
    });

    it("requires every configured condition to pass", () => {
        const promotion = candidate({
            conditions: [
                {
                    id: "condition_subtotal",
                    kind: "minimum_merchandise_subtotal",
                    config: { amountMinor: 1_500, currencyCode: "BDT" },
                },
                {
                    id: "condition_quantity",
                    kind: "minimum_item_quantity",
                    config: { quantity: 4 },
                },
            ],
        });

        const quantityFailure = evaluatePromotionCandidates({
            cart: cart(),
            candidates: [promotion],
        });
        expect(quantityFailure.applied).toBeNull();
        expect(quantityFailure.rejected).toEqual([{
            promotionId: "promo_default",
            reason: "minimum_quantity_not_met",
        }]);

        const success = evaluatePromotionCandidates({
            cart: cart({
                lines: [
                    {
                        id: "line_a",
                        productId: "prod_a",
                        variantId: "var_a",
                        unitPriceMinor: 500,
                        quantity: 4,
                    },
                ],
            }),
            candidates: [promotion],
        });
        expect(success.applied?.totalDiscountMinor).toBe(200);
    });

    it("applies line, then order, then shipping effects with exact proportional allocation", () => {
        const result = evaluatePromotionCandidates({
            cart: cart({
                lines: [
                    {
                        id: "line_a",
                        productId: "prod_a",
                        variantId: "var_a",
                        unitPriceMinor: 100,
                        quantity: 3,
                    },
                    {
                        id: "line_b",
                        productId: "prod_b",
                        variantId: "var_b",
                        unitPriceMinor: 200,
                        quantity: 1,
                    },
                ],
                shippingAmountMinor: 75,
            }),
            candidates: [candidate({
                effects: [
                    {
                        id: "effect_shipping",
                        kind: "free",
                        target: "shipping",
                        allocation: "once",
                        config: {},
                    },
                    {
                        id: "effect_order",
                        kind: "percentage_off",
                        target: "order",
                        allocation: "once",
                        config: { basisPoints: 1_000 },
                    },
                    {
                        id: "effect_line",
                        kind: "fixed_amount_off",
                        target: "line",
                        allocation: "across",
                        config: { amountMinor: 101, currencyCode: "BDT" },
                    },
                ],
            })],
        });

        expect(result.applied?.totalDiscountMinor).toBe(216);
        expect(result.applied?.allocations.map((allocation) => ({
            effect: allocation.effectId,
            line: allocation.lineId,
            base: allocation.baseAmountMinor,
            discount: allocation.discountAmountMinor,
        }))).toEqual([
            { effect: "effect_line", line: "line_a", base: 300, discount: 61 },
            { effect: "effect_line", line: "line_b", base: 200, discount: 40 },
            { effect: "effect_order", line: "line_a", base: 239, discount: 24 },
            { effect: "effect_order", line: "line_b", base: 160, discount: 16 },
            { effect: "effect_shipping", line: null, base: 75, discount: 75 },
        ]);
    });

    it("selects the greatest saving, then lower priority, then stable ID", () => {
        const result = evaluatePromotionCandidates({
            cart: cart(),
            candidates: [
                candidate({ id: "promo_z", priority: 20 }),
                candidate({ id: "promo_b", priority: 10 }),
                candidate({ id: "promo_a", priority: 10 }),
                candidate({
                    id: "promo_small",
                    effects: [{
                        id: "effect_small",
                        kind: "fixed_amount_off",
                        target: "order",
                        allocation: "once",
                        config: { amountMinor: 100, currencyCode: "BDT" },
                    }],
                }),
            ],
        });

        expect(result.applied?.promotionId).toBe("promo_a");
        expect(result.rejected).toEqual(expect.arrayContaining([
            { promotionId: "promo_b", reason: "lower_savings", evaluatedSavingsMinor: 150 },
            { promotionId: "promo_z", reason: "lower_savings", evaluatedSavingsMinor: 150 },
            { promotionId: "promo_small", reason: "lower_savings", evaluatedSavingsMinor: 100 },
        ]));
    });

    it("treats starts as inclusive and ends as exclusive", () => {
        const atStart = candidate({
            startsAtEpochSeconds: evaluatedAtEpochSeconds,
            endsAtEpochSeconds: evaluatedAtEpochSeconds + 10,
        });
        expect(evaluatePromotionCandidates({
            cart: cart(),
            candidates: [atStart],
        }).applied?.promotionId).toBe("promo_default");

        expect(evaluatePromotionCandidates({
            cart: cart({ evaluatedAtEpochSeconds: evaluatedAtEpochSeconds + 10 }),
            candidates: [atStart],
        }).rejected).toEqual([{
            promotionId: "promo_default",
            reason: "expired",
        }]);
    });

    it("fails closed for malformed, duplicate, or currency-incompatible candidates", () => {
        const result = evaluatePromotionCandidates({
            cart: cart(),
            candidates: [
                candidate({ id: "promo_duplicate" }),
                candidate({ id: "promo_duplicate" }),
                candidate({
                    id: "promo_currency",
                    effects: [{
                        id: "effect_currency",
                        kind: "fixed_amount_off",
                        target: "order",
                        allocation: "once",
                        config: { amountMinor: 100, currencyCode: "USD" },
                    }],
                }),
                {
                    ...candidate({ id: "promo_malformed" }),
                    effects: [{
                        id: "effect_invalid",
                        kind: "free",
                        target: "line",
                        allocation: "across",
                        config: {},
                    }],
                },
            ],
        });

        expect(result.applied).toBeNull();
        expect(result.rejected).toEqual(expect.arrayContaining([
            { promotionId: "promo_duplicate", reason: "invalid_configuration" },
            { promotionId: "promo_currency", reason: "effect_currency_mismatch" },
            { promotionId: "promo_malformed", reason: "invalid_configuration" },
        ]));
    });

    it("treats candidate identity as trimmed and rejects a duplicate only once", () => {
        const result = evaluatePromotionCandidates({
            cart: cart(),
            candidates: [
                candidate({ id: " promo_duplicate " }),
                candidate({ id: "promo_duplicate" }),
            ],
        });

        expect(result.applied).toBeNull();
        expect(result.rejected).toEqual([{
            promotionId: "promo_duplicate",
            reason: "invalid_configuration",
        }]);
    });

    it("returns stable code and rejection output regardless of input order", () => {
        const codePromotion = candidate({
            id: "promo_code",
            method: "code",
            codes: [
                { code: "ZED10", isActive: true },
                { code: "ALPHA10", isActive: true },
            ],
        });
        const smallerPromotion = candidate({
            id: "promo_smaller",
            effects: [{
                id: "effect_smaller",
                kind: "fixed_amount_off",
                target: "order",
                allocation: "once",
                config: { amountMinor: 50, currencyCode: "BDT" },
            }],
        });
        const inactivePromotion = candidate({
            id: "promo_inactive",
            status: "paused",
        });

        const forward = evaluatePromotionCandidates({
            cart: cart({ submittedCodes: ["zed10", "unknown-z", "alpha10", "unknown-a"] }),
            candidates: [codePromotion, smallerPromotion, inactivePromotion],
        });
        const reversed = evaluatePromotionCandidates({
            cart: cart({ submittedCodes: ["unknown-a", "alpha10", "unknown-z", "zed10"] }),
            candidates: [
                inactivePromotion,
                smallerPromotion,
                {
                    ...codePromotion,
                    codes: [...codePromotion.codes].reverse(),
                },
            ],
        });

        expect(forward).toEqual(reversed);
        expect(forward.applied?.promotionCode).toBe("ALPHA10");
        expect(forward.unmatchedCodes).toEqual(["UNKNOWN-A", "UNKNOWN-Z"]);
    });

    it("keeps merchandise allocations stable when cart lines arrive out of order", () => {
        const forwardCart = cart();
        const forward = evaluatePromotionCandidates({
            cart: forwardCart,
            candidates: [candidate()],
        });
        const reversed = evaluatePromotionCandidates({
            cart: cart({ lines: [...forwardCart.lines].reverse() }),
            candidates: [candidate()],
        });

        expect(forward).toEqual(reversed);
    });

    it("rejects duplicate cart-line IDs before allocation", () => {
        const duplicateLine = cart().lines[0];
        expect(() => evaluatePromotionCandidates({
            cart: cart({ lines: [duplicateLine, duplicateLine] }),
            candidates: [candidate()],
        })).toThrow(PromotionEvaluationInputError);
    });
});
