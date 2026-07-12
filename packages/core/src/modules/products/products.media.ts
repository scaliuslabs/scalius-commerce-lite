import { media, productMedia, products } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { getCurrentPublicMediaUrl } from "../../integrations/storage";
import { and, asc, eq, inArray } from "drizzle-orm";
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
    const poster = alias(media, "product_media_poster");

    for (let index = 0; index < uniqueIds.length; index += PRODUCT_MEDIA_QUERY_CHUNK) {
        const chunk = uniqueIds.slice(index, index + PRODUCT_MEDIA_QUERY_CHUNK);
        const rows = await db
            .select({
                productId: productMedia.productId,
                productName: products.name,
                id: productMedia.id,
                mediaId: productMedia.mediaId,
                kind: media.kind,
                objectKey: media.objectKey,
                mediaAltText: media.altText,
                contextualAltText: productMedia.altText,
                caption: media.caption,
                width: media.width,
                height: media.height,
                durationMs: media.durationMs,
                posterMediaId: poster.id,
                posterObjectKey: poster.objectKey,
                posterKind: poster.kind,
                posterStatus: poster.status,
                isPrimary: productMedia.isPrimary,
                sortOrder: productMedia.sortOrder,
                status: media.status,
            })
            .from(productMedia)
            .innerJoin(products, eq(products.id, productMedia.productId))
            .innerJoin(media, eq(media.id, productMedia.mediaId))
            .leftJoin(poster, eq(poster.id, media.posterMediaId))
            .where(and(
                inArray(productMedia.productId, chunk),
                inArray(media.status, ["ready", "trashed"]),
            ))
            .orderBy(asc(productMedia.productId), asc(productMedia.sortOrder), asc(productMedia.id));

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
    }
    return result;
}
