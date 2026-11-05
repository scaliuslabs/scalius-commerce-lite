import { getDecimalPlaces } from "@scalius/shared/currency";
import {
  BUILT_IN_PAYMENT_PROVIDERS,
  COD_PAYMENT_METHOD,
  gatewayAmountLimits,
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
    codDepositEnabled: boolean;
}): boolean {
    const checkoutMode = options.checkoutMode ?? "all";

    // The invoice is for signed-in, trusted buyers: no advance deposit, and
    // not the guest cash-only flow.
    if (options.gatewayId === NET_TERMS_PAYMENT_METHOD) return checkoutMode !== "guest_cod_only";

    if (options.gatewayId === COD_PAYMENT_METHOD && checkoutMode === "gateways_only") return false;
    if (options.gatewayId !== COD_PAYMENT_METHOD && checkoutMode === "guest_cod_only") return false;

    if (options.partialPaymentEnabled && !options.codDepositEnabled) {
        // Online advance: COD excluded; only online gateways may take the deposit.
        if (!isPositiveDepositAmount(options.partialPaymentAmount)) return false;
        return isOnlinePaymentMethod(options.gatewayId);
    }

    return true;
}

export function getCheckoutFlowValidationIssues(options: {
    checkoutMode: string | null | undefined;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: unknown;
    codDepositEnabled?: boolean;
    codDepositMode?: "fixed" | "percentage";
    codDepositAmount?: number;
    codDepositPercent?: number;
    availablePaymentMethods?: readonly string[];
    /** The request's gateways, for their amount limits; built-in ones alone by default. */
    paymentProviders?: PaymentProviders;
    /** The store currency the advance is charged in (a per-currency provider's limits apply there). */
    currencyCode?: string;
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

    // Manual COD deposit validation.
    if (options.codDepositEnabled) {
        if (!hasCod) {
            issues.push("Cash on delivery deposit requires Cash on Delivery to be enabled.");
        }
        if (checkoutMode === "gateways_only") {
            issues.push("Cash on delivery deposit is not available in Online Gateways Only mode.");
        }
        const amount = options.codDepositAmount ?? 0;
        const percent = options.codDepositPercent ?? 0;
        if (options.codDepositMode === "fixed") {
            if (!Number.isFinite(amount) || amount <= 0) {
                issues.push("Cash on delivery deposit amount must be greater than zero.");
            }
        } else {
            if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
                issues.push("Cash on delivery deposit percentage must be a whole number between 1 and 99.");
            }
        }
    }


    if (!options.partialPaymentEnabled) return issues;

    if (!isPositiveDepositAmount(options.partialPaymentAmount)) {
        issues.push("Advance payment amount must be greater than zero.");
    }
    for (const methodId of availablePaymentMethods ?? []) {
        const gateway = (options.paymentProviders ?? BUILT_IN_PAYMENT_PROVIDERS).get(methodId);
        const limits = gateway && (options.currencyCode ? gatewayAmountLimits(gateway, options.currencyCode) : gateway.amountLimits);
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
