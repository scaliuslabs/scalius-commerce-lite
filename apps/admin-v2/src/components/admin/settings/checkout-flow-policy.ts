import { SSL_COMMERZ_BDT_AMOUNT_LIMITS } from "@scalius/shared/payment-gateway-environment";

export const CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS = SSL_COMMERZ_BDT_AMOUNT_LIMITS;

/** Issue keys; the payments catalog words them. */
export type CheckoutFlowIssue =
    | "readinessUnknown"
    | "noMethod"
    | "codOff"
    | "noOnline"
    | "amountInvalid"
    | "sslRange"
    | "codWithAdvance"
    | "advanceNeedsOnline";

export interface CheckoutFlowPreviewOptions {
    checkoutMode: string;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    paymentMethodsUnavailable: boolean;
    paymentMethodsLoaded: boolean;
    codEnabled: boolean;
    activeOnlineMethodCount: number;
    sslCommerzEnabled: boolean;
}

export function getCheckoutAdvancePaymentAmountIssue(
    amount: unknown,
    options: { sslCommerzEnabled: boolean },
): CheckoutFlowIssue | null {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return "amountInvalid";
    if (options.sslCommerzEnabled && (
        numericAmount < CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.min ||
        numericAmount > CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.max
    )) {
        return "sslRange";
    }
    return null;
}

/**
 * Mirrors the server's checkout-flow validation so the dashboard fails
 * closed: an unreadable payment-method state blocks saving outright.
 */
export function getCheckoutFlowPreviewIssues(options: CheckoutFlowPreviewOptions): CheckoutFlowIssue[] {
    if (options.paymentMethodsUnavailable || !options.paymentMethodsLoaded) return ["readinessUnknown"];

    const issues: CheckoutFlowIssue[] = [];
    if (options.checkoutMode === "all" && !options.codEnabled && options.activeOnlineMethodCount === 0) {
        issues.push("noMethod");
    }
    if (options.checkoutMode === "guest_cod_only" && !options.codEnabled) issues.push("codOff");
    if (options.checkoutMode === "gateways_only" && options.activeOnlineMethodCount === 0) issues.push("noOnline");

    if (!options.partialPaymentEnabled) return issues;

    const amountIssue = getCheckoutAdvancePaymentAmountIssue(options.partialPaymentAmount, {
        sslCommerzEnabled: options.sslCommerzEnabled,
    });
    if (amountIssue) issues.push(amountIssue);
    if (options.checkoutMode === "guest_cod_only") issues.push("codWithAdvance");
    if (options.activeOnlineMethodCount === 0) issues.push("advanceNeedsOnline");
    return issues;
}
