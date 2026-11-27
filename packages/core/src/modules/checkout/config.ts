// src/modules/checkout/config.ts
// Assembles the public checkout configuration from DB + gateway registry.

import type { Database } from "@scalius/database/client";
import { giftCards } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import { deps } from "../../cache-deps";
import {
    getDecimalPlaces,
    normalizeSupportedCurrencyCode,
} from "@scalius/shared/currency";
import type { CustomerIdentitySettings } from "@scalius/shared/customer-auth-policy";
import { currencySymbol } from "@scalius/shared/money-format";
import { isReady } from "@scalius/shared/readiness";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import type { AppProviders } from "../../integrations/provider-port";
import {
  BUILT_IN_PAYMENT_PROVIDERS,
  COD_LABEL,
  COD_PAYMENT_METHOD,
  type GatewaySettings,
  NET_TERMS_LABEL,
  NET_TERMS_PAYMENT_METHOD,
  getPaymentGatewaySettingsSnapshot,
  type PaymentProvidersSource,
  publicAmountLimits,
} from "../payments";
import { isCheckoutGatewayUsableForFlow } from "./flow";
import {
    CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE,
    type CheckoutReadiness,
} from "@scalius/shared/checkout-readiness";
import { getCheckoutReadinessAlongside } from "./readiness";
import { getOfferedCustomerIdentity } from "../customers";
import {
  acceptedCustomerCountries,
  checkoutDocument,
  currencyDocument,
  customerAuthDocument,
  customerCountriesDocument,
  marketingConsentDocument,
  paymentMethodsDocument,
  stripeDocument,
  selectDocumentsWithSellingCountries,
} from "../settings";
import type { SettingsDocumentRow } from "../../settings-store";
import { readPresenceMarketWithDocuments, type PresenceMarket } from "../markets";
import { NotFoundError } from "../../errors";
import { applyTranslation, readTranslationChains, translationScope } from "../translations";

export interface CheckoutConfig {
    gateways: Array<Record<string, unknown>>;
    activeDefaultMethod?: string;
    guestCheckoutEnabled: boolean;
    /** Customer accounts settings; `channels` lists only chosen channels that can send now. */
    customerIdentity: CustomerIdentitySettings;
    checkoutMode: string;
    partialPaymentEnabled: boolean;
    partialPaymentAmount: number;
    /** Settings → Checkout: every order asks for a full billing address (Shopify's option). */
    requireFullBillingAddress: boolean;
    /** Settings → Checkout: the buyer ticks "I agree to the terms" before the order is placed (the commit refuses without it). */
    requireTermsAcceptance: boolean;
    /**
     * The phone countries checkout accepts: the merchant's customer-country
     * policy united with every country an active market sells to
     * (`acceptedPhoneCountryPolicy`). An empty list accepts every country.
     */
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
    /**
     * Whether the store holds a live gift card (active, unexpired, with a
     * balance, in a currency this page sells in). A store that takes only cash
     * sells a key only to a buyer with a gift card: without one live, nobody
     * can pay for it. Read only there (every enabled method the built-in cash);
     * false on any other store, where nothing uses it.
     */
    giftCardsLive: boolean;
}

/**
 * Until when a live gift card exists (active, a balance above zero, not
 * expired, in one of `currencies`): null when none does, 0 when one never
 * expires, else the latest expiry among the live cards, the instant the answer
 * turns false with no write. Both probes walk only the live cards' partial
 * index (`gift_cards_live_idx`, 0228). The `gc` key follows a card's issue,
 * removal, status, expiry and balance reaching or leaving zero.
 */
function giftCardsLiveUntilSql(nowSeconds: number, currencies: readonly string[]): SQL<number | null> {
    const live = sql`${giftCards.status} = 'active' AND ${giftCards.balanceMinor} > 0
        AND ${giftCards.currencyCode} IN (${sql.join(currencies.map((code) => sql`${code}`), sql`, `)})`;
    return sql<number | null>`CASE WHEN EXISTS (SELECT 1 FROM ${giftCards} WHERE ${live} AND ${giftCards.expiresAt} IS NULL) THEN 0
        ELSE (SELECT MAX(${giftCards.expiresAt}) FROM ${giftCards} WHERE ${live} AND ${giftCards.expiresAt} > ${nowSeconds}) END`;
}

function liveUntilOf(value: unknown): number | null {
    return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}

/**
 * Every method the merchant enabled is the built-in cash method (no saved
 * methods: cash alone, the default). The only store whose pages read gift
 * card liveness: elsewhere a method that is not cash pays what cash can't,
 * and nothing reads or depends on whether a card is live.
 */
async function enablesCashAlone(rows: readonly SettingsDocumentRow[]): Promise<boolean> {
    const read = await paymentMethodsDocument.fromRows(rows);
    if (read.invalid) return false;
    const enabled = read.value.enabledMethods ?? [COD_PAYMENT_METHOD];
    return enabled.length > 0 && enabled.every((method) => method === COD_PAYMENT_METHOD);
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
        // Payment readiness uses this same request snapshot, without a third read wave.
        paymentMethodsDocument,
        stripeDocument,
    ];
    let rows: SettingsDocumentRow[];
    let sellingCountries: string[];
    let market: PresenceMarket | undefined;
    if (presence === undefined) {
        ({ rows, sellingCountries } = await selectDocumentsWithSellingCountries(db, documents));
    } else {
        const read = await readPresenceMarketWithDocuments(db, presence, documents);
        // No active market holds the presence: a 404, and nothing else is read.
        if (!read.market) throw new NotFoundError("Market not found");
        rows = read.documentRows;
        sellingCountries = read.sellingCountries;
        market = read.market;
    }
    const [checkout, currency, customerAuth, merchantCountries, marketing] = await Promise.all([
        checkoutDocument.fromRows(rows).then((result) => result.value),
        currencyDocument.fromRows(rows).then((result) => result.value),
        customerAuthDocument.fromRows(rows).then((result) => result.value),
        customerCountriesDocument.fromRows(rows).then((result) => result.value),
        marketingConsentDocument.fromRows(rows).then((result) => result.value),
    ]);
    // What the storefront's phone field and sign-in dialog apply: the merchant's
    // policy and the countries the markets sell to, as one list.
    const allowedCountriesConfig = acceptedCustomerCountries(merchantCountries, sellingCountries);
    const marketingConsent = {
        enabled: marketing.checkout.enabled,
        channels: [...marketing.checkout.channels],
        label: { ...marketing.checkout.label },
    };

    // A presence of a market in its own currency checks out in it
    // (MARKETS-DESIGN step 6): its symbol and places, only the methods that
    // charge it, and no advance (a deposit is a shop-currency amount).
    const foreignCurrency = market?.currencyCode && market.currencyCode !== currency.currencyCode
        ? market.currencyCode
        : null;
    const localCurrencyCode = foreignCurrency ?? currency.currencyCode;
    const localCurrencySymbol = foreignCurrency ? currencySymbol(foreignCurrency) : currency.currencySymbol;
    const currencyDecimalPlaces = getDecimalPlaces(localCurrencyCode);
    const { checkoutMode, partialPaymentAmount } = checkout;
    const partialPaymentEnabled = checkout.partialPaymentEnabled && foreignCurrency === null;
    // Gift card liveness, only on a store whose every method is cash (the one
    // case a page uses it): read beside readiness, in the wave it already waits
    // for, and declared (`gc`) only there. A store with any other method neither
    // reads nor depends on it, so a gift card sale there invalidates no page.
    const cashAlone = await enablesCashAlone(rows);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const [customerIdentity, { readiness: checkoutReadiness, alongside: liveRead }] = await Promise.all([
        getOfferedCustomerIdentity(db, customerAuth, { encryptionKey, runtimeEnv, appProviders }),
        // This projection has no cart. Physical carts validate their chosen
        // option and destination in delivery preflight, for both quote and order.
        // The live gift cards ride its shipping statement: no D1 call of their own.
        getCheckoutReadinessAlongside(db, { encryptionKey, runtimeEnv, appProviders, requireDeliverySetup: false },
            cashAlone ? giftCardsLiveUntilSql(nowSeconds, [...new Set([localCurrencyCode, currency.currencyCode])]) : undefined),
    ]);
    const liveUntil = cashAlone ? liveUntilOf(liveRead) : null;
    if (cashAlone) deps.giftCardsLive();
    const giftCardsLive = liveUntil !== null;
    // The last live card's expiry passes with no write: the answer is never served at or after it.
    if (liveUntil !== null && liveUntil > 0) deps.validUntil(liveUntil * 1000);

    if (!isReady(checkoutReadiness)) {
        return {
            gateways: [],
            guestCheckoutEnabled: checkout.guestCheckoutEnabled,
            customerIdentity,
            checkoutMode,
            partialPaymentEnabled,
            partialPaymentAmount,
            requireFullBillingAddress: checkout.requireFullBillingAddress,
            requireTermsAcceptance: checkout.requireTermsAcceptance,
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
            giftCardsLive,
        };
    }

    const gatewaySnapshot = await getPaymentGatewaySettingsSnapshot(db, encryptionKey, paymentProviders, rows);
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
            gateways.push({ id: methodId, name: COD_LABEL, flow: "cod", paymentKind: "cash_on_delivery", currencies: [localCurrencyCode], ...served });
            continue;
        }
        // The invoice is listed with its terms; a buyer's quote says whether
        // it reaches them (signed-in and eligible only, payment-terms.ts).
        if (methodId === NET_TERMS_PAYMENT_METHOD) {
            gateways.push({
                id: methodId,
                name: NET_TERMS_LABEL,
                flow: "deferred",
                paymentKind: "invoice",
                dueInDays: activePaymentMethods.netTerms.dueInDays,
                currencies: [localCurrencyCode],
            });
            continue;
        }
        const gateway = providers.get(methodId);
        // Built-in settings come with the snapshot; an active app method's gateway loads its own.
        const settings = savedGatewaySettings[methodId] ?? (gateway && isQualifiedProviderId(methodId)
            ? await gateway.loadSettings(db, encryptionKey)
            : null);
        if (!gateway || !settings || !gateway.readiness(settings).usable) continue;
        const amountLimits = publicAmountLimits(gateway, localCurrencyCode);
        gateways.push({
            id: gateway.id,
            name: gateway.checkoutName,
            flow: gateway.flow,
            paymentKind: providers.paymentKind(gateway.id) ?? "online",
            ...(gateway.flow === "deferred" && gateway.dueInDays ? { dueInDays: gateway.dueInDays } : {}),
            currencies: [localCurrencyCode],
            ...served,
            ...(amountLimits ? { amountLimits } : {}),
            ...gateway.publicConfig?.(settings),
        });
    }

    // A presence's payment method names in its language (MARKETS-DESIGN D9):
    // one more statement there, none at the root.
    const translation = translationScope(presence);
    if (translation) {
        const chains = await readTranslationChains(db, translation, "payment_method", gateways.map((gateway) => String(gateway.id)));
        for (const [index, gateway] of gateways.entries()) {
            gateways[index] = applyTranslation(gateway, chains.get(String(gateway.id)) ?? [], { name: "name" });
        }
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
        requireFullBillingAddress: checkout.requireFullBillingAddress,
        requireTermsAcceptance: checkout.requireTermsAcceptance,
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
        giftCardsLive,
    };
}
