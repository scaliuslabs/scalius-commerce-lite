import { describe, expect, it } from "vitest";

import {
    getCheckoutFlowPreviewIssues,
    violatedAdvanceLimit,
    type CheckoutFlowIssue,
    type CheckoutFlowPreviewOptions,
} from "./checkout-flow-policy";

// The preview must agree with the server rule. The dashboard compiles only
// against browser entries, so the server checkout entry (which carries Worker
// ambient types) is loaded at test time, not imported for the compiler.
const SERVER_CHECKOUT_ENTRY = "@scalius/core/modules/checkout";
const { getCheckoutFlowValidationIssues } = (await import(/* @vite-ignore */ SERVER_CHECKOUT_ENTRY)) as {
    getCheckoutFlowValidationIssues: (options: {
        checkoutMode: string | null | undefined;
        partialPaymentEnabled: boolean;
        partialPaymentAmount: unknown;
        availablePaymentMethods?: readonly string[];
    }) => string[];
};

const baseOptions: CheckoutFlowPreviewOptions = {
    checkoutMode: "all",
    partialPaymentEnabled: false,
    partialPaymentAmount: 0,
    paymentMethodsUnavailable: false,
    paymentMethodsLoaded: true,
    codEnabled: true,
    activeOnlineMethodCount: 0,
};

/** The Bangladesh pack's SSLCommerz, as the payment-methods read lists its limits. */
const SSLCOMMERZ_LIMIT = { method: "scalius.bangladesh:sslcommerz", currency: "BDT", min: 10, max: 500_000 };

function issues(overrides: Partial<CheckoutFlowPreviewOptions>): CheckoutFlowIssue[] {
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
        })).toContain("noMethod");
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
        })).toContain("codOff");
        expect(issues({
            checkoutMode: "gateways_only",
            codEnabled: true,
            activeOnlineMethodCount: 0,
        })).toContain("noOnline");
    });

    it("requires an online gateway and provider-valid amount for advance payments", () => {
        expect(issues({
            checkoutMode: "all",
            partialPaymentEnabled: true,
            partialPaymentAmount: 0,
            codEnabled: true,
            activeOnlineMethodCount: 0,
        })).toEqual(expect.arrayContaining([
            "amountInvalid",
            "advanceNeedsOnline",
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
            advanceLimits: [SSLCOMMERZ_LIMIT],
        })).toContain("advanceRange");
        expect(violatedAdvanceLimit(amount, [SSLCOMMERZ_LIMIT])).toEqual(SSLCOMMERZ_LIMIT);
    });

    it("asks for whole taka in a BDT store and keeps decimals for other currencies", () => {
        const advance = { checkoutMode: "all", partialPaymentEnabled: true, partialPaymentAmount: 99.5, codEnabled: true, activeOnlineMethodCount: 1 };
        expect(issues({ ...advance, wholeTaka: true })).toContain("wholeTaka");
        expect(issues({ ...advance, wholeTaka: true, partialPaymentAmount: 100 })).not.toContain("wholeTaka");
        expect(issues({ ...advance, wholeTaka: false })).not.toContain("wholeTaka");
    });

    it.each([5, 500001])("applies no range when the offered online gateways have no limits (%s)", (amount) => {
        expect(issues({
            checkoutMode: "all",
            partialPaymentEnabled: true,
            partialPaymentAmount: amount,
            codEnabled: false,
            activeOnlineMethodCount: 1,
            advanceLimits: [],
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
        })).toEqual(["readinessUnknown"]);
    });

    it.each([
        { mode: "all", partial: false, amount: 0, methods: ["cod"] },
        { mode: "gateways_only", partial: false, amount: 0, methods: ["stripe"] },
        { mode: "guest_cod_only", partial: false, amount: 0, methods: ["cod"] },
        { mode: "all", partial: true, amount: 5, methods: ["stripe"] },
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
        });

        expect(adminIssues.length === 0).toBe(serverIssues.length === 0);
    });

    it("matches server acceptance across every flow, advance, and supported method family", () => {
        const modes = ["all", "guest_cod_only", "gateways_only"] as const;
        const methodSets = [
            [],
            ["cod"],
            ["stripe"],
            ["cod", "stripe"],
        ];
        const advances = [
            { enabled: false, amount: 0 },
            { enabled: true, amount: 200 },
        ];

        for (const mode of modes) {
            for (const methods of methodSets) {
                for (const advance of advances) {
                    const serverIssues = getCheckoutFlowValidationIssues({
                        checkoutMode: mode,
                        partialPaymentEnabled: advance.enabled,
                        partialPaymentAmount: advance.amount,
                        availablePaymentMethods: methods,
                    });
                    const adminIssues = issues({
                        checkoutMode: mode,
                        partialPaymentEnabled: advance.enabled,
                        partialPaymentAmount: advance.amount,
                        codEnabled: methods.includes("cod"),
                        activeOnlineMethodCount: methods.filter((method) => method !== "cod").length,
                    });

                    expect({
                        accepted: adminIssues.length === 0,
                        mode,
                        methods,
                        advance,
                    }).toEqual({
                        accepted: serverIssues.length === 0,
                        mode,
                        methods,
                        advance,
                    });
                }
            }
        }
    });
});
