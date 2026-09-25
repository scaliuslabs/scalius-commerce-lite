import type { Database } from "@scalius/database/client";
import { deliveryLocations, shippingMethods } from "@scalius/database/schema";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
    isReady,
    mergeReadiness,
    readiness,
    readinessIssue,
    type Readiness,
    type ReadinessIssue,
} from "@scalius/shared/readiness";
import {
    CUSTOMER_AUTH_OTP_CHANNELS,
    offeredChannels,
    type ChannelReadiness,
    type CustomerAuthOtpChannel,
    type CustomerIdentitySettings,
} from "@scalius/shared/customer-auth-policy";
import { getEmailProviderReadiness } from "../../integrations/email";
import { getSmsProviderReadiness } from "../../integrations/sms";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";
import { checkoutDocument, customerAuthDocument } from "./documents";
import { selectSettingsDocuments } from "./settings-store";
import { deps } from "../../cache-deps";

/**
 * Checkout readiness speaks the one shared vocabulary (`status` + `issues`)
 * and adds the typed extras the dashboard uses to light up individual rows.
 */
export interface CheckoutDeliveryReadiness extends Readiness {
    hasActiveShippingMethod: boolean;
    hasActiveDeliveryHierarchy: boolean;
}

export interface CheckoutReadiness extends CheckoutDeliveryReadiness {
    customerSignInRequired: boolean;
    hasUsableCustomerSignIn: boolean;
}

export interface CustomerSignInReadiness extends Readiness {
    customerSignInRequired: boolean;
    hasUsableCustomerSignIn: boolean;
}

export interface CheckoutReadinessOptions {
    excludeShippingMethodIds?: readonly string[];
    excludeDeliveryLocationIds?: readonly string[];
    encryptionKey?: string;
    runtimeEnv?: Record<string, unknown>;
    inspectOptionalCustomerSignIn?: boolean;
    customerSignInRequiredOverride?: boolean;
}

/** Stable issue codes. Consumers match on these, never on merchant copy. */
export const CHECKOUT_READINESS_CODES = {
    shipping: "missing_active_shipping_method",
    deliveryLocation: "missing_active_delivery_location",
    customerSignIn: "unusable_customer_sign_in",
} as const;

export const CHECKOUT_READINESS_SHIPPING_ISSUE: ReadinessIssue = readinessIssue(
    CHECKOUT_READINESS_CODES.shipping,
    "Add at least one active shipping method before checkout can accept orders.",
);
export const CHECKOUT_READINESS_LOCATION_ISSUE: ReadinessIssue = readinessIssue(
    CHECKOUT_READINESS_CODES.deliveryLocation,
    "Add at least one active city with an active thana before checkout can accept orders.",
);
export const CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE: ReadinessIssue = readinessIssue(
    CHECKOUT_READINESS_CODES.customerSignIn,
    "Configure a usable customer sign-in verification channel before requiring customer accounts at checkout.",
);

export const CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE =
    "Checkout is temporarily unavailable while the merchant finishes checkout setup.";

function uniqueIds(ids: readonly string[] | undefined): string[] {
    return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

export async function getCheckoutDeliveryReadiness(
    db: Database,
    options: CheckoutReadinessOptions = {},
): Promise<CheckoutDeliveryReadiness> {
    const excludedShippingMethodIds = uniqueIds(options.excludeShippingMethodIds);
    const excludedDeliveryLocationIds = uniqueIds(options.excludeDeliveryLocationIds);
    deps.shipping();
    deps.locations();

    const shippingConditions: SQL[] = [
        eq(shippingMethods.isActive, true),
        isNull(shippingMethods.deletedAt),
    ];
    if (excludedShippingMethodIds.length > 0) {
        shippingConditions.push(notInArray(shippingMethods.id, excludedShippingMethodIds));
    }

    const zoneConditions: SQL[] = [
        eq(deliveryLocations.type, "zone"),
        eq(deliveryLocations.isActive, true),
        isNull(deliveryLocations.deletedAt),
    ];
    if (excludedDeliveryLocationIds.length > 0) {
        zoneConditions.push(notInArray(deliveryLocations.id, excludedDeliveryLocationIds));
    }

    const excludedCityPredicate: SQL = excludedDeliveryLocationIds.length > 0
        ? sql`AND city.id NOT IN (${sql.join(excludedDeliveryLocationIds.map((id) => sql`${id}`), sql`, `)})`
        : sql``;
    zoneConditions.push(sql`
        EXISTS (
            SELECT 1
            FROM delivery_locations city
            WHERE city.id = ${deliveryLocations.parentId}
              AND city.type = 'city'
              AND city.is_active = 1
              AND city.deleted_at IS NULL
              ${excludedCityPredicate}
        )
    `);

    const [activeShippingMethodRows, activeHierarchyRows] = await Promise.all([
        db
            .select({ id: shippingMethods.id })
            .from(shippingMethods)
            .where(and(...shippingConditions))
            .limit(1),
        db
            .select({ id: deliveryLocations.id })
            .from(deliveryLocations)
            .where(and(...zoneConditions))
            .limit(1),
    ]);

    const hasActiveShippingMethod = activeShippingMethodRows.length > 0;
    const hasActiveDeliveryHierarchy = activeHierarchyRows.length > 0;
    const issues: ReadinessIssue[] = [];
    if (!hasActiveShippingMethod) issues.push(CHECKOUT_READINESS_SHIPPING_ISSUE);
    if (!hasActiveDeliveryHierarchy) issues.push(CHECKOUT_READINESS_LOCATION_ISSUE);

    const value = readiness.from(issues);
    return {
        ...value,
        hasActiveShippingMethod,
        hasActiveDeliveryHierarchy,
    };
}

export async function getCheckoutReadiness(
    db: Database,
    options: CheckoutReadinessOptions = {},
): Promise<CheckoutReadiness> {
    const [delivery, signIn] = await Promise.all([
        getCheckoutDeliveryReadiness(db, options),
        getCustomerSignInReadiness(db, options),
    ]);
    const value = mergeReadiness(delivery, signIn);

    return {
        ...value,
        hasActiveShippingMethod: delivery.hasActiveShippingMethod,
        hasActiveDeliveryHierarchy: delivery.hasActiveDeliveryHierarchy,
        customerSignInRequired: signIn.customerSignInRequired,
        hasUsableCustomerSignIn: signIn.hasUsableCustomerSignIn,
    };
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
    options: Pick<CheckoutReadinessOptions, "encryptionKey" | "runtimeEnv">,
): Promise<boolean> {
    if (!options.encryptionKey?.trim()) return false;
    try {
        if (channel === "email") {
            return isReady(await getEmailProviderReadiness({ db, encryptionKey: options.encryptionKey, env: options.runtimeEnv }));
        }
        if (channel === "sms") return isReady(await getSmsProviderReadiness(db, options.encryptionKey));
        const whatsapp = await getWhatsAppCloudApiSettings(db, options.encryptionKey);
        return Boolean(whatsapp.accessToken && whatsapp.phoneNumberId);
    } catch {
        return false;
    }
}

/** Readiness of each listed channel (all three by default). */
export async function getCustomerChannelReadiness(
    db: Database,
    options: Pick<CheckoutReadinessOptions, "encryptionKey" | "runtimeEnv">,
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
    options: Pick<CheckoutReadinessOptions, "encryptionKey" | "runtimeEnv">,
): Promise<CustomerIdentitySettings> {
    const ready = await getCustomerChannelReadiness(db, options, settings.channels);
    return { ...settings, channels: offeredChannels(settings, ready) };
}
