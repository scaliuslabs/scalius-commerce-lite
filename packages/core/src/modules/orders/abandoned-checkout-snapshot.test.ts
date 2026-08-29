import { describe, expect, it } from "vitest";
import {
    normalizeAbandonedCheckoutSnapshot,
    projectAbandonedCheckoutAgentSummary,
} from "./abandoned-checkout-snapshot";

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

        expect(normalized.customerPhone).toBeNull();
        expect(normalized.checkoutData).not.toHaveProperty("customerPhone");
        expect(normalized.checkoutData.cart).toEqual({
            items: [{ id: "prod_1", name: "Rice", quantity: 3, price: 150 }],
            totalAmount: 450,
            discount: null,
        });
    });

    it.each([
        { label: "missing", customerPhone: undefined, nestedPhone: undefined },
        { label: "blank", customerPhone: "   ", nestedPhone: " " },
        { label: "partial country code", customerPhone: "+880", nestedPhone: "+880" },
        { label: "invalid legacy value", customerPhone: "01700", nestedPhone: "not-a-phone" },
    ])("keeps a $label phone optional without persisting invalid input", ({ customerPhone, nestedPhone }) => {
        const normalized = normalizeAbandonedCheckoutSnapshot({
            checkoutId: CHECKOUT_ID,
            customerPhone,
            checkoutData: {
                customerPhone: nestedPhone,
                cart: { items: [] },
            },
        });

        expect(normalized.customerPhone).toBeNull();
        expect(normalized.checkoutData).not.toHaveProperty("customerPhone");
        if (customerPhone?.trim()) {
            expect(normalized.checkoutDataString).not.toContain(customerPhone.trim());
        }
        if (nestedPhone?.trim()) {
            expect(normalized.checkoutDataString).not.toContain(nestedPhone.trim());
        }
    });

    it("canonicalizes valid top-level and nested phones to E.164", () => {
        const normalized = normalizeAbandonedCheckoutSnapshot({
            checkoutId: CHECKOUT_ID,
            customerPhone: "+880 1712-345678",
            checkoutData: {
                customerPhone: "+8801712345678",
                cart: { items: [] },
            },
        });

        expect(normalized.customerPhone).toBe("+8801712345678");
        expect(normalized.checkoutData.customerPhone).toBe("+8801712345678");
    });

    it("uses a valid nested phone when the top-level legacy value is invalid", () => {
        const normalized = normalizeAbandonedCheckoutSnapshot({
            checkoutId: CHECKOUT_ID,
            customerPhone: "+880",
            checkoutData: {
                customerPhone: "+880 1712-345678",
                cart: { items: [] },
            },
        });

        expect(normalized.customerPhone).toBe("+8801712345678");
        expect(normalized.checkoutData.customerPhone).toBe("+8801712345678");
    });

    it("rejects guessable or non-session identifiers", () => {
        expect(() => normalizeAbandonedCheckoutSnapshot({
            checkoutId: "checkout_1",
            checkoutData: {},
        })).toThrow("Invalid checkout session identifier");
    });
});

describe("abandoned checkout agent summaries", () => {
    it("summarizes a cart without returning buyer or item fields", () => {
        const summary = projectAbandonedCheckoutAgentSummary(JSON.stringify({
            customerName: "Private Buyer",
            customerPhone: "+8801700000000",
            shippingAddress: "Private address",
            notes: "Private note",
            cart: {
                totalAmount: 1234,
                items: [{ id: "variant_1", name: "Private item" }],
            },
        }), null);

        expect(summary).toEqual({
            kind: "cart",
            stage: "info_captured",
            itemCount: 1,
            total: 1234,
            hasCustomerContact: true,
            orderId: null,
            paymentMethod: null,
            paymentStatus: null,
        });
        expect(JSON.stringify(summary)).not.toContain("Private");
        expect(JSON.stringify(summary)).not.toContain("+880");
    });

    it("summarizes a hosted-payment archive", () => {
        expect(projectAbandonedCheckoutAgentSummary(JSON.stringify({
            id: "order_1",
            paymentMethod: "stripe",
            paymentStatus: "failed",
            totalAmount: 500,
            customerEmail: "buyer@example.com",
        }), null)).toEqual({
            kind: "stale_hosted_payment_order",
            stage: "archived_hosted_payment",
            itemCount: 0,
            total: 500,
            hasCustomerContact: true,
            orderId: "order_1",
            paymentMethod: "stripe",
            paymentStatus: "failed",
        });
    });

    it("fails closed for unreadable persisted data", () => {
        expect(projectAbandonedCheckoutAgentSummary("{bad-json", "+8801712345678")).toEqual({
            kind: "unknown",
            stage: "unreadable",
            itemCount: 0,
            total: 0,
            hasCustomerContact: true,
            orderId: null,
            paymentMethod: null,
            paymentStatus: null,
        });
    });

    it("does not treat invalid legacy phones as captured contact", () => {
        expect(projectAbandonedCheckoutAgentSummary(JSON.stringify({
            customerPhone: "+880",
            cart: {
                totalAmount: 500,
                items: [{ id: "variant_1" }],
            },
        }), "+880")).toMatchObject({
            kind: "cart",
            stage: "cart_started",
            hasCustomerContact: false,
        });
    });
});
