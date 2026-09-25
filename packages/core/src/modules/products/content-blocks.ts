// Product content blocks (0090 `product_content_blocks`): the typed blocks of a
// product page, edited as their own section under the product aggregate
// revision, and the ordered read the product page renders from.
//
// Until the contract step (after the dashboard edits blocks, slice 1d) the
// product's legacy tabs still live in `product_rich_content`: the admin
// `additionalInfo` field and the `additional_info` section write that table
// and 0090's triggers mirror each row into a `rich-text` block in the `tabs`
// placement with the id `pcb_<row id>`. Those mirrored blocks are read-only
// here (`legacy: true`): a replace keeps them as they are and refuses to name
// them, so the two writers never fight over one row.
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { buildBatchGuard, type Database } from "@scalius/database/client";
import { media, productContentBlocks, productRichContent, products } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { sanitizeHtml } from "@scalius/shared/html-sanitize";
import {
    PRODUCT_CONTENT_BLOCK_ID_PREFIX,
    PRODUCT_CONTENT_BLOCK_PLACEMENTS,
    PRODUCT_CONTENT_BLOCK_SETTINGS_MAX_LENGTH,
    PRODUCT_CONTENT_BLOCKS_MAX,
    isProductContentBlockPlacementAllowed,
    isProductContentBlockType,
    parseProductContentBlock,
    parseStoredProductContentBlock,
    type ProductContentBlockPlacement,
    type ProductContentBlockValue,
} from "@scalius/shared/product-content-blocks";
import { getCurrentMediaUrl } from "../../integrations/storage";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** Settings JSON text per chunk of the single-block read (the text sections' size). */
export const PRODUCT_CONTENT_BLOCK_TEXT_CHUNK_MAX = 12_000;
/** A block's settings (characters) the block list may inline; larger ones are read by chunk. */
export const PRODUCT_CONTENT_BLOCK_LIST_INLINE_MAX = 4_000;
/** UTF-8 bytes of settings one page of the block list inlines in total. */
export const PRODUCT_CONTENT_BLOCK_LIST_INLINE_BYTES = 36_000;
/** Distinct media one product's blocks may reference. */
export const PRODUCT_CONTENT_BLOCK_MEDIA_MAX = 90;
/** Batch guard marker: a file the blocks name stopped being ready before the write committed. */
export const PRODUCT_CONTENT_BLOCK_MEDIA_GUARD = "PRODUCT_CONTENT_BLOCK_MEDIA_UNAVAILABLE";
export const PRODUCT_CONTENT_BLOCK_MEDIA_UNAVAILABLE_MESSAGE =
    "Some files in these blocks are missing or in trash. Choose them again.";

export const productContentBlockIdSchema = z.string().trim().min(8).max(120)
    .regex(/^pcb_[A-Za-z0-9_-]+$/u, "Content block id is invalid.");
const placementSchema = z.enum(PRODUCT_CONTENT_BLOCK_PLACEMENTS);

/**
 * One entry of a replace, in page order within its placement: an existing
 * block kept as stored (moved or reordered without resending its settings),
 * or a block with settings (new without `id`, overwritten with it).
 */
export const productContentBlockInputSchema = z.union([
    z.object({
        id: productContentBlockIdSchema,
        placement: placementSchema,
        keep: z.literal(true),
    }).strict(),
    z.object({
        id: productContentBlockIdSchema.optional(),
        placement: placementSchema,
        type: z.string().trim().min(1).max(40),
        version: z.number().int().min(1),
        settings: z.record(z.string(), z.unknown()),
    }).strict(),
]);
export type ProductContentBlockInput = z.infer<typeof productContentBlockInputSchema>;

export const productContentBlockInputListSchema = z.array(productContentBlockInputSchema)
    .max(PRODUCT_CONTENT_BLOCKS_MAX);

type StoredBlockRow = {
    id: string;
    placement: ProductContentBlockPlacement;
    position: number;
    type: string;
    version: number;
    legacy: number;
};

// Correlated subqueries name their columns in full: a single-table select
// renders column references unqualified, which the subquery would resolve
// against its own table.
const BLOCK_PRODUCT_ID = sql.raw(`"product_content_blocks"."product_id"`);
const BLOCK_ID = sql.raw(`"product_content_blocks"."id"`);
const LEGACY_ROW_MATCH = sql`"legacy_tab"."product_id" = ${BLOCK_PRODUCT_ID}
      AND ${sql.raw(`'${PRODUCT_CONTENT_BLOCK_ID_PREFIX}'`)} || "legacy_tab"."id" = ${BLOCK_ID}`;

/** A mirrored legacy tab: `pcb_` + the id of a `product_rich_content` row of the same product. */
const legacyTabSql = sql<number>`CASE WHEN EXISTS (
    SELECT 1 FROM ${productRichContent} AS "legacy_tab" WHERE ${LEGACY_ROW_MATCH}
) THEN 1 ELSE 0 END`;

function blockOrder() {
    return [asc(productContentBlocks.placement), asc(productContentBlocks.position), asc(productContentBlocks.id)] as const;
}

// ─────────────────────────────────────────
// Editor reads
// ─────────────────────────────────────────

/**
 * One page of the product's blocks in page order, settings inline while the
 * page stays small; a block whose settings are not inlined (`settings: null`)
 * is read with {@link readProductContentBlockChunk}.
 */
export async function readProductContentBlockSection(
    db: Database,
    productId: string,
    page: { offset: number; limit: number },
) {
    const limit = Math.min(page.limit, PRODUCT_CONTENT_BLOCKS_MAX);
    const [header, rows] = await Promise.all([
        db.select({
            aggregateRevision: products.aggregateRevision,
            total: sql<number>`(SELECT count(*) FROM ${productContentBlocks} WHERE ${BLOCK_PRODUCT_ID} = ${sql.raw(`"products"."id"`)})`,
        }).from(products).where(eq(products.id, productId)).get(),
        db.select({
            id: productContentBlocks.id,
            placement: productContentBlocks.placement,
            position: productContentBlocks.position,
            type: productContentBlocks.type,
            version: productContentBlocks.version,
            legacy: legacyTabSql,
            settingsCharacters: sql<number>`length(${productContentBlocks.settings})`,
            // Only settings that fit the inline budget leave the database.
            settings: sql<string | null>`CASE WHEN length(${productContentBlocks.settings}) <= ${PRODUCT_CONTENT_BLOCK_LIST_INLINE_MAX} THEN ${productContentBlocks.settings} END`,
        }).from(productContentBlocks).where(eq(productContentBlocks.productId, productId))
            .orderBy(...blockOrder()).limit(limit).offset(page.offset).all(),
    ]);
    if (!header) return null;
    const encoder = new TextEncoder();
    let inlineBudget = PRODUCT_CONTENT_BLOCK_LIST_INLINE_BYTES;
    const items = rows.map((row) => {
        const settingsCharacters = Number(row.settingsCharacters);
        let settings: Record<string, unknown> | null = null;
        const bytes = row.settings === null ? Infinity : encoder.encode(row.settings).byteLength;
        if (row.settings !== null && bytes <= inlineBudget) {
            try {
                settings = JSON.parse(row.settings) as Record<string, unknown>;
                inlineBudget -= bytes;
            } catch {
                settings = null;
            }
        }
        return {
            id: row.id,
            placement: row.placement,
            position: row.position,
            type: row.type,
            version: row.version,
            legacy: Number(row.legacy) === 1,
            settingsCharacters,
            settings,
        };
    });
    const total = Number(header.total);
    const nextOffset = page.offset + items.length < total ? page.offset + items.length : null;
    return {
        section: "content_blocks" as const,
        aggregateRevision: header.aggregateRevision,
        items,
        total,
        offset: page.offset,
        limit,
        nextOffset,
    };
}

/** One block's settings JSON text, from `offset`, in bounded chunks. */
export async function readProductContentBlockChunk(
    db: Database,
    productId: string,
    blockId: string,
    offset: number,
) {
    const row = await db.select({
        aggregateRevision: products.aggregateRevision,
        id: productContentBlocks.id,
        placement: productContentBlocks.placement,
        position: productContentBlocks.position,
        type: productContentBlocks.type,
        version: productContentBlocks.version,
        legacy: legacyTabSql,
        value: sql<string>`substr(${productContentBlocks.settings}, ${offset + 1}, ${PRODUCT_CONTENT_BLOCK_TEXT_CHUNK_MAX})`,
        totalCharacters: sql<number>`length(${productContentBlocks.settings})`,
    }).from(products)
        .innerJoin(productContentBlocks, eq(productContentBlocks.productId, products.id))
        .where(and(eq(products.id, productId), eq(productContentBlocks.id, blockId))).get();
    if (!row) {
        const product = await db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get();
        if (!product) return null;
        throw new ValidationError("Content block not found.", { field: "itemId" });
    }
    const totalCharacters = Number(row.totalCharacters);
    const value = row.value ?? "";
    return {
        section: "content_block" as const,
        aggregateRevision: row.aggregateRevision,
        itemId: row.id,
        placement: row.placement,
        position: row.position,
        type: row.type,
        version: row.version,
        legacy: Number(row.legacy) === 1,
        value,
        totalCharacters,
        offset,
        nextOffset: offset + value.length < totalCharacters ? offset + value.length : null,
    };
}

// ─────────────────────────────────────────
// Replace
// ─────────────────────────────────────────

/** Every media id a block names (images, video file, poster, gallery). */
export function productContentBlockMediaIds(block: ProductContentBlockValue): string[] {
    const settings = block.settings as Record<string, unknown>;
    const ids: string[] = [];
    if (typeof settings.mediaId === "string") ids.push(settings.mediaId);
    if (Array.isArray(settings.mediaIds)) ids.push(...settings.mediaIds.filter((id): id is string => typeof id === "string"));
    const source = settings.source as Record<string, unknown> | undefined;
    if (source && typeof source === "object") {
        if (typeof source.mediaId === "string") ids.push(source.mediaId);
        if (typeof source.posterMediaId === "string") ids.push(source.posterMediaId);
    }
    return ids.filter(Boolean);
}

/** Media ids that must be a video file; every other reference is an image. */
function videoMediaIds(block: ProductContentBlockValue): string[] {
    if (block.type !== "video" || block.settings.source.kind !== "media") return [];
    return [block.settings.source.mediaId];
}

/** Validates one block strictly and sanitises its HTML (rich text) for storage. */
function prepareBlock(input: Extract<ProductContentBlockInput, { type: string }>, index: number): ProductContentBlockValue {
    if (!isProductContentBlockType(input.type)) {
        throw new ValidationError(`Block ${index + 1}: unknown content block type.`, { field: `blocks.${index}.type` });
    }
    const parsed = parseProductContentBlock({ type: input.type, version: input.version, settings: input.settings });
    if (!parsed.success) {
        throw new ValidationError(`Block ${index + 1}: ${parsed.error}`, { field: `blocks.${index}.settings` });
    }
    const block = parsed.data;
    if (!isProductContentBlockPlacementAllowed(block.type, input.placement)) {
        throw new ValidationError(`Block ${index + 1}: a ${block.type} block can't go in ${input.placement}.`, {
            field: `blocks.${index}.placement`,
        });
    }
    if (block.type === "rich-text") {
        return { ...block, settings: { ...block.settings, html: sanitizeHtml(block.settings.html) } };
    }
    return block;
}

/**
 * The statements that make the product's non-legacy blocks exactly `input`
 * (page order within each placement), for the product's guarded aggregate
 * batch. Legacy mirrored tabs are neither counted as editable nor touched.
 */
export async function buildProductContentBlockReplaceStatements(
    db: Database,
    productId: string,
    input: readonly ProductContentBlockInput[],
): Promise<SQLiteBatchItem[] | null> {
    const [product, existingRows] = await Promise.all([
        db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get(),
        db.select({
            id: productContentBlocks.id,
            placement: productContentBlocks.placement,
            position: productContentBlocks.position,
            type: productContentBlocks.type,
            version: productContentBlocks.version,
            legacy: legacyTabSql,
        }).from(productContentBlocks).where(eq(productContentBlocks.productId, productId)).all(),
    ]);
    if (!product) return null;
    const existing = new Map((existingRows as StoredBlockRow[]).map((row) => [row.id, row]));
    const legacyCount = existingRows.filter((row) => Number(row.legacy) === 1).length;
    if (legacyCount + input.length > PRODUCT_CONTENT_BLOCKS_MAX) {
        throw new ValidationError(`A product can have at most ${PRODUCT_CONTENT_BLOCKS_MAX} content blocks, tabs included.`, {
            field: "blocks",
        });
    }

    const seen = new Set<string>();
    // The section's tabs follow the legacy tabs (until 1d moves those here too).
    const legacyTabEnd = existingRows.reduce((end, row) =>
        Number(row.legacy) === 1 && row.placement === "tabs" ? Math.max(end, row.position + 1) : end, 0);
    const nextPosition = new Map<ProductContentBlockPlacement, number>([["tabs", legacyTabEnd]]);
    const mediaIds = new Set<string>();
    const videoIds = new Set<string>();
    const planned: Array<{
        id: string;
        placement: ProductContentBlockPlacement;
        position: number;
        write: { type: string; version: number; settings: string } | null;
        isNew: boolean;
    }> = [];
    input.forEach((entry, index) => {
        if (entry.id !== undefined) {
            const stored = existing.get(entry.id);
            if (!stored) {
                throw new ValidationError(`Block ${index + 1} is not a block of this product. Leave out the id to add a block.`, {
                    field: `blocks.${index}.id`,
                });
            }
            if (Number(stored.legacy) === 1) {
                throw new ValidationError(`Block ${index + 1} is a tab from Additional information; edit it there.`, {
                    field: `blocks.${index}.id`,
                });
            }
            if (seen.has(entry.id)) {
                throw new ValidationError(`Block ${index + 1} is listed twice.`, { field: `blocks.${index}.id` });
            }
            seen.add(entry.id);
        }
        const position = nextPosition.get(entry.placement) ?? 0;
        nextPosition.set(entry.placement, position + 1);
        if ("keep" in entry) {
            const stored = existing.get(entry.id)!;
            if (!isProductContentBlockType(stored.type) || !isProductContentBlockPlacementAllowed(stored.type, entry.placement)) {
                throw new ValidationError(`Block ${index + 1}: a ${stored.type} block can't go in ${entry.placement}.`, {
                    field: `blocks.${index}.placement`,
                });
            }
            planned.push({ id: entry.id, placement: entry.placement, position, write: null, isNew: false });
            return;
        }
        const block = prepareBlock(entry, index);
        const settings = JSON.stringify(block.settings);
        if (settings.length > PRODUCT_CONTENT_BLOCK_SETTINGS_MAX_LENGTH) {
            throw new ValidationError(`Block ${index + 1} is too large.`, { field: `blocks.${index}.settings` });
        }
        productContentBlockMediaIds(block).forEach((id) => mediaIds.add(id));
        videoMediaIds(block).forEach((id) => videoIds.add(id));
        planned.push({
            id: entry.id ?? `${PRODUCT_CONTENT_BLOCK_ID_PREFIX}${nanoid()}`,
            placement: entry.placement,
            position,
            write: { type: block.type, version: block.version, settings },
            isNew: entry.id === undefined,
        });
    });

    if (mediaIds.size > PRODUCT_CONTENT_BLOCK_MEDIA_MAX) {
        throw new ValidationError(`Content blocks can use at most ${PRODUCT_CONTENT_BLOCK_MEDIA_MAX} files.`, { field: "blocks" });
    }
    if (mediaIds.size > 0) {
        const found = await db.select({ id: media.id, kind: media.kind }).from(media).where(and(
            sql`${media.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...mediaIds])}))`,
            eq(media.status, "ready"),
        )).all();
        const kinds = new Map(found.map((row) => [row.id, row.kind]));
        const missing = [...mediaIds].filter((id) => !kinds.has(id));
        if (missing.length > 0) {
            throw new ValidationError(PRODUCT_CONTENT_BLOCK_MEDIA_UNAVAILABLE_MESSAGE, {
                field: "blocks",
                missingMediaIds: missing,
            });
        }
        const wrongKind = [...mediaIds].filter((id) => (videoIds.has(id) ? "video" : "image") !== kinds.get(id));
        if (wrongKind.length > 0) {
            throw new ValidationError("A video block needs a video file, and every other block picture an image.", {
                field: "blocks",
                wrongKindMediaIds: wrongKind,
            });
        }
    }

    const statements: SQLiteBatchItem[] = [];
    if (mediaIds.size > 0) {
        // A file trashed or claimed for deletion since the check above fails the whole batch.
        statements.push(buildBatchGuard(db, sql`NOT EXISTS (
            SELECT 1 FROM json_each(${JSON.stringify([...mediaIds])})
            WHERE CAST(value AS TEXT) NOT IN (SELECT ${media.id} FROM ${media} WHERE ${media.status} = 'ready')
        )`, PRODUCT_CONTENT_BLOCK_MEDIA_GUARD));
    }
    const removed = [...existing.values()].filter((row) => Number(row.legacy) !== 1 && !seen.has(row.id));
    for (const row of removed) {
        statements.push(db.delete(productContentBlocks).where(and(
            eq(productContentBlocks.id, row.id),
            eq(productContentBlocks.productId, productId),
        )));
    }
    for (const block of planned) {
        if (block.isNew) {
            statements.push(db.insert(productContentBlocks).values({
                id: block.id,
                productId,
                placement: block.placement,
                position: block.position,
                type: block.write!.type,
                version: block.write!.version,
                settings: block.write!.settings,
            }));
            continue;
        }
        const stored = existing.get(block.id)!;
        if (!block.write && stored.placement === block.placement && stored.position === block.position) continue;
        statements.push(db.update(productContentBlocks).set({
            placement: block.placement,
            position: block.position,
            ...(block.write ?? {}),
            updatedAt: sql`unixepoch()`,
        }).where(and(eq(productContentBlocks.id, block.id), eq(productContentBlocks.productId, productId))));
    }
    return statements;
}

/**
 * The statements that give `targetId` a copy of `sourceId`'s own blocks
 * (legacy mirrored tabs excluded: the copied tabs mirror themselves), for
 * duplicating a product. Positions are kept, so they follow the copied tabs.
 */
export async function buildProductContentBlockCopyStatements(
    db: Database,
    sourceId: string,
    targetId: string,
): Promise<SQLiteBatchItem[]> {
    const rows = await db.select({
        placement: productContentBlocks.placement,
        position: productContentBlocks.position,
        type: productContentBlocks.type,
        version: productContentBlocks.version,
        settings: productContentBlocks.settings,
        legacy: legacyTabSql,
    }).from(productContentBlocks).where(eq(productContentBlocks.productId, sourceId))
        .orderBy(...blockOrder()).limit(PRODUCT_CONTENT_BLOCKS_MAX).all();
    return rows.filter((row) => Number(row.legacy) !== 1).map((row) => db.insert(productContentBlocks).values({
        id: `${PRODUCT_CONTENT_BLOCK_ID_PREFIX}${nanoid()}`,
        productId: targetId,
        placement: row.placement,
        position: row.position,
        type: row.type,
        version: row.version,
        settings: row.settings,
    }));
}

// ─────────────────────────────────────────
// Product page
// ─────────────────────────────────────────

/** The product page's one ordered block read (placement, position, id). */
export function selectProductPageContentBlockRows(db: Database, productId: string) {
    return db.select({
        id: productContentBlocks.id,
        placement: productContentBlocks.placement,
        type: productContentBlocks.type,
        version: productContentBlocks.version,
        settings: productContentBlocks.settings,
        // The legacy row id of a mirrored tab, so its tab keeps its id.
        legacyId: sql<string | null>`(
            SELECT "legacy_tab"."id" FROM ${productRichContent} AS "legacy_tab" WHERE ${LEGACY_ROW_MATCH}
        )`,
    }).from(productContentBlocks).where(eq(productContentBlocks.productId, productId)).orderBy(...blockOrder());
}

export type ProductPageContentBlockRow = {
    id: string;
    placement: ProductContentBlockPlacement;
    type: string;
    version: number;
    settings: string;
    legacyId: string | null;
};

/** A tab as the classic product page renders it (the `additionalInfo` contract). */
export interface ProductPageTab {
    id: string;
    title: string;
    content: string;
}

export type ProductPageContentBlock = ProductContentBlockValue & {
    id: string;
    placement: ProductContentBlockPlacement;
};

const PLACEMENT_ORDER = new Map(PRODUCT_CONTENT_BLOCK_PLACEMENTS.map((placement, index) => [placement, index]));

/**
 * Splits the ordered rows into the tabs (every `rich-text` block in `tabs`,
 * mirrored legacy rows under their legacy id) and the other blocks, in
 * placement then page order. A stored block that no longer validates is left
 * out rather than rendered wrong.
 */
export function resolveProductPageContentBlocks(rows: readonly ProductPageContentBlockRow[]) {
    const tabs: ProductPageTab[] = [];
    const blocks: ProductPageContentBlock[] = [];
    const mediaIds = new Set<string>();
    for (const row of rows) {
        if (row.legacyId !== null) {
            // Mirrored verbatim from product_rich_content (no length rules there).
            try {
                const settings = JSON.parse(row.settings) as { title?: unknown; html?: unknown };
                tabs.push({
                    id: row.legacyId,
                    title: typeof settings.title === "string" ? settings.title : "",
                    content: typeof settings.html === "string" ? settings.html : "",
                });
            } catch {
                // A mirror always writes JSON; nothing else to render.
            }
            continue;
        }
        const block = parseStoredProductContentBlock(row);
        if (!block) continue;
        if (block.type === "rich-text" && row.placement === "tabs") {
            tabs.push({ id: row.id, title: block.settings.title, content: block.settings.html });
            continue;
        }
        productContentBlockMediaIds(block).forEach((id) => mediaIds.add(id));
        blocks.push({ ...block, id: row.id, placement: row.placement });
    }
    blocks.sort((a, b) => PLACEMENT_ORDER.get(a.placement)! - PLACEMENT_ORDER.get(b.placement)!);
    return { tabs, blocks, mediaIds: [...mediaIds].slice(0, PRODUCT_CONTENT_BLOCK_MEDIA_MAX) };
}

export interface ProductPageBlockMedia {
    id: string;
    kind: "image" | "video";
    url: string;
    altText: string | null;
    width: number | null;
    height: number | null;
    posterUrl: string | null;
}

/** The ready files the blocks name (one read, ≤ 90 ids as one parameter). */
export async function loadProductPageBlockMedia(db: Database, mediaIds: readonly string[]): Promise<ProductPageBlockMedia[]> {
    if (mediaIds.length === 0) return [];
    const rows = await db.select({
        id: media.id,
        kind: media.kind,
        objectKey: media.objectKey,
        variantWidth: media.variantWidth,
        altText: media.altText,
        width: media.width,
        height: media.height,
        posterObjectKey: sql<string | null>`(
            SELECT poster.object_key FROM ${media} AS poster
            WHERE poster.id = ${media.posterMediaId} AND poster.kind = 'image' AND poster.status = 'ready'
        )`,
        posterVariantWidth: sql<number | null>`(
            SELECT poster.variant_width FROM ${media} AS poster
            WHERE poster.id = ${media.posterMediaId} AND poster.kind = 'image' AND poster.status = 'ready'
        )`,
    }).from(media).where(and(
        sql`${media.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(mediaIds.slice(0, PRODUCT_CONTENT_BLOCK_MEDIA_MAX))}))`,
        eq(media.status, "ready"),
    )).all();
    return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        url: getCurrentMediaUrl(row.objectKey, row.variantWidth),
        altText: row.altText,
        width: row.width,
        height: row.height,
        posterUrl: row.posterObjectKey ? getCurrentMediaUrl(row.posterObjectKey, row.posterVariantWidth) : null,
    }));
}
