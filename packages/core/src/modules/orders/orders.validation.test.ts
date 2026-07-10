import { describe, expect, it } from "vitest";

import { createOrderSchema, updateOrderSchema } from "./orders.validation";

function orderInput(quantity: number) {
    return {
        customerName: "Test Customer",
        customerPhone: "+8801712345678",
        customerEmail: null,
        shippingAddress: "123 Test Street",
        city: "dhaka",
        zone: "gulshan",
        area: null,
        notes: null,
        items: [
            {
                productId: "product_1",
                variantId: "variant_1",
                quantity,
                price: 100,
            },
        ],
        discountAmount: null,
        shippingCharge: 60,
    };
}

describe.each([
    ["create", createOrderSchema, false],
    ["update", updateOrderSchema, true],
] as const)("%s manual-order quantity validation", (_name, schema, isUpdate) => {
    const input = (quantity: number) => ({
        ...orderInput(quantity),
        ...(isUpdate ? { status: "pending" } : {}),
    });

    it.each([1, 99])("accepts boundary quantity %s", (quantity) => {
        expect(schema.safeParse(input(quantity)).success).toBe(true);
    });

    it.each([1.5, 0, 100])("rejects invalid quantity %s", (quantity) => {
        const result = schema.safeParse(input(quantity));
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ path: ["items", 0, "quantity"] }),
                ]),
            );
        }
    });
});
