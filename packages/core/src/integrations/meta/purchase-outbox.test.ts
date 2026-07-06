import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { OrderStatus, PaymentMethod, PaymentStatus } from "@scalius/database/schema";

import {
    buildMetaPurchaseEvent,
    buildMetaPurchaseOutboxClaimInsert,
    createMetaPurchaseOutboxClaimInsertValues,
    createMetaPurchaseEventId,
    isOrderEligibleForMetaPurchase,
} from "./purchase-outbox";

const baseOrder = {
    id: "order_1",
    customerId: "cust_1",
    customerName: "Arob Badhon",
    customerPhone: "01775528888",
    customerEmail: "buyer@example.com",
    city: "dhaka",
    cityName: "Dhaka",
    totalAmount: 1500,
    status: OrderStatus.PENDING,
    paymentMethod: PaymentMethod.COD,
    paymentStatus: PaymentStatus.UNPAID,
    paidAmount: 0,
    deletedAt: null,
};

describe("Meta Purchase outbox event building", () => {
    it("uses the stable order event id", () => {
        expect(createMetaPurchaseEventId("order_1")).toBe("Purchase:order_1");
    });

    it("builds a private-matching purchase payload from committed order data", () => {
        const event = buildMetaPurchaseEvent({
            order: baseOrder,
            items: [
                { productId: "prod_1", variantId: "var_1", quantity: 2, price: 500 },
                { productId: "prod_2", variantId: null, quantity: 1, price: 500 },
            ],
            storefrontUrl: "https://shop.example/",
            currency: "BDT",
            eventTime: 1_800_000_000,
        });

        expect(event).toMatchObject({
            event_name: "Purchase",
            event_id: "Purchase:order_1",
            event_time: 1_800_000_000,
            event_source_url: "https://shop.example/order-success?orderId=order_1",
            action_source: "website",
            user_data: {
                ph: "01775528888",
                em: "buyer@example.com",
                fn: "Arob",
                ln: "Badhon",
                ct: "Dhaka",
                country: "bd",
                external_id: ["cust_1"],
            },
            custom_data: {
                value: 1500,
                currency: "BDT",
                content_ids: ["var_1", "prod_2"],
                content_type: "product_group",
                order_id: "order_1",
                num_items: 3,
            },
        });
    });

    it("builds an idempotent non-PII outbox claim insert for D1 batches", () => {
        const values = createMetaPurchaseOutboxClaimInsertValues({
            orderId: "order_claim_1",
            source: "storefront-order",
            nowSeconds: 1_800_000_000,
        });

        expect(values).toMatchObject({
            orderId: "order_claim_1",
            eventId: "Purchase:order_claim_1",
            source: "storefront-order",
            status: "pending",
            attempts: 0,
            nextAttemptAt: 1_799_999_999,
            createdAt: 1_800_000_000,
            updatedAt: 1_800_000_000,
        });
        expect(String(values.id)).toMatch(/^mcp_/);
        expect(values).not.toHaveProperty("customerName");
        expect(values).not.toHaveProperty("customerPhone");
        expect(values).not.toHaveProperty("customerEmail");

        const statement = { kind: "outbox-claim" };
        const onConflictDoNothing = vi.fn(() => statement);
        const valuesFn = vi.fn(() => ({ onConflictDoNothing }));
        const insert = vi.fn(() => ({ values: valuesFn }));
        const db = { insert } as unknown as Database;

        expect(buildMetaPurchaseOutboxClaimInsert(db, {
            orderId: "order_claim_1",
            source: "storefront-order",
            nowSeconds: 1_800_000_000,
        })).toBe(statement);
        expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({
            orderId: "order_claim_1",
            eventId: "Purchase:order_claim_1",
            source: "storefront-order",
        }));
        expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    });

    it("treats COD placement and paid online orders as purchases, but not incomplete or cancelled orders", () => {
        expect(isOrderEligibleForMetaPurchase(baseOrder)).toBe(true);
        expect(isOrderEligibleForMetaPurchase({
            ...baseOrder,
            paymentMethod: PaymentMethod.STRIPE,
            paymentStatus: PaymentStatus.PAID,
            paidAmount: 1500,
        })).toBe(true);
        expect(isOrderEligibleForMetaPurchase({
            ...baseOrder,
            paymentMethod: PaymentMethod.SSLCOMMERZ,
            paymentStatus: PaymentStatus.PARTIAL,
            paidAmount: 150,
        })).toBe(true);
        expect(isOrderEligibleForMetaPurchase({
            ...baseOrder,
            paymentMethod: PaymentMethod.STRIPE,
            paymentStatus: PaymentStatus.UNPAID,
            status: OrderStatus.INCOMPLETE,
        })).toBe(false);
        expect(isOrderEligibleForMetaPurchase({
            ...baseOrder,
            status: OrderStatus.CANCELLED,
        })).toBe(false);
    });
});
