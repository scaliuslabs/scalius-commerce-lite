export interface CheckoutFlowPreviewOptions {
    checkoutMode: string;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    paymentMethodsUnavailable: boolean;
    paymentMethodsLoaded: boolean;
    codEnabled: boolean;
    activeOnlineMethodCount: number;
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

    if (!Number.isFinite(options.partialPaymentAmount) || options.partialPaymentAmount <= 0) {
        issues.push("Set an advance amount greater than 0.");
    }
    if (options.checkoutMode === "guest_cod_only") {
        issues.push("Fast COD Only cannot be used with advance payments.");
    }
    if (options.activeOnlineMethodCount === 0) {
        issues.push("Advance payments need at least one enabled and configured online gateway.");
    }

    return issues;
}
