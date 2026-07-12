import { describe, expect, it } from "vitest";
import { normalizeAbandonedCheckoutSnapshot } from "./abandoned-checkout-snapshot";

const CHECKOUT_ID = "chk_session_1234567890abcdef";

describe("abandoned checkout snapshot normalization", () => {
    it("persists only recovery-relevant bounded fields", () => {
        const normalized = normalizeAbandonedCheckoutSnapshot({
            checkoutId: CHECKOUT_ID,
            customerPhone: "  +8801712345678  ",
            checkoutData: {
                customerName: " Buyer ",
                customerEmail: "buyer@example.com",
                notes: "Call after 5pm",
                csrfToken: "must-not-be-persisted",
                gatewayPayload: { secret: "must-not-be-persisted" },
                cart: {
                    items: [{
                        id: "prod_1",
                        variantId: "var_1",
                        name: "Trainer",
                        quantity: 2,
                        price: 1200,
                        image: "https://example.com/large-or-signed-url",
                        options: [{ name: "Color", value: "Sand" }],
                        injected: "ignored",
                    }],
                    totalAmount: 2400,
                    discount: { code: "SAVE", discountAmount: 100, internalId: "ignored" },
                },
            },
        });

        expect(normalized.customerPhone).toBe("+8801712345678");
        expect(normalized.checkoutData).toEqual({
            customerName: "Buyer",
            customerEmail: "buyer@example.com",
            notes: "Call after 5pm",
            cart: {
                items: [{
                    id: "prod_1",
                    variantId: "var_1",
                    name: "Trainer",
                    quantity: 2,
                    price: 1200,
                    options: [{ name: "Color", value: "Sand" }],
                }],
                totalAmount: 2400,
                discount: { code: "SAVE", discountAmount: 100 },
            },
        });
        expect(normalized.checkoutDataString).not.toContain("csrfToken");
        expect(normalized.checkoutDataString).not.toContain("gatewayPayload");
        expect(normalized.checkoutDataString).not.toContain("signed-url");
    });

    it("drops malformed cart rows and derives a truthful snapshot total", () => {
        const normalized = normalizeAbandonedCheckoutSnapshot({
            checkoutId: CHECKOUT_ID,
            checkoutData: {
                customerPhone: "01700000000",
                cart: {
                    items: [
                        { id: "prod_1", name: "Rice", quantity: 3, price: 150 },
                        { id: "bad", name: "Missing price", quantity: 1 },
                    ],
                    totalAmount: Number.NaN,
                },
            },
        });

        expect(normalized.customerPhone).toBe("01700000000");
        expect(normalized.checkoutData.cart).toEqual({
            items: [{ id: "prod_1", name: "Rice", quantity: 3, price: 150 }],
            totalAmount: 450,
            discount: null,
        });
    });

    it("rejects guessable or non-session identifiers", () => {
        expect(() => normalizeAbandonedCheckoutSnapshot({
            checkoutId: "checkout_1",
            checkoutData: {},
        })).toThrow("Invalid checkout session identifier");
    });
});

