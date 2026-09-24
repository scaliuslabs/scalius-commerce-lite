import { describe, expect, it } from "vitest";

import {
    createPromotionDraftSchema,
    updatePromotionDraftSchema,
} from "./promotions.validation";

function validDraft() {
    return {
        name: "Ten percent code",
        title: null,
        method: "code" as const,
        priority: 100,
        conflictPolicy: "best" as const,
        startsAtEpochSeconds: null,
        endsAtEpochSeconds: null,
        timezone: "Asia/Dhaka",
        codes: [{ code: " save10 ", isActive: true }],
        conditions: [{
            kind: "minimum_merchandise_subtotal" as const,
            config: { amountMinor: 1_000, currencyCode: "BDT" },
        }],
        effects: [{
            kind: "percentage_off" as const,
            target: "order" as const,
            allocation: "once" as const,
            config: { basisPoints: 1_000 },
        }],
    };
}

describe("promotion draft validation", () => {
    it("normalizes code identity and preserves the bounded evaluator vocabulary", () => {
        expect(createPromotionDraftSchema.parse(validDraft())).toMatchObject({
            method: "code",
            codes: [{ code: "SAVE10", isActive: true }],
            conditions: [{ kind: "minimum_merchandise_subtotal" }],
            effects: [{ kind: "percentage_off", target: "order", allocation: "once" }],
        });
    });

    it("rejects ambiguous code, target, schedule, allocation, and timezone state", () => {
        expect(createPromotionDraftSchema.safeParse({
            ...validDraft(),
            timezone: "Not/A_Real_Zone",
            startsAtEpochSeconds: 200,
            endsAtEpochSeconds: 100,
            codes: [
                { code: "SAVE10", isActive: true },
                { code: "save10", isActive: false },
            ],
            effects: [
                validDraft().effects[0],
                {
                    kind: "fixed_amount_off",
                    target: "order",
                    allocation: "across",
                    config: { amountMinor: 100, currencyCode: "BDT" },
                },
            ],
        }).success).toBe(false);
    });

    it("accepts automatic discounts without usage limits only", () => {
        const automatic = { ...validDraft(), method: "automatic" as const, codes: [] };
        expect(createPromotionDraftSchema.safeParse(automatic).success).toBe(true);
        expect(createPromotionDraftSchema.safeParse({ ...automatic, maxRedemptions: 5 }).success).toBe(false);
    });

    it("keeps product scope on product discounts and validates Buy X get Y", () => {
        const scopedOrder = {
            ...validDraft(),
            effects: [{ ...validDraft().effects[0]!, config: { basisPoints: 1_000, productIds: ["prod_1"] } }],
        };
        expect(createPromotionDraftSchema.safeParse(scopedOrder).success).toBe(false);
        const bxgy = (config: Record<string, unknown>) => ({
            ...validDraft(),
            effects: [{ kind: "percentage_off" as const, target: "line" as const, allocation: "across" as const, config }],
        });
        expect(createPromotionDraftSchema.safeParse(bxgy({
            basisPoints: 10_000, productIds: ["prod_2"], getQuantity: 1, buy: { quantity: 2, productIds: ["prod_1"] },
        })).success).toBe(true);
        expect(createPromotionDraftSchema.safeParse(bxgy({
            basisPoints: 10_000, productIds: ["prod_2"], buy: { quantity: 2, productIds: ["prod_1"] },
        })).success).toBe(false);
        expect(createPromotionDraftSchema.safeParse(bxgy({
            basisPoints: 10_000, productIds: ["prod_2"], getQuantity: 1, buy: { quantity: 2, amountMinor: 100, currencyCode: "BDT" },
        })).success).toBe(false);
        expect(createPromotionDraftSchema.safeParse(bxgy({
            basisPoints: 1_000, productIds: Array.from({ length: 91 }, (_, index) => `prod_${index}`),
        })).success).toBe(false);
    });

    it("rejects a spend budget that can never share a cart currency with its rules", () => {
        expect(createPromotionDraftSchema.safeParse({
            ...validDraft(),
            maxDiscountSpendMinor: 10_000,
            budgetCurrencyCode: "USD",
        })).toMatchObject({ success: false });
        expect(createPromotionDraftSchema.safeParse({
            ...validDraft(),
            maxDiscountSpendMinor: 10_000,
            budgetCurrencyCode: "BDT",
        })).toMatchObject({ success: true });
    });

    it("requires an explicit positive revision for replacement writes", () => {
        expect(updatePromotionDraftSchema.safeParse({
            ...validDraft(),
            expectedRevision: 0,
        }).success).toBe(false);
        expect(updatePromotionDraftSchema.safeParse({
            ...validDraft(),
            expectedRevision: 3,
        }).success).toBe(true);
    });

    it("refuses paisa in a taka discount, minimum or budget", () => {
        const result = createPromotionDraftSchema.safeParse({
            ...validDraft(),
            maxDiscountSpendMinor: 50_050,
            budgetCurrencyCode: "BDT",
            conditions: [{ kind: "minimum_merchandise_subtotal", config: { amountMinor: 1_050, currencyCode: "BDT" } }],
            effects: [{
                kind: "fixed_amount_off",
                target: "order",
                allocation: "once",
                config: { amountMinor: 4_050, currencyCode: "BDT" },
            }],
        });
        expect(result.success).toBe(false);
        const issues = result.success ? [] : result.error.issues
            .filter((issue) => issue.message === "Taka amounts are whole numbers.")
            .map((issue) => issue.path.join("."));
        expect(issues.sort()).toEqual(["conditions.0.config.amountMinor", "effects.0.config.amountMinor", "maxDiscountSpendMinor"]);

        expect(createPromotionDraftSchema.safeParse({
            ...validDraft(),
            effects: [{
                kind: "fixed_amount_off",
                target: "order",
                allocation: "once",
                config: { amountMinor: 4_050, currencyCode: "USD" },
            }],
            conditions: [],
        }).error?.issues ?? []).toEqual([]);
    });
});
