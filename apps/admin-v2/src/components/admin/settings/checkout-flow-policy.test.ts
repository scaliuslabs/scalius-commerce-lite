import { describe, expect, it } from "vitest";

import {
    CHECKOUT_ADVANCE_PAYMENT_AMOUNT_RANGE_LABEL,
    getCheckoutFlowPreviewIssues,
    type CheckoutFlowPreviewOptions,
} from "./checkout-flow-policy";

const baseOptions: CheckoutFlowPreviewOptions = {
    checkoutMode: "all",
    partialPaymentEnabled: false,
    partialPaymentAmount: 0,
    paymentMethodsUnavailable: false,
    paymentMethodsLoaded: true,
    codEnabled: true,
    activeOnlineMethodCount: 0,
};

function issues(overrides: Partial<CheckoutFlowPreviewOptions>): string[] {
    return getCheckoutFlowPreviewIssues({
        ...baseOptions,
        ...overrides,
    });
}

describe("checkout flow preview policy", () => {
    it("blocks Standard checkout when no usable customer payment method is loaded", () => {
        expect(issues({
            checkoutMode: "all",
            codEnabled: false,
            activeOnlineMethodCount: 0,
        })).toContain("Enable at least one configured payment method in Payment Gateways.");
    });

    it.each([
        { label: "COD only", codEnabled: true, activeOnlineMethodCount: 0 },
        { label: "online only", codEnabled: false, activeOnlineMethodCount: 1 },
        { label: "COD and online", codEnabled: true, activeOnlineMethodCount: 1 },
    ])("allows Standard checkout with $label", ({ codEnabled, activeOnlineMethodCount }) => {
        expect(issues({
            checkoutMode: "all",
            codEnabled,
            activeOnlineMethodCount,
        })).toEqual([]);
    });

    it("keeps mode-specific blockers for COD-only and online-only flows", () => {
        expect(issues({
            checkoutMode: "guest_cod_only",
            codEnabled: false,
            activeOnlineMethodCount: 1,
        })).toContain("Enable Cash on Delivery in Payment Gateways before using Fast COD Only.");
        expect(issues({
            checkoutMode: "gateways_only",
            codEnabled: true,
            activeOnlineMethodCount: 0,
        })).toContain("Enable and configure at least one online gateway in Payment Gateways.");
    });

    it("requires an online gateway and provider-valid amount for advance payments", () => {
        expect(issues({
            checkoutMode: "all",
            partialPaymentEnabled: true,
            partialPaymentAmount: 0,
            codEnabled: true,
            activeOnlineMethodCount: 0,
        })).toEqual(expect.arrayContaining([
            `Set an advance amount between ${CHECKOUT_ADVANCE_PAYMENT_AMOUNT_RANGE_LABEL}.`,
            "Advance payments need at least one enabled and configured online gateway.",
        ]));
    });

    it.each([
        { label: "below the SSLCommerz minimum", amount: 5 },
        { label: "above the SSLCommerz maximum", amount: 500001 },
    ])("warns in the preview before save when the advance amount is $label", ({ amount }) => {
        expect(issues({
            checkoutMode: "all",
            partialPaymentEnabled: true,
            partialPaymentAmount: amount,
            codEnabled: true,
            activeOnlineMethodCount: 1,
        })).toContain(`Set an advance amount between ${CHECKOUT_ADVANCE_PAYMENT_AMOUNT_RANGE_LABEL}.`);
    });

    it("allows the preview when the advance amount is inside the provider range", () => {
        expect(issues({
            checkoutMode: "all",
            partialPaymentEnabled: true,
            partialPaymentAmount: 10,
            codEnabled: true,
            activeOnlineMethodCount: 1,
        })).toEqual([]);
    });

    it("locks saves behind a successfully loaded payment-method payload", () => {
        expect(issues({
            paymentMethodsLoaded: false,
            paymentMethodsUnavailable: true,
            codEnabled: false,
            activeOnlineMethodCount: 0,
        })).toEqual([
            "Payment method readiness could not be checked. Reload payment settings before saving checkout flow changes.",
        ]);
    });
});
