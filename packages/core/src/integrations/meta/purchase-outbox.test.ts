import { describe, expect, it } from "vitest";
import { OrderStatus, PaymentMethod, PaymentStatus } from "@scalius/database/schema";

import {
    buildMetaPurchaseEvent,
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
