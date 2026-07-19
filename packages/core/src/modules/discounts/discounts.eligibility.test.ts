import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { DiscountType, DiscountValueType } from "@scalius/database/schema";
import { calculateDiscountAmount, isDiscountValid } from "./discounts.eligibility";

const db = {} as Database;

function createReadDb(results: Array<{ get?: unknown; all?: unknown[] }>): Database {
    return {
        select: vi.fn(() => {
            const result = results.shift() ?? {};
            const terminal = {
                get: vi.fn(async () => result.get),
                all: vi.fn(async () => result.all ?? []),
            };
            const chain: Record<string, unknown> = {
                ...terminal,
                from: vi.fn(() => chain),
                where: vi.fn(() => chain),
                leftJoin: vi.fn(() => chain),
                limit: vi.fn(() => chain),
            };
            return chain;
        }),
    } as unknown as Database;
}

function discountRow(overrides: Record<string, unknown> = {}) {
    return {
        id: "discount_1",
        code: "SAVE20",
        type: DiscountType.AMOUNT_OFF_ORDER,
        valueType: DiscountValueType.PERCENTAGE,
        discountValue: 20,
        minPurchaseAmount: null,
        minQuantity: null,
        maxUses: null,
        limitOnePerCustomer: false,
        combineWithProductDiscounts: false,
        combineWithOrderDiscounts: false,
        combineWithShippingDiscounts: false,
        ...overrides,
    };
}

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

describe("calculateDiscountAmount product scope", () => {
    const productDiscount = {
        id: "discount_products",
        type: DiscountType.AMOUNT_OFF_PRODUCTS,
        valueType: DiscountValueType.PERCENTAGE,
        discountValue: 20,
    };

    it("fails closed when persisted restrictions resolve to no eligible products", async () => {
        await expect(calculateDiscountAmount(
            db,
            productDiscount,
            1_100,
            [{ id: "cart_product", price: 1_000, quantity: 1 }],
            100,
            new Set(),
            "BDT",
            true,
        )).resolves.toBe(0);
    });

    it("fails closed for legacy product discounts without a saved scope", async () => {
        await expect(calculateDiscountAmount(
            db,
            productDiscount,
            1_100,
            [{ id: "cart_product", price: 1_000, quantity: 1 }],
            100,
            new Set(),
            "BDT",
            false,
        )).resolves.toBe(0);
    });
});

describe("isDiscountValid authority", () => {
    it("does not turn a stale collection restriction into a cart-wide discount", async () => {
        const scopedDb = createReadDb([
            { get: discountRow({ type: DiscountType.AMOUNT_OFF_PRODUCTS }) },
            { all: [] },
            { all: [{ collectionId: "collection_inactive" }] },
            { all: [] },
        ]);

        const result = await isDiscountValid(
            scopedDb,
            "save20",
            1_000,
            [{ id: "cart_product", price: 1_000, quantity: 1 }],
        );

        expect(result).toEqual({
            valid: false,
            error: "Discount code is not applicable to the items in your cart",
        });
    });

    it("does not grant eligibility through an inactive direct product", async () => {
        const scopedDb = createReadDb([
            { get: discountRow({ type: DiscountType.AMOUNT_OFF_PRODUCTS }) },
            { all: [{ productId: "product_inactive" }] },
            { all: [] },
            { all: [] },
        ]);

        const result = await isDiscountValid(
            scopedDb,
            "SAVE20",
            1_000,
            [{ id: "product_inactive", price: 1_000, quantity: 1 }],
        );

        expect(result).toEqual({
            valid: false,
            error: "Discount code is not applicable to the items in your cart",
        });
    });

    it("uses immutable phone redemption claims for one-per-customer checks", async () => {
        const redemptionDb = createReadDb([
            { get: discountRow({ limitOnePerCustomer: true }) },
            { get: { orderId: "order_original" } },
        ]);

        const result = await isDiscountValid(
            redemptionDb,
            " SAVE20 ",
            1_000,
            [],
            " +8801712345678 ",
        );

        expect(result).toEqual({
            valid: false,
            error: "This discount code can only be used once per customer",
        });
    });

    it("asks for customer identity only when a one-use rule needs it", async () => {
        const redemptionDb = createReadDb([
            { get: discountRow({ limitOnePerCustomer: true }) },
        ]);

        const result = await isDiscountValid(
            redemptionDb,
            "SAVE20",
            1_000,
        );

        expect(result).toEqual({
            valid: false,
            error: "Enter your phone number to check this one-use discount",
            requiresCustomerPhone: true,
        });
    });

    it("checks product minimums against eligible lines instead of unrelated cart items", async () => {
        const scopedDb = createReadDb([
            {
                get: discountRow({
                    type: DiscountType.AMOUNT_OFF_PRODUCTS,
                    minPurchaseAmount: 500,
                    minQuantity: 2,
                }),
            },
            { all: [{ productId: "eligible" }] },
            { all: [{ id: "eligible" }] },
            { all: [] },
        ]);

        const result = await isDiscountValid(
            scopedDb,
            "SAVE20",
            10_200,
            [
                { id: "eligible", price: 200, quantity: 1 },
                { id: "unrelated", price: 10_000, quantity: 10 },
            ],
        );

        expect(result).toMatchObject({
            valid: false,
            minPurchaseAmount: 500,
        });
    });

    it("requires a cart total when an order minimum cannot otherwise be evaluated", async () => {
        const totalDb = createReadDb([
            { get: discountRow({ minPurchaseAmount: 500 }) },
        ]);

        const result = await isDiscountValid(totalDb, "SAVE20");

        expect(result).toEqual({
            valid: false,
            error: "Cart total is required to validate this discount",
        });
    });

    it("rejects legacy product discounts that have no explicit scope", async () => {
        const targetlessDb = createReadDb([
            { get: discountRow({ type: DiscountType.AMOUNT_OFF_PRODUCTS }) },
            { all: [] },
            { all: [] },
        ]);

        const result = await isDiscountValid(
            targetlessDb,
            "SAVE20",
            1_000,
            [{ id: "cart_product", price: 1_000, quantity: 1 }],
        );

        expect(result).toEqual({
            valid: false,
            error: "This discount has no eligible products",
        });
    });
});
