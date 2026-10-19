// Home's setup guide (Shopify's "Setup guide"): which of the store's first
// steps are done. Nothing is stored per step; each answer is read from the
// store's own data in one statement, so a step is checked only when it is
// true and unchecks if the data goes away. The steps that need the payment
// providers, the web address or the Bangladesh pack are answered by the API
// route, which holds those readers. Whether a staff member dismissed the
// guide is the staff-setup-guide document (modules/settings).
import { sql } from "drizzle-orm";
import {
    deliveryZoneLocations,
    deliveryZoneRegions,
    deliveryZones,
    orders,
    products,
    productVariants,
    shippingMethods,
    themeSettingsVersions,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";

export interface SetupGuideFacts {
    /** A product that is not in the trash. */
    hasProducts: boolean;
    /** The theme was published from the editor at least once (a restore counts, the first seed does not). */
    themePublished: boolean;
    /** A live delivery rate whose zone serves somewhere, or a live local pickup rate. */
    shippingReady: boolean;
    /** Any order exists, whatever its source. */
    hasOrders: boolean;
    /**
     * Active products a buyer can pay for only online: gift cards, and
     * products whose every live SKU is digital (nothing is handed over, so
     * cash on delivery never fits). Counted up to {@link ONLINE_PAID_PRODUCT_COUNT_CAP}.
     */
    onlinePaidProducts: number;
}

/** Home says "1,000+": the count stops there so the statement stays bounded. */
export const ONLINE_PAID_PRODUCT_COUNT_CAP = 1000;

/** The setup facts the database answers, in one round trip. */
export async function getSetupGuideFacts(db: Database): Promise<SetupGuideFacts> {
    const row = await db
        .select({
            hasProducts: sql<number>`EXISTS (SELECT 1 FROM ${products} WHERE ${products.deletedAt} IS NULL)`,
            themePublished: sql<number>`EXISTS (SELECT 1 FROM ${themeSettingsVersions} WHERE ${themeSettingsVersions.source} IN ('publish', 'rollback'))`,
            shippingReady: sql<number>`EXISTS (
                SELECT 1 FROM ${shippingMethods}
                WHERE ${shippingMethods.isActive} = 1 AND ${shippingMethods.deletedAt} IS NULL
                  AND (${shippingMethods.kind} = 'pickup' OR (
                    ${shippingMethods.zoneId} IS NOT NULL
                    AND EXISTS (SELECT 1 FROM ${deliveryZones} WHERE ${deliveryZones.id} = ${shippingMethods.zoneId})
                    AND (
                      EXISTS (SELECT 1 FROM ${deliveryZoneRegions} WHERE ${deliveryZoneRegions.zoneId} = ${shippingMethods.zoneId})
                      OR EXISTS (SELECT 1 FROM ${deliveryZoneLocations} WHERE ${deliveryZoneLocations.zoneId} = ${shippingMethods.zoneId})
                    )
                  ))
            )`,
            hasOrders: sql<number>`EXISTS (SELECT 1 FROM ${orders})`,
            onlinePaidProducts: sql<number>`(SELECT COUNT(*) FROM (
                SELECT 1 FROM ${products} AS online_paid
                WHERE online_paid.deleted_at IS NULL AND online_paid.is_active = 1
                  AND (
                    online_paid.is_gift_card = 1
                    OR (
                      EXISTS (
                        SELECT 1 FROM ${productVariants} AS digital_sku
                        WHERE digital_sku.product_id = online_paid.id
                          AND digital_sku.fulfillment_kind = 'digital' AND digital_sku.deleted_at IS NULL
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM ${productVariants} AS handed_sku
                        WHERE handed_sku.product_id = online_paid.id
                          AND handed_sku.deleted_at IS NULL AND handed_sku.fulfillment_kind <> 'digital'
                      )
                    )
                  )
                LIMIT ${ONLINE_PAID_PRODUCT_COUNT_CAP}
            ))`,
        })
        .from(sql`(SELECT 1 AS one) AS setup_guide_state`)
        .get();
    return {
        hasProducts: Boolean(Number(row?.hasProducts ?? 0)),
        themePublished: Boolean(Number(row?.themePublished ?? 0)),
        shippingReady: Boolean(Number(row?.shippingReady ?? 0)),
        hasOrders: Boolean(Number(row?.hasOrders ?? 0)),
        onlinePaidProducts: Number(row?.onlinePaidProducts ?? 0),
    };
}
