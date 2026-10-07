// src/modules/checkout/readiness.ts
// Whether checkout can accept orders: an active shipping method, an active
// delivery hierarchy, and (when accounts are required) a usable customer
// sign-in channel.

import type { Database } from "@scalius/database/client";
import { places, shippingMethods } from "@scalius/database/schema";
import { PLACE_ADDRESS_COUNTRY } from "@scalius/shared/places";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
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

    // An active thana (level 2) under an active Bangladesh city (level 1).
    const zoneConditions: SQL[] = [
        eq(places.countryCode, PLACE_ADDRESS_COUNTRY),
        eq(places.level, 2),
        eq(places.isActive, true),
        isNull(places.deletedAt),
    ];
    if (excludedDeliveryLocationIds.length > 0) {
        zoneConditions.push(notInArray(places.id, excludedDeliveryLocationIds));
    }

    const excludedCityPredicate: SQL = excludedDeliveryLocationIds.length > 0
        ? sql`AND city.id NOT IN (${sql.join(excludedDeliveryLocationIds.map((id) => sql`${id}`), sql`, `)})`
        : sql``;
    zoneConditions.push(sql`
        EXISTS (
            SELECT 1
            FROM places city
            WHERE city.id = ${places.parentId}
              AND city.level = 1
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
            .select({ id: places.id })
            .from(places)
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
