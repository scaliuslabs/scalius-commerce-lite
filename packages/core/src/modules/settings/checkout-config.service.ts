// src/modules/settings/checkout-config.service.ts
// Assembles the public checkout configuration from DB + gateway registry.

import type { Database } from "@scalius/database/client";
import { siteSettings, settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
    getLegacyCustomerAuthMethodForPolicy,
    normalizeCustomerAuthMethod,
    normalizeCustomerAuthPolicy,
    type CustomerAuthMethod,
    type CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import { getRegisteredGateways } from "../payments/gateway-registry";
import { getActivePaymentMethods } from "../payments/gateway-settings";
import { isCheckoutGatewayUsableForFlow } from "./checkout-flow";
import {
    CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE,
    getCheckoutReadiness,
    type CheckoutReadiness,
} from "./checkout-readiness";

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
    kv?: KVNamespace,
    encryptionKey?: string,
): Promise<CheckoutConfig> {
    const [siteSettingsRow, currencyRows, allowedCountriesRow, customerAuthPolicyRow] = await Promise.all([
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
        db.select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.category, "phone"), eq(settings.key, "allowed_countries")))
            .get(),
        db.select({ value: settings.value })
            .from(settings)
            .where(and(eq(settings.category, "customer_auth"), eq(settings.key, "policy")))
            .get()
            .catch(() => null),
    ]);

    let allowedCountries: string[] = [];
    let allowedCountriesMode: "include" | "exclude" = "include";
    try {
        if (allowedCountriesRow?.value) {
            const parsed = JSON.parse(allowedCountriesRow.value);
            if (Array.isArray(parsed)) {
                // Backward compat: old format was just an array
                allowedCountries = parsed;
            } else if (parsed && typeof parsed === "object") {
                allowedCountries = Array.isArray(parsed.countries) ? parsed.countries : [];
                allowedCountriesMode = parsed.mode === "exclude" ? "exclude" : "include";
            }
        }
    } catch {
        // Invalid JSON — default to empty array
    }

    const currencyMap = Object.fromEntries(currencyRows.map((r) => [r.key, r.value]));
    const localCurrencyCode = (currencyMap.currency_code ?? "bdt").toLowerCase();
    const currencyDecimalPlaces = getDecimalPlaces(localCurrencyCode);

    const checkoutMode = siteSettingsRow?.checkoutMode ?? "all";
    const customerAuthPolicy = normalizeCustomerAuthPolicy(
        parseCustomerAuthPolicy(customerAuthPolicyRow?.value),
        siteSettingsRow?.authVerificationMethod,
    );

    const partialPaymentEnabled = siteSettingsRow?.partialPaymentEnabled ?? false;
    const partialPaymentAmount = siteSettingsRow?.partialPaymentAmount ?? 0;
    const checkoutReadiness = await getCheckoutReadiness(db);

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
            allowedCountries,
            allowedCountriesMode,
            currency: {
                code: localCurrencyCode,
                symbol: currencyMap.currency_symbol ?? "\u09F3",
                decimalPlaces: currencyDecimalPlaces,
            },
            checkoutReadiness,
            unavailable: true,
            unavailableMessage: CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE,
        };
    }

    const activePaymentMethods = await getActivePaymentMethods(db, kv, encryptionKey, {
        bypassMemoryCache: true,
    });
    const allowedGatewayIds = new Set(activePaymentMethods.enabledMethods);

    // Dynamically resolve enabled gateways from the registry
    const registeredGateways = getRegisteredGateways();
    const candidateGateways = registeredGateways.filter((gw) => {
        if (!allowedGatewayIds.has(gw.id as "stripe" | "sslcommerz" | "polar" | "cod")) return false;
        return isCheckoutGatewayUsableForFlow({
            gatewayId: gw.id,
            checkoutMode,
            partialPaymentEnabled,
            partialPaymentAmount,
        });
    });
    const settingsResults = await Promise.all(
        candidateGateways.map((gw) =>
            gw.getSettings(db, kv, encryptionKey, { bypassMemoryCache: true })
        ),
    );

    const gateways: Array<Record<string, unknown>> = [];

    for (let i = 0; i < candidateGateways.length; i++) {
        const gw = candidateGateways[i];
        if (!gw) continue;
        const gwSettings = settingsResults[i];
        if (!isPublicGatewaySettingsUsable(gw.id, gwSettings)) continue;

        gateways.push({
            id: gw.id,
            name: gw.name,
            currencies: gw.getCurrencies?.(localCurrencyCode) || [localCurrencyCode],
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
        allowedCountries,
        allowedCountriesMode,
        currency: {
            code: localCurrencyCode,
            symbol: currencyMap.currency_symbol ?? "\u09F3",
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
