// Binding buyer uploads to the order that uses them (COMMERCE-HOOKS H17).
//
// An order's `file` answers name upload ids: a line input's (frozen on the
// order line with type `file`) or a checkout attribute's. The commit checks
// them in one read (each id exists, no order holds it, and it was uploaded
// for this input and, a line input, this product), then attaches them in its
// own batch behind a guard: a second order racing for the same upload, or a
// sweep that removed it, rolls the whole order back. So an id copied from
// another buyer, another input, another product or an earlier order is
// refused, never attached twice. The quote fingerprint covers the answers
// (they are line properties and attributes), so a swapped id after review
// sends the buyer back to review.
import { buildBatchGuard, type Database } from "@scalius/database/client";
import { buyerUploads } from "@scalius/database/schema";
import { parseBuyerUploadValue } from "@scalius/shared/buyer-uploads";
import { readOrderLineProperties } from "@scalius/shared/line-properties";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { AppError } from "../../errors";
import { BUYER_UPLOADS_PER_ORDER_MAX } from "./uploads";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** The guard marker of a commit whose uploads changed since its check. */
export const BUYER_UPLOAD_UNAVAILABLE_GUARD = "BUYER_UPLOAD_UNAVAILABLE";

/** The uploads one answer of the order names. */
export interface BuyerUploadClaim {
    fieldKey: string;
    target: "line" | "attribute";
    /** A line input's product; null for an attribute. */
    productId: string | null;
    /** A line input's order line; null for an attribute. */
    orderItemId: string | null;
    uploadIds: readonly string[];
}

/** The `file` answers frozen on the order's lines. */
export function lineBuyerUploadClaims(
    lines: readonly { id: string; productId: string | null; properties?: string | null }[],
): BuyerUploadClaim[] {
    const claims: BuyerUploadClaim[] = [];
    for (const line of lines) {
        if (!line.properties || !line.productId) continue;
        for (const property of readOrderLineProperties(line.properties)) {
            if (property.type !== "file") continue;
            const ids = parseBuyerUploadValue(property.value);
            if (ids) claims.push({ fieldKey: property.key, target: "line", productId: line.productId, orderItemId: line.id, uploadIds: ids });
        }
    }
    return claims;
}

/** The `file` checkout attributes of the order (`fileKeys`: `<app id>.<key>` of every declared file attribute). */
export function attributeBuyerUploadClaims(
    attributes: Readonly<Record<string, string>>,
    fileKeys: ReadonlySet<string>,
): BuyerUploadClaim[] {
    const claims: BuyerUploadClaim[] = [];
    for (const [key, value] of Object.entries(attributes)) {
        if (!fileKeys.has(key)) continue;
        const ids = parseBuyerUploadValue(value);
        if (ids) claims.push({ fieldKey: key, target: "attribute", productId: null, orderItemId: null, uploadIds: ids });
    }
    return claims;
}

function unavailable(fieldKey: string | null): never {
    throw new AppError(409, "upload_unavailable", "A file you added is no longer available. Remove it and upload it again.", fieldKey ? { key: fieldKey } : undefined);
}

/**
 * Refuses (409 `upload_unavailable`, naming the input) an upload that does
 * not exist, that an order already holds, that was uploaded for another
 * input or product, or that the order names twice. One read, only when the
 * order has `file` answers.
 */
export async function assertBuyerUploadClaims(db: Database, claims: readonly BuyerUploadClaim[]): Promise<void> {
    const ids = claims.flatMap((claim) => claim.uploadIds);
    if (ids.length === 0) return;
    if (ids.length > BUYER_UPLOADS_PER_ORDER_MAX) {
        throw new AppError(400, "upload_unavailable", `An order takes at most ${BUYER_UPLOADS_PER_ORDER_MAX} files.`);
    }
    const seen = new Set<string>();
    for (const claim of claims) {
        for (const id of claim.uploadIds) {
            if (seen.has(id)) unavailable(claim.fieldKey);
            seen.add(id);
        }
    }
    const rows = await db.select({
        id: buyerUploads.id,
        fieldKey: buyerUploads.fieldKey,
        target: buyerUploads.target,
        productId: buyerUploads.productId,
        orderId: buyerUploads.orderId,
    }).from(buyerUploads)
        .where(sql`${buyerUploads.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`)
        .all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const claim of claims) {
        for (const id of claim.uploadIds) {
            const row = byId.get(id);
            if (!row || row.orderId !== null || row.fieldKey !== claim.fieldKey || row.target !== claim.target || row.productId !== claim.productId) {
                unavailable(claim.fieldKey);
            }
        }
    }
}

/**
 * The commit's statements: one attach per answer, each bound to its input,
 * product and order line, then a guard that every claimed upload is now this
 * order's. Placed after the order's lines (the trigger checks the line).
 */
export function buyerUploadAttachStatements(db: Database, orderId: string, claims: readonly BuyerUploadClaim[]): SQLiteBatchItem[] {
    const total = claims.reduce((sum, claim) => sum + claim.uploadIds.length, 0);
    if (total === 0) return [];
    const writes: SQLiteBatchItem[] = claims.map((claim) => db.update(buyerUploads).set({
        orderId,
        orderItemId: claim.orderItemId,
        attachedAt: sql`unixepoch()`,
    }).where(and(
        sql`${buyerUploads.id} IN (SELECT value FROM json_each(${JSON.stringify(claim.uploadIds)}))`,
        isNull(buyerUploads.orderId),
        eq(buyerUploads.fieldKey, claim.fieldKey),
        eq(buyerUploads.target, claim.target),
        claim.productId === null ? isNull(buyerUploads.productId) : eq(buyerUploads.productId, claim.productId),
    )) as unknown as SQLiteBatchItem);
    writes.push(buildBatchGuard(db, sql`(SELECT count(*) FROM ${buyerUploads} WHERE ${buyerUploads.orderId} = ${orderId}) = ${total}`, BUYER_UPLOAD_UNAVAILABLE_GUARD));
    return writes;
}
