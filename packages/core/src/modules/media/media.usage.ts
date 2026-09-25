import {
    brands,
    categories,
    collections,
    heroSliders,
    media,
    orderItems,
    pages,
    productMedia,
    productRichContent,
    products,
    settings,
    user,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { businessDocument, footerDocument, headerDocument, seoDocument } from "../settings/documents";
import { SETTINGS_DOCUMENT_ROW_KEY } from "../settings/settings-store";

/**
 * Where a file is used. Every place that can hold a media reference is listed
 * here once; the Files list count, the file's "Used in" panel and the
 * permanent-delete guard all read the same sources.
 */
export const MEDIA_USAGE_KINDS = [
    "product",
    "category",
    "collection",
    "brand",
    "page",
    "article",
    "banner",
    "theme",
    "navigation",
    "invoice",
    "social_image",
    "video_cover",
    "staff_photo",
] as const;
export type MediaUsageKind = (typeof MEDIA_USAGE_KINDS)[number];

export type MediaUsageReference = {
    kind: MediaUsageKind;
    /** The owning record (product, category, …); null for store-wide surfaces. */
    id: string | null;
    name: string | null;
    /** The owning record is in its trash; restoring it brings the file back. */
    trashed: boolean;
};

export type MediaUsage = {
    /** Distinct places that show the file. */
    count: number;
    /** Up to MEDIA_USAGE_REFERENCE_LIMIT places, products first. */
    references: MediaUsageReference[];
    /** Past order lines that keep this picture; they are never deleted. */
    orderCount: number;
};

export const MEDIA_USAGE_REFERENCE_LIMIT = 50;
const MAX_USAGE_IDS = 100;
/** D1 rejects a compound SELECT with more than five terms. */
const D1_COMPOUND_SELECT_TERMS = 5;

const headerKey = headerDocument.key;
const footerKey = footerDocument.key;
const hasMediaUrl = (body: SQL) => sql`instr(${body}, 'media/') > 0`;
const trashedFlag = (column: SQLWrapper) => sql`CASE WHEN ${column} IS NULL THEN 0 ELSE 1 END`;
const jsonPart = (path: string) => sql`coalesce(json_extract(${settings.value}, ${path}), '')`;
const documentRows = (...categories: string[]) => sql`${settings.key} = ${SETTINGS_DOCUMENT_ROW_KEY}
    AND ${settings.category} IN (${sql.join(categories.map((category) => sql`${category}`), sql`, `)})
    AND ${hasMediaUrl(sql`${settings.value}`)}`;

/**
 * Every free-text surface that can embed a media URL, each one SELECT of
 * (kind, ref_id, name, trashed, body), aliased so any of them can lead a
 * group. Rows without any media URL are skipped before the per-file
 * substring match. Header/footer documents only keep
 * their allowed keys, so logo+favicon (theme) and the rest (navigation) cover
 * the whole document.
 */
function textReferenceSources(): SQL[] {
    const categoryBody = sql`coalesce(${categories.imageUrl}, '') || ' ' || coalesce(${categories.content}, '')`;
    const collectionBody = sql`coalesce(${collections.content}, '')`;
    const pageBody = sql`coalesce(${pages.featuredImage}, '') || ' ' || ${pages.content}`;
    const productBody = sql`coalesce(${products.description}, '')`;
    const headerTheme = sql`${jsonPart("$.logo")} || ' ' || ${jsonPart("$.favicon")}`;
    const headerNavigation = sql`${jsonPart("$.topBar")} || ' ' || ${jsonPart("$.contact")} || ' ' || ${jsonPart("$.social")}`;
    const footerTheme = jsonPart("$.logo");
    const footerNavigation = sql`${jsonPart("$.tagline")} || ' ' || ${jsonPart("$.description")} || ' ' || ${jsonPart("$.copyrightText")} || ' ' || ${jsonPart("$.social")}`;
    const userImage = sql`coalesce(${user.image}, '')`;
    return [
        sql`SELECT 'product' AS kind, ${products.id} AS ref_id, ${products.name} AS name,
                ${trashedFlag(products.deletedAt)} AS trashed, ${productBody} AS body
            FROM ${products} WHERE ${hasMediaUrl(productBody)}`,
        sql`SELECT 'product' AS kind, ${products.id} AS ref_id, ${products.name} AS name, ${trashedFlag(products.deletedAt)} AS trashed, ${productRichContent.content} AS body
            FROM ${productRichContent} INNER JOIN ${products} ON ${products.id} = ${productRichContent.productId}
            WHERE ${hasMediaUrl(sql`${productRichContent.content}`)}`,
        sql`SELECT 'category' AS kind, ${categories.id} AS ref_id, ${categories.name} AS name, ${trashedFlag(categories.deletedAt)} AS trashed, ${categoryBody} AS body
            FROM ${categories} WHERE ${hasMediaUrl(categoryBody)}`,
        sql`SELECT 'collection' AS kind, ${collections.id} AS ref_id, ${collections.name} AS name, ${trashedFlag(collections.deletedAt)} AS trashed, ${collectionBody} AS body
            FROM ${collections} WHERE ${hasMediaUrl(collectionBody)}`,
        sql`SELECT CASE WHEN ${pages.contentType} = 'article' THEN 'article' ELSE 'page' END AS kind,
                ${pages.id} AS ref_id, ${pages.title} AS name, ${trashedFlag(pages.deletedAt)} AS trashed, ${pageBody} AS body
            FROM ${pages} WHERE ${hasMediaUrl(pageBody)}`,
        sql`SELECT 'banner' AS kind, '' AS ref_id, NULL AS name, 0 AS trashed, ${heroSliders.images} AS body
            FROM ${heroSliders} WHERE ${hasMediaUrl(sql`${heroSliders.images}`)}`,
        sql`SELECT 'theme' AS kind, '' AS ref_id, NULL AS name, 0 AS trashed,
                CASE WHEN ${settings.category} = ${headerKey} THEN ${headerTheme} ELSE ${footerTheme} END AS body
            FROM ${settings} WHERE ${documentRows(headerKey, footerKey)}`,
        sql`SELECT 'navigation' AS kind, '' AS ref_id, NULL AS name, 0 AS trashed,
                CASE WHEN ${settings.category} = ${headerKey} THEN ${headerNavigation} ELSE ${footerNavigation} END AS body
            FROM ${settings} WHERE ${documentRows(headerKey, footerKey)}`,
        sql`SELECT 'invoice' AS kind, '' AS ref_id, NULL AS name, 0 AS trashed, ${settings.value} AS body
            FROM ${settings} WHERE ${documentRows(businessDocument.key)}`,
        sql`SELECT 'social_image' AS kind, '' AS ref_id, NULL AS name, 0 AS trashed, ${jsonPart("$.socialImage")} AS body
            FROM ${settings} WHERE ${documentRows(seoDocument.key)}`,
        sql`SELECT 'staff_photo' AS kind, ${user.id} AS ref_id, ${user.name} AS name, 0 AS trashed, ${userImage} AS body
            FROM ${user} WHERE ${hasMediaUrl(userImage)}`,
    ];
}

/** The text sources as compound SELECTs D1 accepts (at most five terms each). */
function textReferenceGroups(): SQL[] {
    const sources = textReferenceSources();
    const groups: SQL[] = [];
    for (let index = 0; index < sources.length; index += D1_COMPOUND_SELECT_TERMS) {
        groups.push(sql.join(sources.slice(index, index + D1_COMPOUND_SELECT_TERMS), sql` UNION ALL `));
    }
    return groups;
}

const idSet = (ids: readonly string[]) =>
    sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;

type UsageRow = { media_id: string; kind: MediaUsageKind; ref_id: string; name: string | null; trashed: number };

/**
 * (media_id, kind, ref_id, name, trashed) for every place that shows the
 * requested files: product photos, video covers and brand logos by id, then each group of
 * text surfaces by object-key substring. Sequential, bounded reads.
 */
async function loadUsageRows(db: Database, ids: readonly string[]): Promise<UsageRow[]> {
    const rows = await db.all<UsageRow>(sql`
        SELECT ${productMedia.mediaId} AS media_id, 'product' AS kind, ${products.id} AS ref_id,
               ${products.name} AS name, ${trashedFlag(products.deletedAt)} AS trashed
        FROM ${productMedia} INNER JOIN ${products} ON ${products.id} = ${productMedia.productId}
        WHERE ${productMedia.mediaId} IN ${idSet(ids)}
        UNION ALL
        SELECT video.poster_media_id, 'video_cover', video.id, video.filename,
               CASE WHEN video.status = 'ready' THEN 0 ELSE 1 END
        FROM ${media} AS video
        WHERE video.status <> 'deleted' AND video.poster_media_id IN ${idSet(ids)}
        UNION ALL
        SELECT ${brands.logoMediaId}, 'brand', ${brands.id}, ${brands.name}, ${trashedFlag(brands.deletedAt)}
        FROM ${brands}
        WHERE ${brands.logoMediaId} IN ${idSet(ids)}`);
    for (const group of textReferenceGroups()) {
        rows.push(...await db.all<UsageRow>(sql`
            SELECT k.id AS media_id, t.kind AS kind, t.ref_id AS ref_id, t.name AS name, t.trashed AS trashed
            FROM ${media} AS k
            INNER JOIN (${group}) AS t ON instr(t.body, k.object_key) > 0
            WHERE k.id IN ${idSet(ids)}`));
    }
    return rows;
}

/** One entry per place: a product using the file as a photo and in its description is one place. */
function distinctPlaces(rows: readonly UsageRow[]): Map<string, MediaUsageReference & { mediaId: string }> {
    const places = new Map<string, MediaUsageReference & { mediaId: string }>();
    for (const row of rows) {
        const key = `${row.media_id}\u0000${row.kind}\u0000${row.ref_id}`;
        const trashed = Boolean(Number(row.trashed));
        const existing = places.get(key);
        if (existing) {
            existing.trashed ||= trashed;
            continue;
        }
        places.set(key, { mediaId: row.media_id, kind: row.kind, id: row.ref_id || null, name: row.name, trashed });
    }
    return places;
}

function boundedIds(ids: readonly string[]): string[] {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length > MAX_USAGE_IDS) throw new Error(`Media usage reads at most ${MAX_USAGE_IDS} files.`);
    return unique;
}

/** Per-file place counts and order-snapshot flags for one Files page (≤100 ids). */
export async function countMediaUsage(
    db: Database,
    ids: readonly string[],
): Promise<Map<string, { usageCount: number; keptForOrders: boolean }>> {
    const unique = boundedIds(ids);
    const result = new Map(unique.map((id) => [id, { usageCount: 0, keptForOrders: false }]));
    if (!unique.length) return result;
    for (const place of distinctPlaces(await loadUsageRows(db, unique)).values()) {
        const entry = result.get(place.mediaId);
        if (entry) entry.usageCount += 1;
    }
    const ordered = await db.all<{ media_id: string }>(sql`
        SELECT DISTINCT ${orderItems.productImageMediaId} AS media_id FROM ${orderItems}
        WHERE ${orderItems.productImageMediaId} IN ${idSet(unique)}`);
    for (const row of ordered) {
        const entry = result.get(row.media_id);
        if (entry) entry.keptForOrders = true;
    }
    return result;
}

const KIND_ORDER = new Map<MediaUsageKind, number>(MEDIA_USAGE_KINDS.map((kind, index) => [kind, index]));

/** Where one file is used: distinct places (bounded list) and past order lines. */
export async function loadMediaUsage(db: Database, id: string): Promise<MediaUsage> {
    const places = [...distinctPlaces(await loadUsageRows(db, [id])).values()]
        .map(({ mediaId: _mediaId, ...place }) => place)
        .sort((left, right) =>
            KIND_ORDER.get(left.kind)! - KIND_ORDER.get(right.kind)!
            || (left.name ?? "").localeCompare(right.name ?? "")
            || (left.id ?? "").localeCompare(right.id ?? ""));
    const orders = await db.all<{ total: number }>(sql`
        SELECT count(*) AS total FROM ${orderItems} WHERE ${orderItems.productImageMediaId} = ${id}`);
    return {
        count: places.length,
        references: places.slice(0, MEDIA_USAGE_REFERENCE_LIMIT),
        orderCount: Number(orders[0]?.total ?? 0),
    };
}

/**
 * Atomic guard for the permanent-delete claim: no product photo, video cover,
 * brand logo, order snapshot or saved text surface may still point at the file.
 */
export function noMediaUsage(id: string, objectKey: string): SQL {
    const textGuards = textReferenceGroups().map((group) => sql`NOT EXISTS (
        SELECT 1 FROM (${group}) AS t WHERE instr(t.body, ${objectKey}) > 0
    )`);
    return sql`NOT EXISTS (
        SELECT 1 FROM ${productMedia} WHERE ${productMedia.mediaId} = ${id}
    ) AND NOT EXISTS (
        SELECT 1 FROM ${media} AS video WHERE video.poster_media_id = ${id} AND video.status <> 'deleted'
    ) AND NOT EXISTS (
        SELECT 1 FROM ${orderItems} WHERE ${orderItems.productImageMediaId} = ${id}
    ) AND NOT EXISTS (
        SELECT 1 FROM ${brands} WHERE ${brands.logoMediaId} = ${id}
    ) AND ${sql.join(textGuards, sql` AND `)}`;
}
