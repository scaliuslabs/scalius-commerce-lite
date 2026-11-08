// Staff operations on what an order line received (Wave B §3.5), and the
// send-time content of the delivery message (§10). Staff see keys by last 4
// only; plaintext keys are decrypted here only for the buyer's own message.
import { D1_ID_CHUNK_SIZE, type Database } from "@scalius/database/client";
import { digitalAssets, digitalEntitlements, digitalLicenceKeys, orderItems, orders } from "@scalius/database/schema";
import { NotFoundError } from "@scalius/core/errors";
import type { DigitalAssetKind } from "@scalius/shared/digital";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { licenceKeyCrypto } from "./secrets";
import { DIGITAL_ACCESS_ENDED_ORDER_STATUSES } from "./downloads";

async function requireEntitlement(db: Database, entitlementId: string) {
    const row = await db.select({ id: digitalEntitlements.id, orderId: digitalEntitlements.orderId })
        .from(digitalEntitlements).where(eq(digitalEntitlements.id, entitlementId)).get();
    if (!row) throw new NotFoundError("Download not found");
    return row;
}

/** "Allow more downloads": the count starts again from zero. */
export async function resetDigitalEntitlement(db: Database, entitlementId: string): Promise<{ orderId: string }> {
    const row = await requireEntitlement(db, entitlementId);
    await db.update(digitalEntitlements).set({ downloadCount: 0, updatedAt: sql`unixepoch()` })
        .where(eq(digitalEntitlements.id, entitlementId)).run();
    return { orderId: row.orderId };
}

/** "Revoke access": downloads and key reveals stop at once (idempotent). */
export async function revokeDigitalEntitlement(db: Database, entitlementId: string): Promise<{ orderId: string }> {
    const row = await requireEntitlement(db, entitlementId);
    await db.update(digitalEntitlements).set({ revokedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
        .where(and(eq(digitalEntitlements.id, entitlementId), isNull(digitalEntitlements.revokedAt))).run();
    return { orderId: row.orderId };
}

/** Gives a revoked access back (the grant's reinstate): its download count and expiry stay as they were. */
export function reinstateDigitalEntitlementStatement(db: Database, entitlementId: string): BatchItem<"sqlite"> {
    return db.update(digitalEntitlements).set({ revokedAt: null, updatedAt: sql`unixepoch()` })
        .where(and(eq(digitalEntitlements.id, entitlementId), isNotNull(digitalEntitlements.revokedAt))) as BatchItem<"sqlite">;
}

/** Writes one entitlement row unless the line already holds that asset (unique per line and asset). */
export function insertDigitalEntitlementStatement(db: Database, row: typeof digitalEntitlements.$inferInsert): BatchItem<"sqlite"> {
    return db.insert(digitalEntitlements).values(row)
        .onConflictDoNothing({ target: [digitalEntitlements.orderItemId, digitalEntitlements.assetId] }) as BatchItem<"sqlite">;
}

/** One line's access to one asset, if it has any (revoked included). */
export async function findLineDigitalEntitlement(db: Database, orderItemId: string, assetId: string): Promise<{ id: string; revokedAt: number | null } | null> {
    const row = await db.select({ id: digitalEntitlements.id, revokedAt: digitalEntitlements.revokedAt }).from(digitalEntitlements)
        .where(and(eq(digitalEntitlements.orderItemId, orderItemId), eq(digitalEntitlements.assetId, assetId)))
        .get();
    return row ?? null;
}

/** What an app reads of one buyer's access: never a ticket, a storage key or a licence key. */
export interface DigitalAccessView {
    id: string;
    orderId: string;
    orderItemId: string;
    assetId: string;
    productId: string;
    variantId: string | null;
    customerId: string | null;
    kind: DigitalAssetKind;
    name: string;
    quantity: number;
    downloadCount: number;
    downloadLimit: number | null;
    expiresAt: number | null;
    revokedAt: number | null;
    lastDownloadAt: number | null;
    orderStatus: string;
    createdAt: number;
    updatedAt: number;
}

/** The access records with these ids, in the order given (missing ids are left out); reads in waves of 90. */
export async function readDigitalAccessViews(db: Database, ids: readonly string[]): Promise<DigitalAccessView[]> {
    const byId = new Map<string, DigitalAccessView>();
    for (let offset = 0; offset < ids.length; offset += D1_ID_CHUNK_SIZE) {
        const rows = await db.select({
            id: digitalEntitlements.id,
            orderId: digitalEntitlements.orderId,
            orderItemId: digitalEntitlements.orderItemId,
            assetId: digitalEntitlements.assetId,
            productId: digitalAssets.productId,
            variantId: orderItems.variantId,
            customerId: orders.customerId,
            kind: digitalEntitlements.kind,
            name: digitalAssets.displayName,
            quantity: digitalEntitlements.quantity,
            downloadCount: digitalEntitlements.downloadCount,
            downloadLimit: digitalEntitlements.downloadLimit,
            expiresAt: digitalEntitlements.expiresAt,
            revokedAt: digitalEntitlements.revokedAt,
            lastDownloadAt: digitalEntitlements.lastDownloadAt,
            orderStatus: orders.status,
            createdAt: digitalEntitlements.createdAt,
            updatedAt: digitalEntitlements.updatedAt,
        }).from(digitalEntitlements)
            .innerJoin(orders, eq(orders.id, digitalEntitlements.orderId))
            .innerJoin(orderItems, eq(orderItems.id, digitalEntitlements.orderItemId))
            .innerJoin(digitalAssets, eq(digitalAssets.id, digitalEntitlements.assetId))
            .where(inArray(digitalEntitlements.id, [...ids.slice(offset, offset + D1_ID_CHUNK_SIZE)]))
            .all();
        for (const row of rows) byId.set(row.id, row);
    }
    return ids.flatMap((id) => byId.get(id) ?? []);
}

/** Live entitlements of an order (a resend needs at least one). */
export async function countOrderDigitalEntitlements(db: Database, orderId: string): Promise<number> {
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(digitalEntitlements)
        .where(and(eq(digitalEntitlements.orderId, orderId), isNull(digitalEntitlements.revokedAt))).all();
    return Number(row?.count ?? 0);
}

export interface DigitalDeliveryContent {
    /** Display names of the files, in delivery order. */
    fileNames: string[];
    /** Plaintext keys: for the buyer's message only, never persisted or logged. */
    licenceKeys: string[];
}

/**
 * What one delivery (or, without `fulfillmentId`, the whole order: a resend)
 * handed over and is still live. Keys are decrypted with the strict
 * CREDENTIAL_ENCRYPTION_KEY; a missing key throws (the message retries).
 * `null` when nothing live remains.
 */
export async function resolveDigitalDeliveryContent(
    db: Database,
    credentialKey: string | undefined,
    input: { orderId: string; fulfillmentId?: string | null },
): Promise<DigitalDeliveryContent | null> {
    const order = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, input.orderId)).get();
    if (!order || (DIGITAL_ACCESS_ENDED_ORDER_STATUSES as readonly string[]).includes(order.status)) return null;
    const entitlements = await db.select({
        id: digitalEntitlements.id,
        kind: digitalEntitlements.kind,
        displayName: digitalAssets.displayName,
    }).from(digitalEntitlements)
        .innerJoin(digitalAssets, eq(digitalAssets.id, digitalEntitlements.assetId))
        .where(and(
            eq(digitalEntitlements.orderId, input.orderId),
            input.fulfillmentId ? eq(digitalEntitlements.fulfillmentId, input.fulfillmentId) : undefined,
            isNull(digitalEntitlements.revokedAt),
        ))
        .orderBy(asc(digitalEntitlements.createdAt), asc(digitalEntitlements.id))
        .limit(90)
        .all();
    if (entitlements.length === 0) return null;
    const fileNames = entitlements.filter((row) => row.kind === "file").map((row) => row.displayName);
    const keyEntitlements = entitlements.filter((row) => row.kind === "licence_keys").map((row) => row.id);
    const licenceKeys: string[] = [];
    if (keyEntitlements.length > 0) {
        const keys = await db.select({ assetId: digitalLicenceKeys.assetId, ciphertext: digitalLicenceKeys.keyCiphertext })
            .from(digitalLicenceKeys)
            .where(and(inArray(digitalLicenceKeys.entitlementId, keyEntitlements), eq(digitalLicenceKeys.status, "assigned")))
            .orderBy(asc(digitalLicenceKeys.createdAt), asc(digitalLicenceKeys.id))
            .limit(200)
            .all();
        if (keys.length > 0) {
            const cipher = await licenceKeyCrypto(credentialKey);
            for (const key of keys) licenceKeys.push(await cipher.decrypt(key.ciphertext, key.assetId));
        }
    }
    return { fileNames, licenceKeys };
}
