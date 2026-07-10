import { describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { DiscountType, DiscountValueType } from "@scalius/database/schema";
import { calculateDiscountAmount } from "./discounts.eligibility";

const db = {} as Database;

describe("calculateDiscountAmount currency precision", () => {
    it.each([
        { currencyCode: "JPY", total: 104, expected: 10 },
        { currencyCode: "KWD", total: 1.235, expected: 0.124 },
    ])(
        "rounds percentage discounts using $currencyCode precision",
        async ({ currencyCode, total, expected }) => {
            await expect(calculateDiscountAmount(
                db,
                {
                    id: "discount_percentage",
                    type: DiscountType.AMOUNT_OFF_ORDER,
                    valueType: DiscountValueType.PERCENTAGE,
                    discountValue: 10,
                },
                total,
                [],
                0,
                undefined,
                currencyCode,
            )).resolves.toBe(expected);
        },
    );

    it("uses explicit BDT precision for direct Core callers", async () => {
        await expect(calculateDiscountAmount(
            db,
            {
                id: "discount_percentage",
                type: DiscountType.AMOUNT_OFF_ORDER,
                valueType: DiscountValueType.PERCENTAGE,
                discountValue: 10,
            },
            1.235,
            [],
        )).resolves.toBe(0.12);
    });
});
