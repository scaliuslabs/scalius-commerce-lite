// What the homepage sections read besides product lists, each planned as
// one statement of the homepage's second D1 batch (storefront.service.ts):
// section images by media id (hero slides included) and the deal
// countdowns' promotions; and the theme's brand images, which the layout
// batch reads through the published theme row.
// Product lists and the brand wall are catalog reads
// (catalog/home-lists.ts and catalog/home-brands.ts).
import { media, promotions, themeSettings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { safeBatch } from "@scalius/database/client";
import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import {
  EMPTY_STOREFRONT_BRAND_ASSETS,
  storefrontBrandAssets,
  storefrontThemeBrandMediaIds,
  storefrontThemeMediaIds,
  type StorefrontBrandAssets,
  type StorefrontThemeBrand,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
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

interface HomeMediaRow {
    id: string;
    kind: string;
    objectKey: string;
    variantWidth: number | null;
    altText: string | null;
    width: number | null;
    height: number | null;
}

const homeMediaColumns = {
    id: media.id,
    kind: media.kind,
    objectKey: media.objectKey,
    variantWidth: media.variantWidth,
    altText: media.altText,
    width: media.width,
    height: media.height,
};

/** Images only (never a video), at their published rendition's URL. */
function homeMediaAssets(rows: readonly HomeMediaRow[]): HomeMediaAsset[] {
    return rows.filter((row) => row.kind === "image").map((row) => ({
        id: row.id,
        url: getCurrentMediaUrl(row.objectKey, row.variantWidth),
        alt: row.altText?.trim() ?? "",
        width: row.width,
        height: row.height,
    }));
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
    const statement = db.select(homeMediaColumns).from(media).where(and(
        sql`${media.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(mediaIds)}))`,
        // Ready or trashed: a trashed image keeps serving where it is used.
        notInArray(media.status, ["deleting", "deleted"]),
    ));
    return {
        statements: [statement],
        resolve(results, offset) {
            const byId = new Map(homeMediaAssets(results[offset] as HomeMediaRow[]).map((asset) => [asset.id, asset]));
            return mediaIds.flatMap((id) => byId.get(id) ?? []);
        },
    };
}

const BRAND_MEDIA_PATHS = ["$.brand.logo", "$.brand.footerLogo", "$.brand.favicon"] as const;
/** Media ids are generated (`media_...`); this one names no row. */
const NO_BRAND_MEDIA_ID = "none";

/** The brand media ids a stored theme row names, read leniently for the read's dependencies. */
function storedBrandMediaIds(value: string | null | undefined): string[] {
    try {
        const brand = (JSON.parse(value ?? "null") as { brand?: Record<string, unknown> } | null)?.brand ?? {};
        return [...new Set(["logo", "footerLogo", "favicon"].map((key) => brand[key]).filter((id): id is string => typeof id === "string" && id !== ""))];
    } catch {
        return [];
    }
}

/**
 * One statement for the published theme's brand images (logo, footer logo,
 * tab icon), joined in the layout batch through the stored theme row, so the
 * layout needs no second round trip. `resolve` takes the stored row and the
 * document the layout renders (the default when the row is unreadable).
 */
export function planPublishedThemeBrandMedia(db: Database) {
    const brandIds = sql.join(BRAND_MEDIA_PATHS.map((path) => sql`
        SELECT json_extract(${themeSettings.colors}, ${path}) FROM ${themeSettings} WHERE ${themeSettings.id} = 'default'`), sql` UNION ALL `);
    const statement = db.select(homeMediaColumns).from(media).where(and(
        sql`${media.id} IN (${brandIds})`,
        notInArray(media.status, ["deleting", "deleted"]),
    ));
    return {
        statement,
        resolve(rows: unknown, storedTheme: string | null | undefined, brand: StorefrontThemeBrand): StorefrontBrandAssets {
            // Every id the stored row names: its m:<id> advances when the image
            // changes, so the layout follows a new rendition or a deletion. A
            // row that names none matched no media row, and the theme key
            // already covers that: `m:none` (no media row has that id, so it
            // never advances) records the read as covered, not coarse.
            const ids = storedBrandMediaIds(storedTheme);
            deps.mediaItems(ids.length > 0 ? ids : [NO_BRAND_MEDIA_ID]);
            return storefrontBrandAssets(brand, homeMediaAssets(rows as HomeMediaRow[]));
        },
    };
}

/** A theme's brand images (a preview's draft), in one read. */
export async function readThemeBrandAssets(db: Database, brand: StorefrontThemeBrand): Promise<StorefrontBrandAssets> {
    const ids = storefrontThemeBrandMediaIds(brand);
    if (ids.length === 0) return EMPTY_STOREFRONT_BRAND_ASSETS;
    const plan = planHomeMedia(db, ids);
    return storefrontBrandAssets(brand, plan.resolve([await plan.statements[0]!], 0));
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
 * promotion without an end, paused, archived or over gives no countdown,
 * and neither does one limited to customer segments (whether it applies
 * depends on who is signed in; its links advance the `promo:` keys).
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
            sql`NOT EXISTS (SELECT 1 FROM promotion_customer_segments AS segment_limit WHERE segment_limit.promotion_id = "promotions"."id")`,
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
 * Every image a theme names (brand, hero slides, section photos), for the
 * dashboard's previews (the same rules the storefront reads, uncapped).
 * `appMediaIds` adds the images its apps' settings name (only each app's
 * own schema says which values are images).
 */
export async function readThemeMedia(db: Database, theme: StorefrontThemeDocument, appMediaIds: readonly string[] = []): Promise<HomeMediaAsset[]> {
    const plan = planHomeMedia(db, [...new Set([...storefrontThemeMediaIds(theme), ...appMediaIds])]);
    const [statement] = plan.statements;
    if (!statement) return [];
    return plan.resolve([await statement], 0);
}
