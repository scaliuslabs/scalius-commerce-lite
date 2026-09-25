// Homepage section images (banners, lookbook and editorial photos, hero
// side banners) by media id, planned as one statement of the homepage's
// second D1 batch (storefront.service.ts). The product lists are catalog
// reads (catalog/home-lists.ts).
import { media } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { safeBatch } from "@scalius/database/client";
import { and, notInArray, sql } from "drizzle-orm";
import { getCurrentMediaUrl } from "../../integrations/storage";
import { deps } from "../../cache-deps";

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
    deps.mediaItems(mediaIds);
    // Only the id set is an indexable condition: with `kind = 'image'` in the
    // WHERE, SQLite drives the lookup from the kind index and reads every
    // image in the library (75k rows at 30k products). Kind is checked on the
    // few rows found instead; status is NOT IN for the same reason.
    const statement = db.select({
        id: media.id,
        kind: media.kind,
        objectKey: media.objectKey,
        variantWidth: media.variantWidth,
        altText: media.altText,
        width: media.width,
        height: media.height,
    }).from(media).where(and(
        sql`${media.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(mediaIds)}))`,
        // Ready or trashed: a trashed image keeps serving where it is used.
        notInArray(media.status, ["deleting", "deleted"]),
    ));
    return {
        statements: [statement],
        resolve(results, offset) {
            const rows = (results[offset] as Array<{
                id: string;
                kind: string;
                objectKey: string;
                variantWidth: number | null;
                altText: string | null;
                width: number | null;
                height: number | null;
            }>).filter((row) => row.kind === "image");
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
