// src/modules/customers/sign-in-readiness.ts
// Whether buyers can sign in: which customer code channels (email, SMS,
// WhatsApp) can send right now, and whether required accounts block checkout.
// Provider reads fail closed.

import type { Database } from "@scalius/database/client";
import { isReady, readiness } from "@scalius/shared/readiness";
import {
    CUSTOMER_AUTH_OTP_CHANNELS,
    offeredChannels,
    type ChannelReadiness,
    type CustomerAuthOtpChannel,
    type CustomerIdentitySettings,
} from "@scalius/shared/customer-auth-policy";
import {
    CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE,
    type CustomerSignInReadiness,
} from "@scalius/shared/checkout-readiness";
import { getEmailProviderReadiness } from "../../integrations/email";
import { getSmsProviderReadiness } from "../../integrations/sms";
import type { AppProviders } from "../../integrations/provider-port";
import { resolveWhatsAppSender } from "../../integrations/whatsapp-sender";
import { selectSettingsDocuments } from "../../settings-store";
import { checkoutDocument, customerAuthDocument } from "../settings";

export interface CheckoutReadinessOptions {
    excludeShippingMethodIds?: readonly string[];
    excludeDeliveryLocationIds?: readonly string[];
    encryptionKey?: string;
    runtimeEnv?: Record<string, unknown>;
    /** The app providers a saved SMS or email choice may name. */
    appProviders?: AppProviders;
    inspectOptionalCustomerSignIn?: boolean;
    customerSignInRequiredOverride?: boolean;
}

function customerSignInReadiness(
    customerSignInRequired: boolean,
    hasUsableCustomerSignIn: boolean,
): CustomerSignInReadiness {
    // An unusable channel only blocks checkout when accounts are required.
    const value = customerSignInRequired && !hasUsableCustomerSignIn
        ? readiness.incomplete([CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE])
        : readiness.ready();
    return { ...value, customerSignInRequired, hasUsableCustomerSignIn };
}

export async function getCustomerSignInReadiness(
    db: Database,
    options: CheckoutReadinessOptions,
): Promise<CustomerSignInReadiness> {
    const rows = await selectSettingsDocuments(db, [checkoutDocument, customerAuthDocument]);
    const checkout = await checkoutDocument.fromRows(rows);
    const customerSignInRequired = options.customerSignInRequiredOverride
        ?? !checkout.value.guestCheckoutEnabled;
    if (!customerSignInRequired && !options.inspectOptionalCustomerSignIn) {
        return customerSignInReadiness(false, true);
    }
    if (!options.encryptionKey?.trim()) {
        return customerSignInReadiness(customerSignInRequired, false);
    }

    const identity = (await customerAuthDocument.fromRows(rows)).value;
    const ready = await getCustomerChannelReadiness(db, options, identity.channels);
    return customerSignInReadiness(customerSignInRequired, offeredChannels(identity, ready).length > 0);
}

/** Whether one code channel's provider can send right now. Provider reads fail closed. */
export async function isCustomerAuthChannelReady(
    db: Database,
    channel: CustomerAuthOtpChannel,
    options: Pick<CheckoutReadinessOptions, "encryptionKey" | "runtimeEnv" | "appProviders">,
): Promise<boolean> {
    if (!options.encryptionKey?.trim()) return false;
    try {
        if (channel === "email") {
            return isReady(await getEmailProviderReadiness({ db, encryptionKey: options.encryptionKey, env: options.runtimeEnv, appProviders: options.appProviders }));
        }
        if (channel === "sms") return isReady(await getSmsProviderReadiness(db, options.encryptionKey, options.appProviders));
        return (await resolveWhatsAppSender(db, { encryptionKey: options.encryptionKey, appProviders: options.appProviders })).ready;
    } catch {
        return false;
    }
}

/** Readiness of each listed channel (all three by default). */
export async function getCustomerChannelReadiness(
    db: Database,
    options: Pick<CheckoutReadinessOptions, "encryptionKey" | "runtimeEnv" | "appProviders">,
    channels: readonly CustomerAuthOtpChannel[] = CUSTOMER_AUTH_OTP_CHANNELS,
): Promise<ChannelReadiness> {
    const ready = await Promise.all(channels.map((channel) => isCustomerAuthChannelReady(db, channel, options)));
    const result: ChannelReadiness = { email: false, sms: false, whatsapp: false };
    channels.forEach((channel, index) => { result[channel] = ready[index]!; });
    return result;
}

/**
 * The identity settings buyers see: the merchant's fields, and only the
 * chosen channels that can send right now (possibly none: then sign-in says
 * codes are unavailable). A channel the merchant didn't choose is never added.
 */
export async function getOfferedCustomerIdentity(
    db: Database,
    settings: CustomerIdentitySettings,
    options: Pick<CheckoutReadinessOptions, "encryptionKey" | "runtimeEnv" | "appProviders">,
): Promise<CustomerIdentitySettings> {
    const ready = await getCustomerChannelReadiness(db, options, settings.channels);
    return { ...settings, channels: offeredChannels(settings, ready) };
}
