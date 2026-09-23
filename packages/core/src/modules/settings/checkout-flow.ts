import { getDecimalPlaces } from "@scalius/shared/currency";
import {
    COD_PAYMENT_METHOD,
    getGatewayAmountIssue,
    getPaymentGateway,
    isOnlinePaymentMethod,
} from "../payments/gateways/registry";

export type CheckoutMode = "guest_cod_only" | "gateways_only" | "all";
/** A registered gateway id or "cod". */
export type CheckoutPaymentMethodId = string;

export { isOnlinePaymentMethod };

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

    if (options.gatewayId === COD_PAYMENT_METHOD && checkoutMode === "gateways_only") return false;
    if (options.gatewayId !== COD_PAYMENT_METHOD && checkoutMode === "guest_cod_only") return false;

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
    const hasCod = availablePaymentMethods?.includes(COD_PAYMENT_METHOD) === true;
    const hasOnlineGateway = availablePaymentMethods?.some(isOnlinePaymentMethod) === true;

    if (availablePaymentMethods) {
        if (checkoutMode === "all" && !hasCod && !hasOnlineGateway) {
            issues.push("Standard checkout needs at least one enabled and configured payment method.");
        }
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
    for (const methodId of availablePaymentMethods ?? []) {
        const gateway = getPaymentGateway(methodId);
        const limits = gateway?.amountLimits;
        if (!gateway || !limits) continue;
        const amountMinor = Math.round(Number(options.partialPaymentAmount) * 10 ** getDecimalPlaces(limits.currency));
        const amountIssue = getGatewayAmountIssue(gateway, amountMinor, limits.currency, `${gateway.label} advance payment amount`);
        if (amountIssue) issues.push(amountIssue);
    }
    if (checkoutMode === "guest_cod_only") {
        issues.push("Partial payment needs an online payment gateway, so Fast COD Only cannot be used.");
    }
    if (availablePaymentMethods && !hasOnlineGateway) {
        issues.push("Partial payment needs at least one enabled and configured online payment gateway.");
    }

    return issues;
}
