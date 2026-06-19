// src/modules/settings/checkout-config.service.ts
// Assembles the public checkout configuration from DB + gateway registry.

import type { Database } from "@scalius/database/client";
import { siteSettings, settings } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getRegisteredGateways } from "../payments/gateway-registry";
import { getActivePaymentMethods } from "../payments/gateway-settings";

export interface CheckoutConfig {
    gateways: Array<Record<string, unknown>>;
    guestCheckoutEnabled: boolean;
    authVerificationMethod: string;
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
    const [siteSettingsRow, currencyRows, allowedCountriesRow] = await Promise.all([
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

    const activePaymentMethods = await getActivePaymentMethods(db, kv, encryptionKey, {
        bypassMemoryCache: true,
    });
    const allowedGatewayIds = new Set(activePaymentMethods.enabledMethods);

    // Dynamically resolve enabled gateways from the registry
    const registeredGateways = getRegisteredGateways();
    const candidateGateways = registeredGateways.filter((gw) => {
        if (!allowedGatewayIds.has(gw.id as "stripe" | "sslcommerz" | "polar" | "cod")) return false;
        if (gw.id === "cod" && checkoutMode === "gateways_only") return false;
        if (gw.id !== "cod" && checkoutMode === "guest_cod_only") return false;
        return true;
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
        if (!gwSettings?.enabled) continue;

        gateways.push({
            id: gw.id,
            name: gw.name,
            currencies: gw.getCurrencies?.(localCurrencyCode) || [localCurrencyCode],
            ...(gw.getPublicConfig?.(gwSettings as Record<string, unknown>) || {}),
        });
    }

    return {
        gateways,
        guestCheckoutEnabled: siteSettingsRow?.guestCheckoutEnabled ?? true,
        authVerificationMethod: siteSettingsRow?.authVerificationMethod ?? "email",
        checkoutMode,
        partialPaymentEnabled: siteSettingsRow?.partialPaymentEnabled ?? false,
        partialPaymentAmount: siteSettingsRow?.partialPaymentAmount ?? 0,
        allowedCountries,
        allowedCountriesMode,
        currency: {
            code: localCurrencyCode,
            symbol: currencyMap.currency_symbol ?? "\u09F3",
            decimalPlaces: currencyDecimalPlaces,
        },
    };
}
