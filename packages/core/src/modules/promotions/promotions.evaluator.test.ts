import { describe, expect, it } from "vitest";

import {
    discountsCombine,
    evaluatePromotionCandidates,
    PROMOTION_EVALUATOR_VERSION,
    PromotionEvaluationInputError,
    type PromotionCandidate,
    type PromotionEvaluationCart,
} from "./promotions.evaluator";

const now = 1_800_000_000;
const NONE = { product: false, order: false, shipping: false };
const ALL = { product: true, order: true, shipping: true };

type Line = PromotionEvaluationCart["lines"][number];

function line(id: string, unitPriceMinor: number, quantity: number, extra: Partial<Line> = {}): Line {
    return { id, productId: `prod_${id}`, variantId: `var_${id}`, unitPriceMinor, quantity, collectionIds: [], ...extra };
}

function cart(overrides: Partial<PromotionEvaluationCart> = {}): PromotionEvaluationCart {
    return {
        currencyCode: "BDT",
        lines: [line("a", 500, 2), line("b", 500, 1)],
        shippingAmountMinor: 100,
        submittedCodes: [],
        evaluatedAtEpochSeconds: now,
        ...overrides,
    };
}

type Effect = PromotionCandidate["effects"][number];

const lineEffect = (config: Record<string, unknown>, kind: "percentage_off" | "fixed_amount_off" = "percentage_off") =>
    ({ id: "eff_line", kind, target: "line", allocation: "across", config }) as Effect;
const orderEffect = (config: Record<string, unknown>, kind: "percentage_off" | "fixed_amount_off" = "percentage_off") =>
    ({ id: "eff_order", kind, target: "order", allocation: "once", config }) as Effect;
const freeShipping = { id: "eff_ship", kind: "free", target: "shipping", allocation: "once", config: {} } as Effect;

function candidate(id: string, effect: Effect, overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
    return {
        id,
        revision: 1,
        name: id,
        method: "automatic",
        status: "active",
        priority: 100,
        conflictPolicy: "best",
        combinesWith: NONE,
        startsAtEpochSeconds: null,
        endsAtEpochSeconds: null,
        maxRedemptions: null,
        maxRedemptionsPerCustomer: null,
        maxDiscountSpendMinor: null,
        budgetCurrencyCode: null,
        redemptionCount: 0,
        customerRedemptionCount: 0,
        discountSpendMinor: 0,
        codes: [],
        conditions: [],
        effects: [effect],
        ...overrides,
    };
}

function evaluate(lines: PromotionEvaluationCart | Partial<PromotionEvaluationCart>, candidates: unknown[]) {
    return evaluatePromotionCandidates({ cart: cart(lines), candidates });
}

function lineDiscounts(result: ReturnType<typeof evaluate>): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const allocation of result.applied?.allocations ?? []) {
        const key = allocation.lineId ?? "shipping";
        totals[key] = (totals[key] ?? 0) + allocation.discountAmountMinor;
    }
    return totals;
}

describe("discount evaluator", () => {
    it("turns a product percentage into immutable per-line allocation facts", () => {
        const result = evaluate({}, [candidate("p10", lineEffect({ basisPoints: 1_000 }))]);
        expect(result.applied).toEqual({
            totalDiscountMinor: 150,
            discounts: [{
                promotionId: "p10",
                promotionRevision: 1,
                promotionName: "p10",
                method: "automatic",
                promotionCode: null,
                discountClass: "product",
                totalDiscountMinor: 150,
            }],
            allocations: [
                expect.objectContaining({ lineId: "a", quantity: 2, baseAmountMinor: 1_000, discountAmountMinor: 100, evaluatorVersion: PROMOTION_EVALUATOR_VERSION }),
                expect.objectContaining({ lineId: "b", quantity: 1, baseAmountMinor: 500, discountAmountMinor: 50 }),
            ],
        });
    });

    it("limits product discounts to chosen products and collections", () => {
        const lines = [
            line("a", 1_000, 1),
            line("b", 1_000, 1, { collectionIds: ["col_summer"] }),
            line("c", 1_000, 1),
        ];
        const byProduct = evaluate({ lines }, [candidate("p", lineEffect({ basisPoints: 5_000, productIds: ["prod_a"] }))]);
        expect(lineDiscounts(byProduct)).toEqual({ a: 500 });
        const byCollection = evaluate({ lines }, [candidate("c", lineEffect({ basisPoints: 5_000, collectionIds: ["col_summer"] }))]);
        expect(lineDiscounts(byCollection)).toEqual({ b: 500 });
        const either = evaluate({ lines }, [candidate("e", lineEffect({ basisPoints: 5_000, productIds: ["prod_c"], collectionIds: ["col_summer"] }))]);
        expect(lineDiscounts(either)).toEqual({ b: 500, c: 500 });
        const none = evaluate({ lines }, [candidate("n", lineEffect({ basisPoints: 5_000, productIds: ["prod_other"] }))]);
        expect(none.applied).toBeNull();
        expect(none.rejected).toEqual([{ promotionId: "n", reason: "no_savings" }]);
    });

    it("counts scoped requirements only over the chosen items", () => {
        const scoped = candidate("s", lineEffect({ basisPoints: 1_000, productIds: ["prod_a"] }), {
            conditions: [{ id: "c1", kind: "minimum_item_quantity", config: { quantity: 3, productIds: ["prod_a"] } }],
        });
        expect(evaluate({}, [scoped]).rejected).toEqual([{ promotionId: "s", reason: "minimum_quantity_not_met" }]);
        const lines = [line("a", 500, 3), line("b", 500, 1)];
        expect(lineDiscounts(evaluate({ lines }, [scoped]))).toEqual({ a: 150 });
        const subtotal = candidate("t", orderEffect({ basisPoints: 1_000 }), {
            conditions: [{ id: "c2", kind: "minimum_merchandise_subtotal", config: { amountMinor: 1_600, currencyCode: "BDT" } }],
        });
        expect(evaluate({}, [subtotal]).rejected).toEqual([{ promotionId: "t", reason: "minimum_subtotal_not_met" }]);
    });

    it("applies a fixed product amount once per order or to each item, never above the price", () => {
        const lines = [line("a", 300, 2), line("b", 50, 1)];
        const once = evaluate({ lines }, [candidate("once", lineEffect({ amountMinor: 100, currencyCode: "BDT" }, "fixed_amount_off"))]);
        expect(once.applied?.totalDiscountMinor).toBe(100);
        expect(lineDiscounts(once)).toEqual({ a: 92, b: 8 });
        const each = evaluate({ lines }, [candidate("each", lineEffect({ amountMinor: 100, currencyCode: "BDT", eachItem: true }, "fixed_amount_off"))]);
        expect(lineDiscounts(each)).toEqual({ a: 200, b: 50 });
    });

    it("combines discounts of different classes when either one allows it", () => {
        const product = candidate("prod", lineEffect({ basisPoints: 1_000 }), { combinesWith: { product: false, order: true, shipping: false } });
        const order = candidate("order", orderEffect({ amountMinor: 135, currencyCode: "BDT" }, "fixed_amount_off"));
        const shipping = candidate("ship", freeShipping);
        const result = evaluate({}, [product, order, shipping]);
        // The product discount's own checkbox is enough to stack with the order discount.
        expect(result.applied?.discounts.map(({ promotionId }) => promotionId)).toEqual(["prod", "order"]);
        // The order discount applies to the subtotal left after the product discount.
        expect(lineDiscounts(result)).toEqual({ a: 100 + 90, b: 50 + 45 });
        expect(result.applied?.totalDiscountMinor).toBe(285);
        expect(result.rejected).toEqual([{ promotionId: "ship", reason: "lower_savings", evaluatedSavingsMinor: 100 }]);

        const withShipping = evaluate({}, [product, order, { ...shipping, combinesWith: { product: true, order: true, shipping: false } }]);
        expect(withShipping.applied?.totalDiscountMinor).toBe(385);
        expect(lineDiscounts(withShipping).shipping).toBe(100);
        expect(discountsCombine(
            { discountClass: "order", combinesWith: NONE },
            { discountClass: "order", combinesWith: ALL },
        )).toBe(false);
    });

    it("bundles free shipping with a product discount, checking its minimum after the discount", () => {
        const bundle = (minimumMinor: number) => candidate("bundle", lineEffect({ basisPoints: 2_000 }), {
            effects: [lineEffect({ basisPoints: 2_000 }), freeShipping],
            conditions: [{ id: "c_ship", kind: "minimum_merchandise_subtotal", config: { amountMinor: minimumMinor, currencyCode: "BDT", shippingOnly: true } }],
        });
        // 1500 subtotal − 20% = 1200 after the discount.
        const met = evaluate({}, [bundle(1_200)]);
        expect(met.applied?.discounts).toEqual([expect.objectContaining({ promotionId: "bundle", totalDiscountMinor: 400 })]);
        expect(lineDiscounts(met)).toEqual({ a: 200, b: 100, shipping: 100 });
        const short = evaluate({}, [bundle(1_300)]);
        expect(lineDiscounts(short)).toEqual({ a: 200, b: 100 });
        // A standalone free-shipping minimum also counts what is left after other savings.
        const product = candidate("prod", lineEffect({ basisPoints: 2_000 }), { combinesWith: ALL });
        const shipping = (amountMinor: number) => candidate("ship", freeShipping, {
            conditions: [{ id: "c", kind: "minimum_merchandise_subtotal", config: { amountMinor, currencyCode: "BDT" } }],
        });
        expect(lineDiscounts(evaluate({}, [product, shipping(1_200)])).shipping).toBe(100);
        const blocked = evaluate({}, [product, shipping(1_300)]);
        expect(lineDiscounts(blocked).shipping).toBeUndefined();
        expect(blocked.rejected).toEqual([{ promotionId: "ship", reason: "minimum_subtotal_not_met", evaluatedSavingsMinor: 100 }]);
    });

    it("chooses the single best discount when they do not combine", () => {
        const small = candidate("small", orderEffect({ basisPoints: 1_000 }));
        const big = candidate("big", lineEffect({ basisPoints: 2_000 }));
        const result = evaluate({}, [small, big]);
        expect(result.applied?.discounts.map(({ promotionId }) => promotionId)).toEqual(["big"]);
        expect(result.rejected).toEqual([{ promotionId: "small", reason: "lower_savings", evaluatedSavingsMinor: 150 }]);
    });

    it("breaks equal savings by lower priority, then id, regardless of input order", () => {
        const a = candidate("zeta", orderEffect({ basisPoints: 1_000 }), { priority: 5 });
        const b = candidate("alpha", orderEffect({ basisPoints: 1_000 }), { priority: 10 });
        const c = candidate("beta", orderEffect({ basisPoints: 1_000 }), { priority: 10 });
        for (const order of [[a, b, c], [c, b, a], [b, c, a]]) {
            expect(evaluate({}, order).applied?.discounts[0]?.promotionId).toBe("zeta");
        }
        expect(evaluate({}, [b, c]).applied?.discounts[0]?.promotionId).toBe("alpha");
    });

    describe("buy X get Y", () => {
        const bxgy = (config: Record<string, unknown>, id = "bxgy") => candidate(id, lineEffect({
            basisPoints: 10_000,
            collectionIds: ["col"],
            getQuantity: 1,
            buy: { quantity: 2, collectionIds: ["col"] },
            ...config,
        }));

        it("gives the cheapest qualifying unit free once the customer buys enough", () => {
            const lines = [
                line("shirt", 1_000, 2, { collectionIds: ["col"] }),
                line("socks", 200, 1, { collectionIds: ["col"] }),
                line("hat", 5_000, 1),
            ];
            const result = evaluate({ lines }, [bxgy({})]);
            expect(lineDiscounts(result)).toEqual({ socks: 200 });
            // Two shirts are only the "buy" half: the customer still has to add the free item.
            const notYet = evaluate({ lines: [line("shirt", 1_000, 2, { collectionIds: ["col"] })] }, [bxgy({})]);
            expect(notYet.applied).toBeNull();
            expect(notYet.rejected).toEqual([{ promotionId: "bxgy", reason: "get_items_missing" }]);
            const tooFew = evaluate({ lines: [line("shirt", 1_000, 1, { collectionIds: ["col"] })] }, [bxgy({})]);
            expect(tooFew.rejected).toEqual([{ promotionId: "bxgy", reason: "buy_requirement_not_met" }]);
        });

        it("repeats per set of items up to the per-order cap and never discounts a unit twice", () => {
            const lines = [line("x", 100, 9, { collectionIds: ["col"] })];
            expect(lineDiscounts(evaluate({ lines }, [bxgy({})]))).toEqual({ x: 300 });
            expect(lineDiscounts(evaluate({ lines }, [bxgy({ maxUsesPerOrder: 2 })]))).toEqual({ x: 200 });
            const half = evaluate({ lines }, [bxgy({ basisPoints: 5_000, maxUsesPerOrder: 1 })]);
            expect(lineDiscounts(half)).toEqual({ x: 50 });
        });

        it("uses different buy and get products and an amount threshold", () => {
            const lines = [
                line("phone", 20_000, 1),
                line("case", 1_500, 3),
            ];
            const rule = candidate("amount", lineEffect({
                basisPoints: 10_000,
                productIds: ["prod_case"],
                getQuantity: 1,
                buy: { amountMinor: 15_000, currencyCode: "BDT", productIds: ["prod_phone"] },
            }));
            expect(lineDiscounts(evaluate({ lines }, [rule]))).toEqual({ case: 1_500 });
        });
    });

    it("never applies paused, draft, archived, not-yet-started, or ended discounts", () => {
        const base = (id: string, overrides: Partial<PromotionCandidate>) =>
            candidate(id, orderEffect({ basisPoints: 1_000 }), overrides);
        const result = evaluate({}, [
            base("paused", { status: "paused" }),
            base("draft", { status: "draft" }),
            base("archived", { status: "archived" }),
            base("future", { startsAtEpochSeconds: now + 1 }),
            base("ended", { endsAtEpochSeconds: now }),
            base("starts-now", { startsAtEpochSeconds: now, endsAtEpochSeconds: now + 1 }),
        ]);
        expect(result.applied?.discounts.map(({ promotionId }) => promotionId)).toEqual(["starts-now"]);
        expect(Object.fromEntries(result.rejected.map(({ promotionId, reason }) => [promotionId, reason]))).toEqual({
            paused: "inactive", draft: "inactive", archived: "inactive", future: "not_started", ended: "expired",
        });
    });

    it("applies codes only when submitted and enforces their usage limits", () => {
        const code = candidate("code", orderEffect({ basisPoints: 1_000 }), {
            method: "code",
            codes: [{ code: "SAVE10", isActive: true }],
            maxRedemptions: 5,
            maxRedemptionsPerCustomer: 1,
        });
        expect(evaluate({}, [code]).rejected).toEqual([{ promotionId: "code", reason: "code_not_submitted" }]);
        expect(evaluate({ submittedCodes: [" save10 "] }, [code]).applied?.discounts[0]?.promotionCode).toBe("SAVE10");
        expect(evaluate({ submittedCodes: ["SAVE10"] }, [{ ...code, redemptionCount: 5 }]).rejected)
            .toEqual([{ promotionId: "code", reason: "redemption_limit_reached" }]);
        expect(evaluate({ submittedCodes: ["SAVE10"] }, [{ ...code, customerRedemptionCount: 1 }]).rejected)
            .toEqual([{ promotionId: "code", reason: "customer_redemption_limit_reached" }]);
        expect(evaluate({ submittedCodes: ["NOPE"] }, [code]).unmatchedCodes).toEqual(["NOPE"]);
    });

    it("rejects broken rules instead of guessing", () => {
        const twoEffects = { ...candidate("two", orderEffect({ basisPoints: 1_000 })), effects: [orderEffect({ basisPoints: 1 }), lineEffect({ basisPoints: 1 })] };
        const limitedAutomatic = candidate("auto", orderEffect({ basisPoints: 1_000 }), { maxRedemptions: 3 });
        const scopedOrder = candidate("scoped", orderEffect({ basisPoints: 1_000, productIds: ["prod_a"] }));
        const result = evaluate({}, [twoEffects, limitedAutomatic, scopedOrder, { id: "junk" }]);
        expect(result.applied).toBeNull();
        expect(result.rejected.map(({ reason }) => reason)).toEqual(Array(4).fill("invalid_configuration"));
        expect(() => evaluatePromotionCandidates({ cart: { ...cart(), lines: [line("a", 1, 1), line("a", 1, 1)] }, candidates: [] }))
            .toThrow(PromotionEvaluationInputError);
    });

    it("keeps money invariants and determinism across many random carts", () => {
        let seed = 7;
        const random = (max: number) => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed % max;
        };
        const collections = ["c1", "c2"];
        for (let run = 0; run < 400; run += 1) {
            const lines = Array.from({ length: 1 + random(5) }, (_, index) => line(`l${index}`, 1 + random(5_000), 1 + random(6), {
                collectionIds: collections.filter(() => random(2) === 0),
            }));
            const combos = () => ({ product: random(2) === 0, order: random(2) === 0, shipping: random(2) === 0 });
            const candidates = [
                candidate("pct", lineEffect({ basisPoints: 1 + random(10_000), collectionIds: ["c1"] }), { combinesWith: combos() }),
                candidate("fixed", lineEffect({ amountMinor: 1 + random(3_000), currencyCode: "BDT", eachItem: random(2) === 0 }, "fixed_amount_off"), { combinesWith: combos() }),
                candidate("order", orderEffect({ amountMinor: 1 + random(20_000), currencyCode: "BDT" }, "fixed_amount_off"), { combinesWith: combos() }),
                candidate("orderpct", orderEffect({ basisPoints: 1 + random(10_000) }), { combinesWith: combos(), priority: random(3) }),
                candidate("ship", freeShipping, { combinesWith: combos() }),
                candidate("bxgy", lineEffect({ basisPoints: 1 + random(10_000), collectionIds: ["c2"], getQuantity: 1 + random(2), buy: { quantity: 1 + random(3), collectionIds: ["c1"] } }), { combinesWith: combos() }),
            ];
            const input = cart({ lines, shippingAmountMinor: random(500) });
            const result = evaluatePromotionCandidates({ cart: input, candidates });
            const reversed = evaluatePromotionCandidates({
                cart: { ...input, lines: [...lines].reverse() },
                candidates: [...candidates].reverse(),
            });
            expect(reversed).toEqual(result);
            if (!result.applied) continue;
            const perLine = lineDiscounts(result);
            for (const cartLine of lines) {
                expect(perLine[cartLine.id] ?? 0).toBeLessThanOrEqual(cartLine.unitPriceMinor * cartLine.quantity);
            }
            expect(perLine.shipping ?? 0).toBeLessThanOrEqual(input.shippingAmountMinor);
            const allocated = result.applied.allocations.reduce((sum, allocation) => {
                expect(allocation.discountAmountMinor).toBeGreaterThan(0);
                expect(Number.isInteger(allocation.discountAmountMinor)).toBe(true);
                expect(allocation.discountAmountMinor).toBeLessThanOrEqual(allocation.baseAmountMinor);
                return sum + allocation.discountAmountMinor;
            }, 0);
            expect(allocated).toBe(result.applied.totalDiscountMinor);
            expect(result.applied.discounts.reduce((sum, { totalDiscountMinor }) => sum + totalDiscountMinor, 0)).toBe(allocated);
            const classes = result.applied.discounts.map(({ discountClass }) => discountClass);
            expect(new Set(classes).size).toBe(classes.length);
            // Every pair of applied discounts may combine (either side allows it).
            const byId = new Map(candidates.map((item) => [item.id, item]));
            for (const left of result.applied.discounts) {
                for (const right of result.applied.discounts) {
                    if (left === right) continue;
                    expect(discountsCombine(
                        { discountClass: left.discountClass, combinesWith: byId.get(left.promotionId)!.combinesWith },
                        { discountClass: right.discountClass, combinesWith: byId.get(right.promotionId)!.combinesWith },
                    )).toBe(true);
                }
            }
        }
    });
});
