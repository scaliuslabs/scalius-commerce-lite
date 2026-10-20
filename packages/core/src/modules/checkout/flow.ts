import { getDecimalPlaces } from "@scalius/shared/currency";
import {
  BUILT_IN_PAYMENT_PROVIDERS,
  COD_PAYMENT_METHOD,
  getGatewayAmountIssue,
  NET_TERMS_PAYMENT_METHOD,
  isOnlinePaymentMethod,
  type PaymentProviders,
} from "../payments";
import type { CheckoutMode } from "../settings";

/** `cod`, a built-in gateway id or an app provider id (`<plugin id>:<provider id>`). */
export type CheckoutPaymentMethodId = string;

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

    // The invoice is for signed-in, trusted buyers: no advance deposit, and
    // not the guest cash-only flow.
    if (options.gatewayId === NET_TERMS_PAYMENT_METHOD) return checkoutMode !== "guest_cod_only";

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
    /** The request's gateways, for their amount limits; built-in ones alone by default. */
    paymentProviders?: PaymentProviders;
}): string[] {
    const issues: string[] = [];
    const checkoutMode = options.checkoutMode ?? "all";
    const availablePaymentMethods = options.availablePaymentMethods;
    const hasCod = availablePaymentMethods?.includes(COD_PAYMENT_METHOD) === true;
    const hasInvoice = availablePaymentMethods?.includes(NET_TERMS_PAYMENT_METHOD) === true;
    const hasOnlineGateway = availablePaymentMethods?.some(isOnlinePaymentMethod) === true;

    if (availablePaymentMethods) {
        if (checkoutMode === "all" && !hasCod && !hasOnlineGateway && !hasInvoice) {
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
        const gateway = (options.paymentProviders ?? BUILT_IN_PAYMENT_PROVIDERS).get(methodId);
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
