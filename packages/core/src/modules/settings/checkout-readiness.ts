import type { Database } from "@scalius/database/client";
import { deliveryLocations, shippingMethods } from "@scalius/database/schema";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

export interface CheckoutReadiness {
    ready: boolean;
    hasActiveShippingMethod: boolean;
    hasActiveDeliveryHierarchy: boolean;
    issues: string[];
}

export interface CheckoutReadinessOptions {
    excludeShippingMethodIds?: readonly string[];
    excludeDeliveryLocationIds?: readonly string[];
}

export const CHECKOUT_READINESS_SHIPPING_ISSUE =
    "Add at least one active shipping method before checkout can accept orders.";
export const CHECKOUT_READINESS_LOCATION_ISSUE =
    "Add at least one active city with an active zone before checkout can accept orders.";

export const CHECKOUT_READINESS_PUBLIC_UNAVAILABLE_MESSAGE =
    "Checkout is temporarily unavailable while the merchant finishes delivery setup.";

function uniqueIds(ids: readonly string[] | undefined): string[] {
    return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

export async function getCheckoutReadiness(
    db: Database,
    options: CheckoutReadinessOptions = {},
): Promise<CheckoutReadiness> {
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
