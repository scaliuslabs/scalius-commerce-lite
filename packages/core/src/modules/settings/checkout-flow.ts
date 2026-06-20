export type CheckoutMode = "guest_cod_only" | "gateways_only" | "all";
export type CheckoutPaymentMethodId = "stripe" | "sslcommerz" | "polar" | "cod";

const ONLINE_PAYMENT_METHODS = new Set<CheckoutPaymentMethodId>([
    "stripe",
    "sslcommerz",
    "polar",
]);

export function isOnlinePaymentMethod(method: string): method is Exclude<CheckoutPaymentMethodId, "cod"> {
    return ONLINE_PAYMENT_METHODS.has(method as CheckoutPaymentMethodId);
}

export function isPositiveDepositAmount(value: unknown): boolean {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0;
}

export function isCheckoutGatewayUsableForFlow(options: {
    gatewayId: string;
    checkoutMode: string | null | undefined;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: unknown;
}): boolean {
    const checkoutMode = options.checkoutMode ?? "all";

    if (options.gatewayId === "cod" && checkoutMode === "gateways_only") return false;
    if (options.gatewayId !== "cod" && checkoutMode === "guest_cod_only") return false;

    if (options.partialPaymentEnabled) {
        if (!isPositiveDepositAmount(options.partialPaymentAmount)) return false;
        return isOnlinePaymentMethod(options.gatewayId);
    }

    return true;
}

export function getCheckoutFlowValidationIssues(options: {
    checkoutMode: string | null | undefined;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: unknown;
    availablePaymentMethods?: readonly string[];
}): string[] {
    const issues: string[] = [];
    const checkoutMode = options.checkoutMode ?? "all";
    const availablePaymentMethods = options.availablePaymentMethods;
    const hasCod = availablePaymentMethods?.includes("cod") === true;
    const hasOnlineGateway = availablePaymentMethods?.some(isOnlinePaymentMethod) === true;

    if (availablePaymentMethods) {
        if (checkoutMode === "guest_cod_only" && !hasCod) {
            issues.push("Fast COD Only needs Cash on Delivery to be enabled.");
        }
        if (checkoutMode === "gateways_only" && !hasOnlineGateway) {
            issues.push("Online Gateways Only needs at least one enabled and configured online gateway.");
        }
    }

    if (!options.partialPaymentEnabled) return issues;

    if (!isPositiveDepositAmount(options.partialPaymentAmount)) {
        issues.push("Advance payment amount must be greater than zero.");
    }
    if (checkoutMode === "guest_cod_only") {
        issues.push("Partial payment needs an online payment gateway, so Fast COD Only cannot be used.");
    }
    if (availablePaymentMethods && !hasOnlineGateway) {
        issues.push("Partial payment needs at least one enabled and configured online payment gateway.");
    }

    return issues;
}
