// Buyer downloads and licence keys (Wave B §3.4): no bearer URLs.
//
// Mint (POST, counts): access follows the order (the account that owns it, or
// the receipt proof of that order); a guarded UPDATE counts the download and
// never passes the limit, even under concurrent mints (D4). It returns a
// 10-minute ticket path whose signature is bound to the buyer's proof, which
// the storefront reads from its httpOnly cookie: a logged or shared URL
// without that cookie downloads nothing. Resuming within the window is free.
//
// Licence keys are revealed only by a POST, for the buyer who owns the line.
import type { Database } from "@scalius/database/client";
import {
    digitalAssets,
    digitalEntitlements,
    digitalLicenceKeys,
    orderItems,
    orders,
} from "@scalius/database/schema";
import { DIGITAL_DOWNLOAD_TICKET_TTL_SECONDS } from "@scalius/shared/digital";
import { AppError, NotFoundError } from "@scalius/core/errors";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { licenceKeyCrypto, signDownloadTicket, verifyDownloadTicketSignature } from "./secrets";

/** Who is asking: the signed-in account owner, or a holder of this order's receipt proof. */
export type DigitalBuyerAccess =
    | { kind: "customer"; customerId: string }
    | { kind: "receipt"; orderId: string };

type TicketEnv = { SCALIUS_SECRET?: unknown };

const LIST_LIMIT = 100;
const ID_CHUNK = 90;

function accessCondition(access: DigitalBuyerAccess): SQL {
    return access.kind === "customer"
        ? and(eq(orders.accountOwnerCustomerId, access.customerId), isNull(orders.deletedAt))!
        : and(eq(orders.id, access.orderId), isNull(orders.deletedAt))!;
}

export interface BuyerDownloadFile {
    entitlementId: string;
    displayName: string;
    filename: string | null;
    sizeBytes: number | null;
    downloadCount: number;
    downloadLimit: number | null;
    expiresAt: number | null;
    revoked: boolean;
    /** The file is ready to download right now (not revoked, expired, used up or missing). */
    available: boolean;
}

export interface BuyerLicenceKey {
    keyId: string;
    last4: string;
}

export interface BuyerDigitalLine {
    orderId: string;
    orderNumber: number | null;
    orderItemId: string;
    productName: string | null;
    variantLabel: string | null;
    deliveredAt: number;
    files: BuyerDownloadFile[];
    licenceKeys: BuyerLicenceKey[];
}

function fileAvailable(row: { revokedAt: number | null; expiresAt: number | null; downloadCount: number; downloadLimit: number | null; hasObject: boolean }, now: number): boolean {
    return row.revokedAt === null
        && row.hasObject
        && (row.expiresAt === null || row.expiresAt > now)
        && (row.downloadLimit === null || row.downloadCount < row.downloadLimit);
}

/**
 * Everything the buyer received, newest first, grouped by order line: files
 * with their counts, and licence keys by their last 4 characters. At most 100
 * entitlements (the account Downloads page and a receipt).
 */
export async function listBuyerDownloads(
    db: Database,
    access: DigitalBuyerAccess,
    now: number = Math.floor(Date.now() / 1000),
): Promise<BuyerDigitalLine[]> {
    const rows = await db.select({
        entitlementId: digitalEntitlements.id,
        orderId: digitalEntitlements.orderId,
        orderItemId: digitalEntitlements.orderItemId,
        kind: digitalEntitlements.kind,
        downloadCount: digitalEntitlements.downloadCount,
        downloadLimit: digitalEntitlements.downloadLimit,
        expiresAt: digitalEntitlements.expiresAt,
        revokedAt: digitalEntitlements.revokedAt,
        createdAt: digitalEntitlements.createdAt,
        displayName: digitalAssets.displayName,
        filename: digitalAssets.filename,
        sizeBytes: digitalAssets.sizeBytes,
        hasObject: sql<number>`${digitalAssets.currentR2Key} IS NOT NULL`,
        orderNumber: orders.orderNumber,
        productName: orderItems.productName,
        variantLabel: orderItems.variantLabel,
    }).from(digitalEntitlements)
        .innerJoin(orders, eq(orders.id, digitalEntitlements.orderId))
        .innerJoin(orderItems, eq(orderItems.id, digitalEntitlements.orderItemId))
        .innerJoin(digitalAssets, eq(digitalAssets.id, digitalEntitlements.assetId))
        .where(accessCondition(access))
        .orderBy(desc(digitalEntitlements.createdAt), desc(digitalEntitlements.id))
        .limit(LIST_LIMIT)
        .all();

    const keyEntitlements = rows.filter((row) => row.kind === "licence_keys" && row.revokedAt === null).map((row) => row.entitlementId);
    const keysByEntitlement = new Map<string, BuyerLicenceKey[]>();
    for (let offset = 0; offset < keyEntitlements.length; offset += ID_CHUNK) {
        const keys = await db.select({ id: digitalLicenceKeys.id, last4: digitalLicenceKeys.keyLast4, entitlementId: digitalLicenceKeys.entitlementId })
            .from(digitalLicenceKeys)
            .where(and(inArray(digitalLicenceKeys.entitlementId, keyEntitlements.slice(offset, offset + ID_CHUNK)), eq(digitalLicenceKeys.status, "assigned")))
            .orderBy(digitalLicenceKeys.createdAt, digitalLicenceKeys.id)
            .all();
        for (const key of keys) {
            const list = keysByEntitlement.get(key.entitlementId ?? "") ?? [];
            list.push({ keyId: key.id, last4: key.last4 });
            keysByEntitlement.set(key.entitlementId ?? "", list);
        }
    }

    const lines = new Map<string, BuyerDigitalLine>();
    for (const row of rows) {
        let line = lines.get(row.orderItemId);
        if (!line) {
            line = {
                orderId: row.orderId,
                orderNumber: row.orderNumber,
                orderItemId: row.orderItemId,
                productName: row.productName,
                variantLabel: row.variantLabel,
                deliveredAt: row.createdAt,
                files: [],
                licenceKeys: [],
            };
            lines.set(row.orderItemId, line);
        }
        if (row.kind === "file") {
            line.files.push({
                entitlementId: row.entitlementId,
                displayName: row.displayName,
                filename: row.filename,
                sizeBytes: row.sizeBytes,
                downloadCount: row.downloadCount,
                downloadLimit: row.downloadLimit,
                expiresAt: row.expiresAt,
                revoked: row.revokedAt !== null,
                available: fileAvailable({ ...row, hasObject: Boolean(row.hasObject) }, now),
            });
        } else {
            line.licenceKeys.push(...(keysByEntitlement.get(row.entitlementId) ?? []));
        }
    }
    return [...lines.values()];
}

/** Live downloads and keys the account owns (the account Downloads tab count). */
export async function countBuyerDigitalEntitlements(db: Database, customerId: string): Promise<number> {
    const [row] = await db.select({ count: sql<number>`count(*)` })
        .from(digitalEntitlements)
        .innerJoin(orders, eq(orders.id, digitalEntitlements.orderId))
        .where(and(accessCondition({ kind: "customer", customerId }), isNull(digitalEntitlements.revokedAt)))
        .all();
    return Number(row?.count ?? 0);
}

export interface DownloadTicket {
    /** Storefront-relative path suffix: `<entitlementId>/<exp>/<sig>`. Ids and a signature only. */
    path: string;
    expiresAt: number;
    downloadCount: number;
    downloadLimit: number | null;
}

/**
 * Counts one download and mints a ticket bound to `proof` (the buyer's session
 * token or receipt proof). Refused when revoked, expired or used up.
 */
export async function mintDownloadTicket(
    db: Database,
    env: TicketEnv,
    input: { entitlementId: string; access: DigitalBuyerAccess; proof: string },
    now: number = Math.floor(Date.now() / 1000),
): Promise<DownloadTicket> {
    if (!input.proof) throw new NotFoundError("Download not found");
    const owned = await db.select({
        id: digitalEntitlements.id,
        kind: digitalEntitlements.kind,
        revokedAt: digitalEntitlements.revokedAt,
        expiresAt: digitalEntitlements.expiresAt,
        downloadCount: digitalEntitlements.downloadCount,
        downloadLimit: digitalEntitlements.downloadLimit,
        currentR2Key: digitalAssets.currentR2Key,
    }).from(digitalEntitlements)
        .innerJoin(orders, eq(orders.id, digitalEntitlements.orderId))
        .innerJoin(digitalAssets, eq(digitalAssets.id, digitalEntitlements.assetId))
        .where(and(eq(digitalEntitlements.id, input.entitlementId), accessCondition(input.access)))
        .get();
    if (!owned || owned.kind !== "file" || !owned.currentR2Key) throw new NotFoundError("Download not found");
    if (owned.revokedAt !== null) throw new AppError(410, "DOWNLOAD_REVOKED", "The store removed access to this download.");
    if (owned.expiresAt !== null && owned.expiresAt <= now) throw new AppError(410, "DOWNLOAD_EXPIRED", "Access to this download has ended.");

    // D4: the guard is the WHERE clause; zero rows means the limit was reached.
    const counted = await db.update(digitalEntitlements).set({
        downloadCount: sql`${digitalEntitlements.downloadCount} + 1`,
        lastDownloadAt: now,
        updatedAt: now,
    }).where(and(
        eq(digitalEntitlements.id, input.entitlementId),
        isNull(digitalEntitlements.revokedAt),
        sql`(${digitalEntitlements.downloadLimit} IS NULL OR ${digitalEntitlements.downloadCount} < ${digitalEntitlements.downloadLimit})`,
        sql`(${digitalEntitlements.expiresAt} IS NULL OR ${digitalEntitlements.expiresAt} > ${now})`,
    )).returning({ downloadCount: digitalEntitlements.downloadCount, downloadLimit: digitalEntitlements.downloadLimit });
    const after = counted[0];
    if (!after) throw new AppError(409, "DOWNLOAD_LIMIT_REACHED", "You've used every download of this file. Ask the store for more.");

    const expiresAt = now + DIGITAL_DOWNLOAD_TICKET_TTL_SECONDS;
    const signature = await signDownloadTicket(env, { entitlementId: input.entitlementId, expiresAt, proof: input.proof });
    return {
        path: `${encodeURIComponent(input.entitlementId)}/${expiresAt}/${signature}`,
        expiresAt,
        downloadCount: after.downloadCount,
        downloadLimit: after.downloadLimit,
    };
}

export interface DownloadObject {
    r2Key: string;
    filename: string;
    mediaType: string;
    sizeBytes: number | null;
}

/**
 * Opens a ticket for streaming: the signature must match this proof and the
 * ticket must be unexpired; the entitlement must still be live (1 read).
 * Every failure is the same 404, so a URL alone reveals nothing.
 */
export async function openDownloadTicket(
    db: Database,
    env: TicketEnv,
    input: { entitlementId: string; expiresAt: number; signature: string; proof: string | null },
    now: number = Math.floor(Date.now() / 1000),
): Promise<DownloadObject> {
    const notFound = new NotFoundError("Download not found");
    if (!input.proof || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now
        || input.expiresAt > now + DIGITAL_DOWNLOAD_TICKET_TTL_SECONDS) throw notFound;
    const valid = await verifyDownloadTicketSignature(env, {
        entitlementId: input.entitlementId,
        expiresAt: input.expiresAt,
        proof: input.proof,
        signature: input.signature,
    });
    if (!valid) throw notFound;
    const row = await db.select({
        revokedAt: digitalEntitlements.revokedAt,
        expiresAt: digitalEntitlements.expiresAt,
        kind: digitalEntitlements.kind,
        r2Key: digitalAssets.currentR2Key,
        filename: digitalAssets.filename,
        mediaType: digitalAssets.mediaType,
        sizeBytes: digitalAssets.sizeBytes,
    }).from(digitalEntitlements)
        .innerJoin(digitalAssets, eq(digitalAssets.id, digitalEntitlements.assetId))
        .where(eq(digitalEntitlements.id, input.entitlementId))
        .get();
    if (!row || row.kind !== "file" || !row.r2Key || row.revokedAt !== null) throw notFound;
    if (row.expiresAt !== null && row.expiresAt <= now) throw notFound;
    return {
        r2Key: row.r2Key,
        filename: row.filename ?? "download",
        mediaType: row.mediaType ?? "application/octet-stream",
        sizeBytes: row.sizeBytes,
    };
}

/** The plaintext of one licence key the buyer received (a POST, never cached or logged). */
export async function revealLicenceKey(
    db: Database,
    credentialKey: string | undefined,
    input: { keyId: string; access: DigitalBuyerAccess },
): Promise<{ keyId: string; key: string; last4: string }> {
    const row = await db.select({
        id: digitalLicenceKeys.id,
        assetId: digitalLicenceKeys.assetId,
        ciphertext: digitalLicenceKeys.keyCiphertext,
        last4: digitalLicenceKeys.keyLast4,
        revokedAt: digitalEntitlements.revokedAt,
    }).from(digitalLicenceKeys)
        .innerJoin(digitalEntitlements, eq(digitalEntitlements.id, digitalLicenceKeys.entitlementId))
        .innerJoin(orders, eq(orders.id, digitalEntitlements.orderId))
        .where(and(
            eq(digitalLicenceKeys.id, input.keyId),
            eq(digitalLicenceKeys.status, "assigned"),
            accessCondition(input.access),
        ))
        .get();
    if (!row || row.revokedAt !== null) throw new NotFoundError("Licence key not found");
    const cipher = await licenceKeyCrypto(credentialKey);
    return { keyId: row.id, key: await cipher.decrypt(row.ciphertext, row.assetId), last4: row.last4 };
}
