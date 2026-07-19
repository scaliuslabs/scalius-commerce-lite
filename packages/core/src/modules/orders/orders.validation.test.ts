import { describe, expect, it } from "vitest";

import {
    archiveOrdersSchema,
    createOrderSchema,
    restoreOrderSchema,
    updateOrderSchema,
} from "./orders.validation";

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
        ...(isUpdate
            ? { expectedVersion: 1, status: "pending" }
            : { requestKey: crypto.randomUUID() }),
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

describe("manual-order update concurrency", () => {
    it("requires a positive integer version from the form that was loaded", () => {
        const base = { ...orderInput(1), status: "pending" };

        expect(updateOrderSchema.safeParse(base).success).toBe(false);
        expect(updateOrderSchema.safeParse({ ...base, expectedVersion: 0 }).success).toBe(false);
        expect(updateOrderSchema.safeParse({ ...base, expectedVersion: 1.5 }).success).toBe(false);
        expect(updateOrderSchema.safeParse({ ...base, expectedVersion: 3 }).success).toBe(true);
    });
});

describe("manual-order create idempotency", () => {
    it("requires a UUID request key", () => {
        const base = orderInput(1);

        expect(createOrderSchema.safeParse(base).success).toBe(false);
        expect(createOrderSchema.safeParse({ ...base, requestKey: "retry-me" }).success).toBe(false);
        expect(createOrderSchema.safeParse({ ...base, requestKey: crypto.randomUUID() }).success).toBe(true);
    });

    it("rejects an empty order before service or inventory work", () => {
        expect(createOrderSchema.safeParse({
            ...orderInput(1),
            items: [],
            requestKey: crypto.randomUUID(),
        }).success).toBe(false);
    });
});

describe("order archive concurrency", () => {
    it("requires a bounded unique set of browser-loaded revisions", () => {
        expect(archiveOrdersSchema.safeParse({ orders: [] }).success).toBe(false);
        expect(archiveOrdersSchema.safeParse({
            orders: [{ id: "ord_1", expectedVersion: 2 }],
        }).success).toBe(true);
        expect(archiveOrdersSchema.safeParse({
            orders: [
                { id: "ord_1", expectedVersion: 2 },
                { id: "ord_1", expectedVersion: 2 },
            ],
        }).success).toBe(false);
        expect(archiveOrdersSchema.safeParse({
            orders: Array.from({ length: 91 }, (_, index) => ({
                id: `ord_${index}`,
                expectedVersion: 1,
            })),
        }).success).toBe(false);
    });

    it("requires the archived order revision on restore", () => {
        expect(restoreOrderSchema.safeParse({}).success).toBe(false);
        expect(restoreOrderSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
        expect(restoreOrderSchema.safeParse({ expectedVersion: 3 }).success).toBe(true);
    });
});
