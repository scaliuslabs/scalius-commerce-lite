import type { Database } from "@scalius/database/client";
import { deliveryLocations, settings, shippingMethods, siteSettings } from "@scalius/database/schema";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { normalizeCustomerAuthPolicy } from "@scalius/shared/customer-auth-policy";
import { getEmailProviderReadiness } from "../../integrations/email";
import { getSmsProviderReadiness } from "../../integrations/sms";
import { getWhatsAppCloudApiSettings } from "../../integrations/whatsapp";

export interface CheckoutReadiness {
    ready: boolean;
    hasActiveShippingMethod: boolean;
    hasActiveDeliveryHierarchy: boolean;
    customerSignInRequired: boolean;
    hasUsableCustomerSignIn: boolean;
    issues: string[];
}

export interface CheckoutReadinessOptions {
    excludeShippingMethodIds?: readonly string[];
    excludeDeliveryLocationIds?: readonly string[];
    encryptionKey?: string;
    runtimeEnv?: Record<string, unknown>;
    inspectOptionalCustomerSignIn?: boolean;
    customerSignInRequiredOverride?: boolean;
}

export interface CheckoutDeliveryReadiness {
    ready: boolean;
    hasActiveShippingMethod: boolean;
    hasActiveDeliveryHierarchy: boolean;
    issues: string[];
}

export const CHECKOUT_READINESS_SHIPPING_ISSUE =
    "Add at least one active shipping method before checkout can accept orders.";
export const CHECKOUT_READINESS_LOCATION_ISSUE =
    "Add at least one active city with an active zone before checkout can accept orders.";
export const CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE =
    "Configure a usable customer sign-in verification channel before requiring customer accounts at checkout.";

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
    const issues: string[] = [];
    if (!hasActiveShippingMethod) issues.push(CHECKOUT_READINESS_SHIPPING_ISSUE);
    if (!hasActiveDeliveryHierarchy) issues.push(CHECKOUT_READINESS_LOCATION_ISSUE);

    return {
        ready: issues.length === 0,
        hasActiveShippingMethod,
        hasActiveDeliveryHierarchy,
        issues,
    };
}

export async function getCheckoutReadiness(
    db: Database,
    options: CheckoutReadinessOptions = {},
): Promise<CheckoutReadiness> {
    const delivery = await getCheckoutDeliveryReadiness(db, options);
    const signIn = await getCustomerSignInReadiness(db, options);
    const issues = [...delivery.issues];
    if (signIn.customerSignInRequired && !signIn.hasUsableCustomerSignIn) {
        issues.push(CHECKOUT_READINESS_CUSTOMER_SIGN_IN_ISSUE);
    }

    return {
        ready: issues.length === 0,
        hasActiveShippingMethod: delivery.hasActiveShippingMethod,
        hasActiveDeliveryHierarchy: delivery.hasActiveDeliveryHierarchy,
        customerSignInRequired: signIn.customerSignInRequired,
        hasUsableCustomerSignIn: signIn.hasUsableCustomerSignIn,
        issues,
    };
}

export async function getCustomerSignInReadiness(
    db: Database,
    options: CheckoutReadinessOptions,
): Promise<{ customerSignInRequired: boolean; hasUsableCustomerSignIn: boolean }> {
    const site = await db
        .select({
            guestCheckoutEnabled: siteSettings.guestCheckoutEnabled,
            authVerificationMethod: siteSettings.authVerificationMethod,
        })
        .from(siteSettings)
        .limit(1)
        .get();
    const customerSignInRequired = options.customerSignInRequiredOverride
        ?? site?.guestCheckoutEnabled === false;
    if (!customerSignInRequired && !options.inspectOptionalCustomerSignIn) {
        return { customerSignInRequired: false, hasUsableCustomerSignIn: true };
    }
    if (!options.encryptionKey?.trim()) {
        return { customerSignInRequired, hasUsableCustomerSignIn: false };
    }

    const policyRow = await db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.category, "customer_auth"), eq(settings.key, "policy")))
        .get();
    const policy = normalizeCustomerAuthPolicy(
        parseCustomerAuthPolicy(policyRow?.value),
        site?.authVerificationMethod,
    );

    for (const channel of policy.otpChannels) {
        try {
            if (channel === "email") {
                const readiness = await getEmailProviderReadiness({
                    db,
                    encryptionKey: options.encryptionKey,
                    env: options.runtimeEnv,
                });
                if (readiness.configured) {
                    return { customerSignInRequired, hasUsableCustomerSignIn: true };
                }
            } else if (channel === "sms") {
                const readiness = await getSmsProviderReadiness(db, options.encryptionKey);
                if (readiness.configured) {
                    return { customerSignInRequired, hasUsableCustomerSignIn: true };
                }
            } else {
                const whatsapp = await getWhatsAppCloudApiSettings(db, options.encryptionKey);
                if (whatsapp.accessToken && whatsapp.phoneNumberId && whatsapp.authTemplateName) {
                    return { customerSignInRequired, hasUsableCustomerSignIn: true };
                }
            }
        } catch {
            // Provider reads fail closed. The caller receives only the safe readiness issue.
        }
    }

    return { customerSignInRequired, hasUsableCustomerSignIn: false };
}

function parseCustomerAuthPolicy(value: string | null | undefined): unknown {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return undefined;
    }
}
