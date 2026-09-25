import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Cart-validation readiness column for a digital variant (design §3.1): 1 when
 * the variant has something ready to deliver, a ready file (the product-wide
 * ones or its own) or a ready licence-key pool, and none of its ready pools is
 * empty; else 0 (FULFILMENT_UNAVAILABLE). A key pool is also the variant's
 * tracked stock, so reservations keep demand within the keys left.
 * A correlated expression inside the existing variant read: no round trip.
 * Driven by `digital_assets_variant_status_idx`, `digital_assets_product_status_idx`
 * and `digital_licence_keys_pool_idx`.
 */
export function digitalDeliverableSql(variantId: SQLWrapper): SQL {
    return sql`(CASE WHEN (
        EXISTS (
            SELECT 1 FROM digital_assets dga
            WHERE dga.product_id = (SELECT dpv.product_id FROM product_variants dpv WHERE dpv.id = ${variantId})
              AND dga.status = 'ready' AND dga.kind = 'file'
              AND (dga.variant_id IS NULL OR dga.variant_id = ${variantId})
        )
        OR EXISTS (
            SELECT 1 FROM digital_assets dga
            WHERE dga.variant_id = ${variantId} AND dga.status = 'ready' AND dga.kind = 'licence_keys'
        )
    ) AND NOT EXISTS (
        SELECT 1 FROM digital_assets dga
        WHERE dga.variant_id = ${variantId} AND dga.status = 'ready' AND dga.kind = 'licence_keys'
          AND NOT EXISTS (
              SELECT 1 FROM digital_licence_keys dlk
              WHERE dlk.asset_id = dga.id AND dlk.status = 'available'
          )
    ) THEN 1 ELSE 0 END)`;
}
