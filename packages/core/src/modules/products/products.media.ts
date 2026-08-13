import { media, productMedia, products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { getCurrentPublicMediaUrl } from "../../integrations/storage";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

export const MAX_PRODUCT_MEDIA_ASSOCIATIONS = 250;
export const PRODUCT_MEDIA_REORDER_OFFSET = 1_000;
export const PRODUCT_MEDIA_QUERY_CHUNK = 90;

export type ProductMediaProjection = {
    id: string;
    mediaId: string;
    kind: "image" | "video";
    url: string;
    posterMediaId: string | null;
    posterUrl: string | null;
    /** Product-context override only; null keeps Media alt/product-name fallback live. */
    contextualAltText?: string | null;
    altText: string;
    caption: string | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    isPrimary: boolean;
    sortOrder: number;
    status: "ready" | "trashed";
};

export interface ProductMediaProjectionRow {
    productId: string;
    productName: string;
    id: string;
    mediaId: string;
    kind: "image" | "video";
    objectKey: string;
    mediaAltText: string | null;
    contextualAltText: string | null;
    caption: string | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    posterMediaId: string | null;
    posterObjectKey: string | null;
    posterKind: "image" | "video" | null;
    posterStatus: "uploading" | "processing" | "ready" | "failed" | "deleting" | "trashed" | null;
    isPrimary: boolean;
    sortOrder: number;
    status: "uploading" | "processing" | "ready" | "failed" | "deleting" | "trashed";
}

export type ProductImageRepresentation = {
    productMediaId: string;
    mediaId: string;
    url: string;
    altText: string;
    source:
        | "featured-image"
        | "featured-video-poster"
        | "ordered-image"
        | "ordered-video-poster";
} | null;

export type SkuImageRepresentation = Exclude<ProductImageRepresentation, null> | {
    productMediaId: string;
    mediaId: string;
    url: string;
    altText: string;
    source: "exact-sku";
} | null;

function ordered(items: readonly ProductMediaProjection[]): ProductMediaProjection[] {
    return [...items].sort((left, right) =>
        left.sortOrder - right.sortOrder || left.id.localeCompare(right.id)
    );
}

/**
 * Resolves one image for image-only catalog surfaces. It deliberately never
 * manufactures a placeholder and never returns a video URL as an image.
 */
export function resolveProductImageRepresentation(
    items: readonly ProductMediaProjection[],
): ProductImageRepresentation {
    const gallery = ordered(items);
    if (gallery.length === 0) return null;
    const featured = gallery.find((item) => item.isPrimary) ?? gallery[0]!;

    if (featured.kind === "image" && featured.url) {
        return {
            productMediaId: featured.id,
            mediaId: featured.mediaId,
            url: featured.url,
            altText: featured.altText,
            source: "featured-image",
        };
    }
    if (featured.kind === "video" && featured.posterMediaId && featured.posterUrl) {
        return {
            productMediaId: featured.id,
            mediaId: featured.posterMediaId,
            url: featured.posterUrl,
            altText: featured.altText,
            source: "featured-video-poster",
        };
    }

    const firstImage = gallery.find((item) => item.kind === "image" && item.url);
    if (firstImage) {
        return {
            productMediaId: firstImage.id,
            mediaId: firstImage.mediaId,
            url: firstImage.url,
            altText: firstImage.altText,
            source: "ordered-image",
        };
    }

    const firstVideoWithPoster = gallery.find((item) =>
        item.kind === "video" && item.posterMediaId && item.posterUrl
    );
    if (!firstVideoWithPoster?.posterMediaId || !firstVideoWithPoster.posterUrl) return null;
    return {
        productMediaId: firstVideoWithPoster.id,
        mediaId: firstVideoWithPoster.posterMediaId,
        url: firstVideoWithPoster.posterUrl,
        altText: firstVideoWithPoster.altText,
        source: "ordered-video-poster",
    };
}

/** Exact SKU image wins; NULL or a missing/corrupt exact row uses the product image. */
export function resolveSkuImageRepresentation(
    items: readonly ProductMediaProjection[],
    imageId: string | null,
): SkuImageRepresentation {
    if (imageId) {
        const exact = items.find((item) => item.id === imageId && item.kind === "image");
        if (exact?.url) {
            return {
                productMediaId: exact.id,
                mediaId: exact.mediaId,
                url: exact.url,
                altText: exact.altText,
                source: "exact-sku",
            };
        }
    }
    return resolveProductImageRepresentation(items);
}

export function selectProductMediaProjectionRows(
    db: Database,
    productIds: readonly string[],
) {
    const uniqueIds = [...new Set(productIds.map((id) => id.trim()).filter(Boolean))];
    const productIdSet = JSON.stringify(uniqueIds);
    const poster = alias(media, "product_media_poster");
    return db
        .select({
            productId: productMedia.productId,
            productName: products.name,
            id: productMedia.id,
            mediaId: productMedia.mediaId,
            kind: media.kind,
            objectKey: media.objectKey,
            mediaAltText: media.altText,
            contextualAltText: sql<string | null>`${productMedia.altText}`
                .as("product_media_contextual_alt_text"),
            caption: media.caption,
            width: media.width,
            height: media.height,
            durationMs: media.durationMs,
            posterMediaId: sql<string | null>`${poster.id}`
                .as("product_media_poster_id"),
            posterObjectKey: sql<string | null>`${poster.objectKey}`
                .as("product_media_poster_object_key"),
            posterKind: sql<"image" | "video" | null>`${poster.kind}`
                .as("product_media_poster_kind"),
            posterStatus: sql<ProductMediaProjectionRow["posterStatus"]>`${poster.status}`
                .as("product_media_poster_status"),
            isPrimary: productMedia.isPrimary,
            sortOrder: productMedia.sortOrder,
            status: sql<ProductMediaProjectionRow["status"]>`${media.status}`
                .as("product_media_status"),
        })
        .from(productMedia)
        .innerJoin(products, eq(products.id, productMedia.productId))
        .innerJoin(media, eq(media.id, productMedia.mediaId))
        .leftJoin(poster, eq(poster.id, media.posterMediaId))
        .where(and(
            sql`${productMedia.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
            )`,
            inArray(media.status, ["ready", "trashed"]),
        ))
        .orderBy(asc(productMedia.productId), asc(productMedia.sortOrder), asc(productMedia.id));
}

/**
 * Checkout needs one exact SKU image plus the deterministic product fallback,
 * not every gallery association. These correlated candidates preserve the
 * shared resolver's precedence while bounding the result independently of a
 * merchant's gallery size.
 */
export function selectCheckoutProductMediaProjectionRows(
    db: Database,
    productIds: readonly string[],
    variantIds: readonly string[],
) {
    const uniqueProductIds = [...new Set(productIds.map((id) => id.trim()).filter(Boolean))];
    const uniqueVariantIds = [...new Set(variantIds.map((id) => id.trim()).filter(Boolean))];
    const productIdSet = JSON.stringify(uniqueProductIds);
    const variantIdSet = JSON.stringify(uniqueVariantIds);
    const poster = alias(media, "product_media_poster");
    return db
        .select({
            productId: productMedia.productId,
            productName: products.name,
            id: productMedia.id,
            mediaId: productMedia.mediaId,
            kind: media.kind,
            objectKey: media.objectKey,
            mediaAltText: media.altText,
            contextualAltText: sql<string | null>`${productMedia.altText}`
                .as("product_media_contextual_alt_text"),
            caption: media.caption,
            width: media.width,
            height: media.height,
            durationMs: media.durationMs,
            posterMediaId: sql<string | null>`${poster.id}`
                .as("product_media_poster_id"),
            posterObjectKey: sql<string | null>`${poster.objectKey}`
                .as("product_media_poster_object_key"),
            posterKind: sql<"image" | "video" | null>`${poster.kind}`
                .as("product_media_poster_kind"),
            posterStatus: sql<ProductMediaProjectionRow["posterStatus"]>`${poster.status}`
                .as("product_media_poster_status"),
            isPrimary: productMedia.isPrimary,
            sortOrder: productMedia.sortOrder,
            status: sql<ProductMediaProjectionRow["status"]>`${media.status}`
                .as("product_media_status"),
        })
        .from(productMedia)
        .innerJoin(products, eq(products.id, productMedia.productId))
        .innerJoin(media, eq(media.id, productMedia.mediaId))
        .leftJoin(poster, eq(poster.id, media.posterMediaId))
        .where(and(
            sql`${productMedia.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
            )`,
            inArray(media.status, ["ready", "trashed"]),
            sql`(
                ${productMedia.id} IN (
                    SELECT pv.image_id
                    FROM product_variants AS pv
                    WHERE pv.id IN (
                        SELECT CAST(value AS TEXT) FROM json_each(${variantIdSet})
                    )
                      AND pv.deleted_at IS NULL
                      AND pv.image_id IS NOT NULL
                )
                OR ${productMedia.isPrimary} = 1
                OR ${productMedia.id} = (
                    SELECT pm_first.id
                    FROM product_media AS pm_first
                    INNER JOIN media AS m_first ON m_first.id = pm_first.media_id
                    WHERE pm_first.product_id = ${productMedia.productId}
                      AND m_first.status IN ('ready', 'trashed')
                    ORDER BY pm_first.sort_order, pm_first.id
                    LIMIT 1
                )
                OR ${productMedia.id} = (
                    SELECT pm_image.id
                    FROM product_media AS pm_image
                    INNER JOIN media AS m_image ON m_image.id = pm_image.media_id
                    WHERE pm_image.product_id = ${productMedia.productId}
                      AND m_image.status IN ('ready', 'trashed')
                      AND m_image.kind = 'image'
                    ORDER BY pm_image.sort_order, pm_image.id
                    LIMIT 1
                )
                OR ${productMedia.id} = (
                    SELECT pm_video.id
                    FROM product_media AS pm_video
                    INNER JOIN media AS m_video ON m_video.id = pm_video.media_id
                    INNER JOIN media AS poster_video ON poster_video.id = m_video.poster_media_id
                    WHERE pm_video.product_id = ${productMedia.productId}
                      AND m_video.status IN ('ready', 'trashed')
                      AND m_video.kind = 'video'
                      AND poster_video.kind = 'image'
                      AND poster_video.status IN ('ready', 'trashed')
                    ORDER BY pm_video.sort_order, pm_video.id
                    LIMIT 1
                )
            )`,
        ))
        .orderBy(asc(productMedia.productId), asc(productMedia.sortOrder), asc(productMedia.id));
}

export function resolveProductMediaProjectionRows(
    rows: readonly ProductMediaProjectionRow[],
): Map<string, ProductMediaProjection[]> {
    const result = new Map<string, ProductMediaProjection[]>();
    for (const row of rows) {
        const posterIsUsable = row.posterMediaId
            && row.posterKind === "image"
            && (row.posterStatus === "ready" || row.posterStatus === "trashed")
            && row.posterObjectKey;
        const projection: ProductMediaProjection = {
            id: row.id,
            mediaId: row.mediaId,
            kind: row.kind,
            url: getCurrentPublicMediaUrl(row.objectKey),
            posterMediaId: posterIsUsable ? row.posterMediaId : null,
            posterUrl: posterIsUsable
                ? getCurrentPublicMediaUrl(row.posterObjectKey!)
                : null,
            contextualAltText: row.contextualAltText,
            altText: row.contextualAltText ?? row.mediaAltText ?? row.productName,
            caption: row.caption,
            width: row.width,
            height: row.height,
            durationMs: row.durationMs,
            isPrimary: row.isPrimary,
            sortOrder: row.sortOrder,
            status: row.status as "ready" | "trashed",
        };
        const current = result.get(row.productId) ?? [];
        current.push(projection);
        result.set(row.productId, current);
    }
    return result;
}

/**
 * Loads ordered product associations and poster assets in bounded sequential
 * waves. Existing ready or trashed references remain usable; deleting/deleted
 * assets are excluded from buyer/admin projections.
 */
export async function loadProductMediaProjections(
    db: Database,
    productIds: readonly string[],
): Promise<Map<string, ProductMediaProjection[]>> {
    const uniqueIds = [...new Set(productIds.map((id) => id.trim()).filter(Boolean))];
    const result = new Map<string, ProductMediaProjection[]>();

    for (let index = 0; index < uniqueIds.length; index += PRODUCT_MEDIA_QUERY_CHUNK) {
        const chunk = uniqueIds.slice(index, index + PRODUCT_MEDIA_QUERY_CHUNK);
        const chunkResult = resolveProductMediaProjectionRows(
            await selectProductMediaProjectionRows(db, chunk) as ProductMediaProjectionRow[],
        );
        for (const [productId, projections] of chunkResult) {
            result.set(productId, [...(result.get(productId) ?? []), ...projections]);
        }
    }
    return result;
}
