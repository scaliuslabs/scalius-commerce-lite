// src/modules/settings/checkout-config.service.ts
// Assembles the public checkout configuration from DB + gateway registry.

import type { Database } from "@scalius/database/client";
import { siteSettings, settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import {
    DEFAULT_CURRENCY,
    getDecimalPlaces,
    normalizeSupportedCurrencyCode,
} from "@scalius/shared/currency";
import {
    getLegacyCustomerAuthMethodForPolicy,
    normalizeCustomerAuthMethod,
    normalizeCustomerAuthPolicy,
    type CustomerAuthMethod,
    type CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import { getRegisteredGateways } from "../payments/gateway-registry";
import { isPaymentGatewayCurrencyEligible } from "../payments/gateway-currency-policy";
import {
    getPaymentGatewaySettingsSnapshot,
    type PaymentGatewaySettingsSnapshot,
} from "../payments/gateway-settings";
import { isCheckoutGatewayUsableForFlow } from "./checkout-flow";
import {
    CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE,
    getCheckoutReadiness,
    type CheckoutReadiness,
} from "./checkout-readiness";
import { getAllowedCountries } from "./site-settings.service";

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

function getGatewaySettings(
    snapshot: PaymentGatewaySettingsSnapshot,
    gatewayId: string,
): ({ enabled: boolean } & Record<string, unknown>) | null {
    if (gatewayId === "stripe") {
        return snapshot.settings.stripe ? { ...snapshot.settings.stripe } : null;
    }
    if (gatewayId === "sslcommerz") {
        return snapshot.settings.sslcommerz ? { ...snapshot.settings.sslcommerz } : null;
    }
    if (gatewayId === "polar") {
        return snapshot.settings.polar ? { ...snapshot.settings.polar } : null;
    }
    if (gatewayId === "cod") return { ...snapshot.settings.cod };
    return null;
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
    const [siteSettingsRow, currencyRows, allowedCountriesConfig, customerAuthPolicyRow] = await Promise.all([
        db.select({
            guestCheckoutEnabled: siteSettings.guestCheckoutEnabled,
            authVerificationMethod: siteSettings.authVerificationMethod,
            checkoutMode: siteSettings.checkoutMode,
            partialPaymentEnabled: siteSettings.partialPaymentEnabled,
            partialPaymentAmount: siteSettings.partialPaymentAmount
        }).from(siteSettings).limit(1).then((rows) => rows[0] ?? null),
        db.select({ key: settings.key, value: settings.value })
            .from(settings)
            .where(eq(settings.category, "currency"))
            .all(),
        getAllowedCountries(db),
        db.select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.category, "customer_auth"), eq(settings.key, "policy")))
            .get()
            .catch(() => null),
    ]);

    const currencyMap = Object.fromEntries(currencyRows.map((r) => [r.key, r.value]));
    const persistedCurrencyCode = normalizeSupportedCurrencyCode(currencyMap.currency_code);
    const localCurrencyCode = persistedCurrencyCode ?? DEFAULT_CURRENCY.code;
    const gatewayCurrencyCode = localCurrencyCode.toLowerCase();
    const localCurrencySymbol = persistedCurrencyCode
        ? currencyMap.currency_symbol ?? DEFAULT_CURRENCY.symbol
        : DEFAULT_CURRENCY.symbol;
    const currencyDecimalPlaces = getDecimalPlaces(localCurrencyCode);

    const checkoutMode = siteSettingsRow?.checkoutMode ?? "all";
    const customerAuthPolicy = normalizeCustomerAuthPolicy(
        parseCustomerAuthPolicy(customerAuthPolicyRow?.value),
        siteSettingsRow?.authVerificationMethod,
    );

    const partialPaymentEnabled = siteSettingsRow?.partialPaymentEnabled ?? false;
    const partialPaymentAmount = siteSettingsRow?.partialPaymentAmount ?? 0;
    const checkoutReadiness = await getCheckoutReadiness(db, { encryptionKey, runtimeEnv });

    if (!checkoutReadiness.ready) {
        return {
            gateways: [],
            guestCheckoutEnabled: siteSettingsRow?.guestCheckoutEnabled ?? true,
            authVerificationMethod: customerAuthPolicyRow?.value
                ? getLegacyCustomerAuthMethodForPolicy(customerAuthPolicy)
                : normalizeCustomerAuthMethod(siteSettingsRow?.authVerificationMethod),
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
    // Resolve the merchant's saved order through the registry. The configured
    // array is both the allowlist and the buyer-visible presentation order.
    const registeredGateways = getRegisteredGateways();
    const registeredGatewaysById = new Map(
        registeredGateways.map((gateway) => [gateway.id, gateway]),
    );
    const candidateGateways = activePaymentMethods.enabledMethods
        .map((gatewayId) => registeredGatewaysById.get(gatewayId))
        .filter((gateway): gateway is NonNullable<typeof gateway> => Boolean(gateway))
        .filter((gateway) => isPaymentGatewayCurrencyEligible(gateway.id, localCurrencyCode))
        .filter((gateway) => isCheckoutGatewayUsableForFlow({
            gatewayId: gateway.id,
            checkoutMode,
            partialPaymentEnabled,
            partialPaymentAmount,
        }));
    const gateways: Array<Record<string, unknown>> = [];

    for (let i = 0; i < candidateGateways.length; i++) {
        const gw = candidateGateways[i];
        if (!gw) continue;
        const gwSettings = getGatewaySettings(gatewaySnapshot, gw.id);
        if (!isPublicGatewaySettingsUsable(gw.id, gwSettings)) continue;
        const advertisedCurrencies = gw.getCurrencies?.(gatewayCurrencyCode) ?? [gatewayCurrencyCode];
        const currencies = Array.from(new Set(
            advertisedCurrencies
                .map(normalizeSupportedCurrencyCode)
                .filter((code): code is NonNullable<typeof code> => Boolean(code)),
        ));
        if (!currencies.some((currencyCode) => currencyCode === localCurrencyCode)) continue;

        gateways.push({
            id: gw.id,
            name: gw.name,
            currencies,
            ...(gw.getPublicConfig?.(gwSettings as Record<string, unknown>) || {}),
        });
    }

    const unavailable = gateways.length === 0;
    const activeDefaultMethod = gateways.some((gateway) => gateway.id === activePaymentMethods.defaultMethod)
        ? activePaymentMethods.defaultMethod
        : undefined;

    return {
        gateways,
        activeDefaultMethod,
        guestCheckoutEnabled: siteSettingsRow?.guestCheckoutEnabled ?? true,
        authVerificationMethod: customerAuthPolicyRow?.value
            ? getLegacyCustomerAuthMethodForPolicy(customerAuthPolicy)
            : normalizeCustomerAuthMethod(siteSettingsRow?.authVerificationMethod),
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

function isPublicGatewaySettingsUsable(
    gatewayId: string,
    settings: { enabled: boolean; [key: string]: unknown } | null | undefined,
): settings is { enabled: true; [key: string]: unknown } {
    if (!settings?.enabled) return false;
    if (gatewayId === "stripe") {
        return typeof settings.publishableKey === "string" && settings.publishableKey.trim().length > 0;
    }
    return true;
}

function parseCustomerAuthPolicy(value: string | null | undefined): unknown {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}
