import { SSL_COMMERZ_BDT_AMOUNT_LIMITS } from "@scalius/core/modules/payments/sslcommerz";

export const CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS = SSL_COMMERZ_BDT_AMOUNT_LIMITS;
export const CHECKOUT_ADVANCE_PAYMENT_AMOUNT_RANGE_LABEL =
    `BDT ${CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.min.toLocaleString("en-US")} and BDT ${CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.max.toLocaleString("en-US")}`;

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
): string | null {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return "Set an advance amount greater than zero.";
    }
    if (options.sslCommerzEnabled && (
        numericAmount < CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.min ||
        numericAmount > CHECKOUT_ADVANCE_PAYMENT_AMOUNT_LIMITS.max
    )) {
        return `SSLCommerz requires an advance amount between ${CHECKOUT_ADVANCE_PAYMENT_AMOUNT_RANGE_LABEL}.`;
    }
    return null;
}

export function getCheckoutFlowPreviewIssues(options: CheckoutFlowPreviewOptions): string[] {
    const issues: string[] = [];

    if (options.paymentMethodsUnavailable || !options.paymentMethodsLoaded) {
        issues.push("Payment method readiness could not be checked. Reload payment settings before saving checkout flow changes.");
        return issues;
    }

    if (
        options.checkoutMode === "all" &&
        !options.codEnabled &&
        options.activeOnlineMethodCount === 0
    ) {
        issues.push("Enable at least one configured payment method in Payment Gateways.");
    }
    if (options.checkoutMode === "guest_cod_only" && !options.codEnabled) {
        issues.push("Enable Cash on Delivery in Payment Gateways before using Fast COD Only.");
    }
    if (options.checkoutMode === "gateways_only" && options.activeOnlineMethodCount === 0) {
        issues.push("Enable and configure at least one online gateway in Payment Gateways.");
    }

    if (!options.partialPaymentEnabled) return issues;

    const amountIssue = getCheckoutAdvancePaymentAmountIssue(
        options.partialPaymentAmount,
        { sslCommerzEnabled: options.sslCommerzEnabled },
    );
    if (amountIssue) issues.push(amountIssue);
    if (options.checkoutMode === "guest_cod_only") {
        issues.push("Fast COD Only cannot be used with advance payments.");
    }
    if (options.activeOnlineMethodCount === 0) {
        issues.push("Advance payments need at least one enabled and configured online gateway.");
    }

    return issues;
}
