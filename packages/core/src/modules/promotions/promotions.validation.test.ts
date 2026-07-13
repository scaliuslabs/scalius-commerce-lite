import { describe, expect, it } from "vitest";

import {
    createMerchantPromotionDraftSchema,
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

    it("keeps automatic rules out of the merchant API until checkout supports them", () => {
        expect(createPromotionDraftSchema.safeParse({
            ...validDraft(),
            method: "automatic",
            codes: [],
        }).success).toBe(true);
        expect(createMerchantPromotionDraftSchema.safeParse({
            ...validDraft(),
            method: "automatic",
            codes: [],
        }).success).toBe(false);
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
});
