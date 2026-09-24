// Homepage section images (banners, lookbook and editorial photos, hero
// side banners) by media id, planned as one statement of the homepage's
// second D1 batch (storefront.service.ts). The product lists are catalog
// reads (catalog/home-lists.ts).
import { media } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { safeBatch } from "@scalius/database/client";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { getCurrentMediaUrl } from "../../integrations/storage";

type BatchStatement = Parameters<typeof safeBatch>[1][number];

export interface HomeMediaAsset {
    id: string;
    url: string;
    alt: string;
    width: number | null;
    height: number | null;
}

/** One statement for the section images: ready (or trashed) images only, never videos. */
export function planHomeMedia(db: Database, mediaIds: readonly string[]): {
    statements: BatchStatement[];
    resolve(results: readonly unknown[], offset: number): HomeMediaAsset[];
} {
    if (mediaIds.length === 0) return { statements: [], resolve: () => [] };
    const statement = db.select({
        id: media.id,
        objectKey: media.objectKey,
        variantWidth: media.variantWidth,
        altText: media.altText,
        width: media.width,
        height: media.height,
    }).from(media).where(and(
        sql`${media.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(mediaIds)}))`,
        eq(media.kind, "image"),
        // Ready or trashed (a trashed image keeps serving where it is used),
        // as NOT IN so the id set drives the lookup (products/media.ts).
        notInArray(media.status, ["deleting", "deleted"]),
    ));
    return {
        statements: [statement],
        resolve(results, offset) {
            const rows = results[offset] as Array<{
                id: string;
                objectKey: string;
                variantWidth: number | null;
                altText: string | null;
                width: number | null;
                height: number | null;
            }>;
            const byId = new Map(rows.map((row) => [row.id, row]));
            return mediaIds.flatMap((id) => {
                const row = byId.get(id);
                return row ? [{
                    id: row.id,
                    url: getCurrentMediaUrl(row.objectKey, row.variantWidth),
                    alt: row.altText?.trim() ?? "",
                    width: row.width,
                    height: row.height,
                }] : [];
            });
        },
    };
}
