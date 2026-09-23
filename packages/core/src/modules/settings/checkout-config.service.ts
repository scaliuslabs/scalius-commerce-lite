// src/modules/settings/checkout-config.service.ts
// Assembles the public checkout configuration from DB + gateway registry.

import type { Database } from "@scalius/database/client";
import {
    getDecimalPlaces,
    normalizeSupportedCurrencyCode,
} from "@scalius/shared/currency";
import type {
    CustomerAuthMethod,
    CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import { isReady } from "@scalius/shared/readiness";
import {
    COD_LABEL,
    COD_PAYMENT_METHOD,
    getPaymentGateway,
    isPaymentMethodCurrencyEligible,
    publicAmountLimits,
} from "../payments/gateways/registry";
import type { GatewaySettings } from "../payments/gateways/port";
import { getPaymentGatewaySettingsSnapshot } from "../payments/gateway-settings";
import { isCheckoutGatewayUsableForFlow } from "./checkout-flow";
import {
    CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE,
    getCheckoutReadiness,
    type CheckoutReadiness,
} from "./checkout-readiness";
import {
    checkoutDocument,
    currencyDocument,
    customerAuthDocument,
    customerCountriesDocument,
} from "./documents";
import { selectSettingsDocuments } from "./settings-store";

export interface CheckoutConfig {
    gateways: Array<Record<string, unknown>>;
    activeDefaultMethod?: string;
    guestCheckoutEnabled: boolean;
    authVerificationMethod: CustomerAuthMethod;
    customerAuthPolicy: CustomerAuthPolicyConfig;
    checkoutMode: string;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    allowedCountries: string[];
    allowedCountriesMode: "include" | "exclude";
    currency: {
        code: string;
        symbol: string;
        decimalPlaces: number;
    };
    checkoutReadiness: CheckoutReadiness;
    unavailable: boolean;
    unavailableMessage?: string;
}

/**
 * Assemble the full checkout configuration for the storefront.
 * Reads site settings, currency, allowed countries, and resolves enabled payment gateways.
 */
export async function getCheckoutConfig(
    db: Database,
    encryptionKey?: string,
    runtimeEnv?: Record<string, unknown>,
): Promise<CheckoutConfig> {
    const rows = await selectSettingsDocuments(db, [
        checkoutDocument,
        currencyDocument,
        customerAuthDocument,
        customerCountriesDocument,
    ]);
    const [checkout, currency, customerAuth, allowedCountriesConfig] = await Promise.all([
        checkoutDocument.fromRows(rows).then((result) => result.value),
        currencyDocument.fromRows(rows).then((result) => result.value),
        customerAuthDocument.fromRows(rows).then((result) => result.value),
        customerCountriesDocument.fromRows(rows).then((result) => result.value),
    ]);

    const localCurrencyCode = currency.currencyCode;
    const localCurrencySymbol = currency.currencySymbol;
    const currencyDecimalPlaces = getDecimalPlaces(localCurrencyCode);
    const { checkoutMode, partialPaymentEnabled, partialPaymentAmount } = checkout;
    const customerAuthPolicy = customerAuth.policy;
    const checkoutReadiness = await getCheckoutReadiness(db, { encryptionKey, runtimeEnv });

    if (!isReady(checkoutReadiness)) {
        return {
            gateways: [],
            guestCheckoutEnabled: checkout.guestCheckoutEnabled,
            authVerificationMethod: customerAuth.authVerificationMethod,
            customerAuthPolicy,
            checkoutMode,
            partialPaymentEnabled,
            partialPaymentAmount,
            allowedCountries: allowedCountriesConfig.allowedCountries,
            allowedCountriesMode: allowedCountriesConfig.allowedCountriesMode,
            currency: {
                code: localCurrencyCode,
                symbol: localCurrencySymbol,
                decimalPlaces: currencyDecimalPlaces,
            },
            checkoutReadiness,
            unavailable: true,
            unavailableMessage: CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE,
        };
    }

    const gatewaySnapshot = await getPaymentGatewaySettingsSnapshot(db, encryptionKey);
    const activePaymentMethods = gatewaySnapshot.activePaymentMethods;
    const savedGatewaySettings = gatewaySnapshot.settings as unknown as Record<string, GatewaySettings | null | undefined>;
    // The merchant's saved order is both the allowlist and the buyer-visible
    // presentation order. Each method must still be ready right now.
    const gateways: Array<Record<string, unknown>> = [];
    for (const methodId of activePaymentMethods.enabledMethods) {
        if (!isPaymentMethodCurrencyEligible(methodId, localCurrencyCode)) continue;
        if (!isCheckoutGatewayUsableForFlow({ gatewayId: methodId, checkoutMode, partialPaymentEnabled, partialPaymentAmount })) continue;
        if (methodId === COD_PAYMENT_METHOD) {
            gateways.push({ id: methodId, name: COD_LABEL, flow: "cod", currencies: [localCurrencyCode] });
            continue;
        }
        const gateway = getPaymentGateway(methodId);
        const settings = savedGatewaySettings[methodId] ?? null;
        if (!gateway || !settings || !gateway.readiness(settings).usable) continue;
        const amountLimits = publicAmountLimits(gateway);
        gateways.push({
            id: gateway.id,
            name: gateway.checkoutName,
            flow: gateway.flow,
            currencies: [localCurrencyCode],
            ...(amountLimits ? { amountLimits } : {}),
            ...gateway.publicConfig?.(settings),
        });
    }

    const unavailable = gateways.length === 0;
    const activeDefaultMethod = gateways.some((gateway) => gateway.id === activePaymentMethods.defaultMethod)
        ? activePaymentMethods.defaultMethod
        : undefined;

    return {
        gateways,
        activeDefaultMethod,
        guestCheckoutEnabled: checkout.guestCheckoutEnabled,
        authVerificationMethod: customerAuth.authVerificationMethod,
        customerAuthPolicy,
        checkoutMode,
        partialPaymentEnabled,
        partialPaymentAmount,
        allowedCountries: allowedCountriesConfig.allowedCountries,
        allowedCountriesMode: allowedCountriesConfig.allowedCountriesMode,
        currency: {
            code: localCurrencyCode,
            symbol: localCurrencySymbol,
            decimalPlaces: currencyDecimalPlaces,
        },
        checkoutReadiness,
        unavailable,
        unavailableMessage: unavailable
            ? "Checkout is temporarily unavailable while the merchant finishes payment setup."
            : undefined,
    };
}
