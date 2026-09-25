// Staff operations on what an order line received (Wave B §3.5), and the
// send-time content of the delivery message (§10). Staff see keys by last 4
// only; plaintext keys are decrypted here only for the buyer's own message.
import type { Database } from "@scalius/database/client";
import { digitalAssets, digitalEntitlements, digitalLicenceKeys } from "@scalius/database/schema";
import { NotFoundError } from "@scalius/core/errors";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { licenceKeyCrypto } from "./secrets";

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
