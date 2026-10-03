// src/modules/checkout/config.ts
// Assembles the public checkout configuration from DB + gateway registry.

import type { Database } from "@scalius/database/client";
import {
    getDecimalPlaces,
    normalizeSupportedCurrencyCode,
} from "@scalius/shared/currency";
import type { CustomerIdentitySettings } from "@scalius/shared/customer-auth-policy";
import { isReady } from "@scalius/shared/readiness";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import type { AppProviders } from "../../integrations/provider-port";
import {
  BUILT_IN_PAYMENT_PROVIDERS,
  COD_LABEL,
  COD_PAYMENT_METHOD,
  type GatewaySettings,
  getPaymentGatewaySettingsSnapshot,
  type PaymentProvidersSource,
  publicAmountLimits,
} from "../payments";
import { isCheckoutGatewayUsableForFlow } from "./flow";
import {
    CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE,
    type CheckoutReadiness,
} from "@scalius/shared/checkout-readiness";
import { getCheckoutReadiness } from "./readiness";
import { getOfferedCustomerIdentity } from "../customers";
import {
  checkoutDocument,
  currencyDocument,
  customerAuthDocument,
  customerCountriesDocument,
  marketingConsentDocument,
} from "../settings";
import { selectSettingsDocuments } from "../../settings-store";
import { readPresenceMarketWithDocuments, type PresenceMarket } from "../markets";
import { NotFoundError } from "../../errors";

export interface CheckoutConfig {
    gateways: Array<Record<string, unknown>>;
    activeDefaultMethod?: string;
    guestCheckoutEnabled: boolean;
    /** Customer accounts settings; `channels` lists only chosen channels that can send now. */
    customerIdentity: CustomerIdentitySettings;
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
    /**
     * The marketing consent checkbox (Customers & marketing): shown unchecked,
     * never required, with the merchant's label per language. `channels`
     * says which channels a tick subscribes (those the order has a contact for).
     */
    marketingConsent: {
        enabled: boolean;
        channels: Array<"email" | "sms" | "whatsapp">;
        label: { en: string; bn: string };
    };
    /** The market of the requested presence (MARKETS-DESIGN D4); absent when none was asked for. */
    market?: PresenceMarket;
}

/**
 * Assemble the full checkout configuration for the storefront.
 * Reads site settings, currency, allowed countries, and resolves enabled payment gateways.
 */
export async function getCheckoutConfig(
    db: Database,
    encryptionKey?: string,
    runtimeEnv?: Record<string, unknown>,
    /**
     * The request's gateways (built-in and active app providers), asked for
     * only when the merchant enabled an app's method; built-in ones alone by default.
     */
    paymentProviders?: PaymentProvidersSource,
    /** The app providers a saved SMS or email choice may name (customer sign-in channels). */
    appProviders?: AppProviders,
    /**
     * The page's presence (`''` is the root). Its market is read in the same
     * statement as the settings documents (the market row joined with them).
     */
    presence?: string,
): Promise<CheckoutConfig> {
    const documents = [
        checkoutDocument,
        currencyDocument,
        customerAuthDocument,
        customerCountriesDocument,
        marketingConsentDocument,
    ];
    let rows: Awaited<ReturnType<typeof selectSettingsDocuments>>;
    let market: PresenceMarket | undefined;
    if (presence === undefined) {
        rows = await selectSettingsDocuments(db, documents);
    } else {
        const read = await readPresenceMarketWithDocuments(db, presence, documents);
        // No active market holds the presence: a 404, and nothing else is read.
        if (!read.market) throw new NotFoundError("Market not found");
        rows = read.documentRows;
        market = read.market;
    }
    const [checkout, currency, customerAuth, allowedCountriesConfig, marketing] = await Promise.all([
        checkoutDocument.fromRows(rows).then((result) => result.value),
        currencyDocument.fromRows(rows).then((result) => result.value),
        customerAuthDocument.fromRows(rows).then((result) => result.value),
        customerCountriesDocument.fromRows(rows).then((result) => result.value),
        marketingConsentDocument.fromRows(rows).then((result) => result.value),
    ]);
    const marketingConsent = {
        enabled: marketing.checkout.enabled,
        channels: [...marketing.checkout.channels],
        label: { ...marketing.checkout.label },
    };

    const localCurrencyCode = currency.currencyCode;
    const localCurrencySymbol = currency.currencySymbol;
    const currencyDecimalPlaces = getDecimalPlaces(localCurrencyCode);
    const { checkoutMode, partialPaymentEnabled, partialPaymentAmount } = checkout;
    const [customerIdentity, checkoutReadiness] = await Promise.all([
        getOfferedCustomerIdentity(db, customerAuth, { encryptionKey, runtimeEnv, appProviders }),
        getCheckoutReadiness(db, { encryptionKey, runtimeEnv, appProviders }),
    ]);

    if (!isReady(checkoutReadiness)) {
        return {
            gateways: [],
            guestCheckoutEnabled: checkout.guestCheckoutEnabled,
            customerIdentity,
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
            marketingConsent,
            ...(market === undefined ? {} : { market }),
        };
    }

    const gatewaySnapshot = await getPaymentGatewaySettingsSnapshot(db, encryptionKey, paymentProviders);
    const activePaymentMethods = gatewaySnapshot.activePaymentMethods;
    const providers = gatewaySnapshot.providers ?? BUILT_IN_PAYMENT_PROVIDERS;
    const savedGatewaySettings = gatewaySnapshot.settings as unknown as Record<string, GatewaySettings | null | undefined>;
    // The merchant's saved order is both the allowlist and the buyer-visible
    // presentation order. Each method must still be ready right now.
    const gateways: Array<Record<string, unknown>> = [];
    for (const methodId of activePaymentMethods.enabledMethods) {
        if (providers.currencyIssue(methodId, localCurrencyCode) !== null) continue;
        if (!isCheckoutGatewayUsableForFlow({ gatewayId: methodId, checkoutMode, partialPaymentEnabled, partialPaymentAmount })) continue;
        // A method that serves only some shipping countries says which:
        // checkout hides it for a delivery elsewhere (cash on delivery: BD).
        const countries = providers.countries(methodId);
        const served = countries === "any" ? {} : { countries: [...countries] };
        if (methodId === COD_PAYMENT_METHOD) {
            gateways.push({ id: methodId, name: COD_LABEL, flow: "cod", currencies: [localCurrencyCode], ...served });
            continue;
        }
        const gateway = providers.get(methodId);
        // Built-in settings come with the snapshot; an active app method's gateway loads its own.
        const settings = savedGatewaySettings[methodId] ?? (gateway && isQualifiedProviderId(methodId)
            ? await gateway.loadSettings(db, encryptionKey)
            : null);
        if (!gateway || !settings || !gateway.readiness(settings).usable) continue;
        const amountLimits = publicAmountLimits(gateway);
        gateways.push({
            id: gateway.id,
            name: gateway.checkoutName,
            flow: gateway.flow,
            currencies: [localCurrencyCode],
            ...served,
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
        customerIdentity,
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
        marketingConsent,
        ...(market === undefined ? {} : { market }),
    };
}
