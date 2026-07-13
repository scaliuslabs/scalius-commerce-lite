import { describe, expect, it } from "vitest";
import { getCheckoutFlowValidationIssues } from "@scalius/core/modules/settings/checkout-flow";

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
    sslCommerzEnabled: false,
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
            "Set an advance amount greater than zero.",
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
            sslCommerzEnabled: true,
        })).toContain(`SSLCommerz requires an advance amount between ${CHECKOUT_ADVANCE_PAYMENT_AMOUNT_RANGE_LABEL}.`);
    });

    it.each([5, 500001])("does not apply SSLCommerz's BDT range to other online gateways (%s)", (amount) => {
        expect(issues({
            checkoutMode: "all",
            partialPaymentEnabled: true,
            partialPaymentAmount: amount,
            codEnabled: false,
            activeOnlineMethodCount: 1,
            sslCommerzEnabled: false,
        })).toEqual([]);
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

    it.each([
        { mode: "all", partial: false, amount: 0, methods: ["cod"] },
        { mode: "gateways_only", partial: false, amount: 0, methods: ["stripe"] },
        { mode: "guest_cod_only", partial: false, amount: 0, methods: ["cod"] },
        { mode: "all", partial: true, amount: 5, methods: ["stripe"] },
        { mode: "all", partial: true, amount: 5, methods: ["sslcommerz"] },
        { mode: "guest_cod_only", partial: true, amount: 200, methods: ["cod"] },
    ])("matches server acceptance for $mode / $methods", ({ mode, partial, amount, methods }) => {
        const serverIssues = getCheckoutFlowValidationIssues({
            checkoutMode: mode,
            partialPaymentEnabled: partial,
            partialPaymentAmount: amount,
            availablePaymentMethods: methods,
        });
        const adminIssues = issues({
            checkoutMode: mode,
            partialPaymentEnabled: partial,
            partialPaymentAmount: amount,
            codEnabled: methods.includes("cod"),
            activeOnlineMethodCount: methods.filter((method) => method !== "cod").length,
            sslCommerzEnabled: methods.includes("sslcommerz"),
        });

        expect(adminIssues.length === 0).toBe(serverIssues.length === 0);
    });
});
