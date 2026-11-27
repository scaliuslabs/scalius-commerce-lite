// src/modules/checkout/readiness.ts
// Checkout setup diagnostics and the readiness facts a caller requires.
// Delivery is a cart-specific requirement; a cartless public configuration
// must not block downloads or services on shipping setup.

import type { Database } from "@scalius/database/client";
import { places, shippingMethods } from "@scalius/database/schema";
import { PLACE_ADDRESS_COUNTRY } from "@scalius/shared/places";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { mergeReadiness, readiness, type ReadinessIssue } from "@scalius/shared/readiness";
import {
    CHECKOUT_READINESS_LOCATION_ISSUE,
    CHECKOUT_READINESS_SHIPPING_ISSUE,
    type CheckoutDeliveryReadiness,
    type CheckoutReadiness,
} from "@scalius/shared/checkout-readiness";
import { deps } from "../../cache-deps";
import { type CheckoutReadinessOptions, getCustomerSignInReadiness } from "../customers";

export async function getCheckoutDeliveryReadiness(
    db: Database,
    /**
     * One more scalar a caller reads in the shipping statement, which always
     * answers one row (checkout configuration's live gift cards, on a store
     * that takes only cash): no D1 call of its own.
     */
    alongside?: SQL<unknown>,
): Promise<CheckoutDeliveryReadiness & { alongside?: unknown }> {
    deps.shipping();
    deps.locations();

    const shippingConditions: SQL[] = [
        eq(shippingMethods.isActive, true),
        isNull(shippingMethods.deletedAt),
    ];

    // An active thana (level 2) under an active Bangladesh city (level 1).
    const zoneConditions: SQL[] = [
        eq(places.countryCode, PLACE_ADDRESS_COUNTRY),
        eq(places.level, 2),
        eq(places.isActive, true),
        isNull(places.deletedAt),
    ];
    zoneConditions.push(sql`
        EXISTS (
            SELECT 1
            FROM places city
            WHERE city.id = ${places.parentId}
              AND city.level = 1
              AND city.is_active = 1
              AND city.deleted_at IS NULL
        )
    `);

    const [activeShippingMethodRows, activeHierarchyRows] = await Promise.all([
        // A one-row source joined with the first active method: one row whether a method exists or not.
        db
            .select({ id: shippingMethods.id, alongside: alongside ?? sql`NULL` })
            .from(sql`(SELECT 1 AS one) AS readiness_row`)
            .leftJoin(shippingMethods, and(...shippingConditions))
            .limit(1),
        db
            .select({ id: places.id })
            .from(places)
            .where(and(...zoneConditions))
            .limit(1),
    ]);

    const hasActiveShippingMethod = activeShippingMethodRows[0]?.id != null;
    const hasActiveDeliveryHierarchy = activeHierarchyRows.length > 0;
    const issues: ReadinessIssue[] = [];
    if (!hasActiveShippingMethod) issues.push(CHECKOUT_READINESS_SHIPPING_ISSUE);
    if (!hasActiveDeliveryHierarchy) issues.push(CHECKOUT_READINESS_LOCATION_ISSUE);

    const value = readiness.from(issues);
    return {
        ...value,
        hasActiveShippingMethod,
        hasActiveDeliveryHierarchy,
        ...(alongside ? { alongside: activeShippingMethodRows[0]?.alongside } : {}),
    };
}

export async function getCheckoutReadiness(
    db: Database,
    options: CheckoutReadinessOptions & {
        /** Cartless public config skips delivery blockers; the admin still inspects complete setup. */
        requireDeliverySetup?: boolean;
    } = {},
): Promise<CheckoutReadiness> {
    return (await getCheckoutReadinessAlongside(db, options)).readiness;
}

/** `getCheckoutReadiness` with one more scalar read in its shipping statement (`alongside`). */
export async function getCheckoutReadinessAlongside(
    db: Database,
    options: CheckoutReadinessOptions & { requireDeliverySetup?: boolean } = {},
    alongside?: SQL<unknown>,
): Promise<{ readiness: CheckoutReadiness; alongside?: unknown }> {
    const [{ alongside: read, ...delivery }, signIn] = await Promise.all([
        getCheckoutDeliveryReadiness(db, alongside),
        getCustomerSignInReadiness(db, options),
    ]);
    const value = options.requireDeliverySetup === false ? signIn : mergeReadiness(delivery, signIn);

    return {
        readiness: {
            ...value,
            hasActiveShippingMethod: delivery.hasActiveShippingMethod,
            hasActiveDeliveryHierarchy: delivery.hasActiveDeliveryHierarchy,
            customerSignInRequired: signIn.customerSignInRequired,
            hasUsableCustomerSignIn: signIn.hasUsableCustomerSignIn,
        },
        alongside: read,
    };
}
