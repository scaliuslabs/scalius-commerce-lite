// What the homepage sections read besides product lists, each planned as
// one statement of the homepage's second D1 batch (storefront.service.ts):
// section images by media id and the deal countdowns' promotions.
// Product lists and the brand wall are catalog reads
// (catalog/home-lists.ts and catalog/home-brands.ts).
import { media, promotions } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { safeBatch } from "@scalius/database/client";
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { homeSectionRequests, type StorefrontSection } from "@scalius/shared/storefront-theme";
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

/** A running promotion's real end, for a deal countdown. */
export interface HomePromotionEnd {
    id: string;
    endsAt: string;
}

function epochSeconds(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * One statement for the deal countdowns: the named promotions that are
 * active, live, started and not yet ended, with their stored end time. A
 * promotion without an end, paused, archived or over gives no countdown.
 */
export function planHomePromotions(db: Database, ids: readonly string[], now = Date.now()): {
    statements: BatchStatement[];
    resolve(results: readonly unknown[], offset: number): HomePromotionEnd[];
} {
    if (ids.length === 0) return { statements: [], resolve: () => [] };
    deps.promotions(ids);
    const statement = db
        .select({ id: promotions.id, startsAt: promotions.startsAt, endsAt: promotions.endsAt })
        .from(promotions)
        .where(and(
            inArray(promotions.id, [...ids]),
            eq(promotions.status, "active"),
            isNull(promotions.deletedAt),
            isNotNull(promotions.endsAt),
        ));
    const nowSeconds = Math.floor(now / 1000);
    return {
        statements: [statement],
        resolve(results, offset) {
            return (results[offset] as Array<{ id: string; startsAt: unknown; endsAt: unknown }>).flatMap((row) => {
                const starts = epochSeconds(row.startsAt);
                const ends = epochSeconds(row.endsAt);
                if (ends === null || ends <= nowSeconds) return [];
                // The countdown appears when the promotion starts and goes when it ends.
                if (starts !== null && starts > nowSeconds) {
                    deps.validUntil(starts * 1000);
                    return [];
                }
                deps.validUntil(ends * 1000);
                return [{ id: row.id, endsAt: new Date(ends * 1000).toISOString() }];
            });
        },
    };
}

/**
 * The images a theme's homepage sections name, for the dashboard's section
 * editor previews (the same capped id set and rules the storefront reads).
 */
export async function readHomeSectionMedia(db: Database, sections: readonly StorefrontSection[]): Promise<HomeMediaAsset[]> {
    const plan = planHomeMedia(db, homeSectionRequests(sections).mediaIds);
    const [statement] = plan.statements;
    if (!statement) return [];
    return plan.resolve([await statement], 0);
}
