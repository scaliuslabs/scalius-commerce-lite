import type { Database } from "@scalius/database/client";
import { digitalAssets, digitalEntitlements, digitalLicenceKeys } from "@scalius/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { LineExtrasInput } from "../../utils/line-extras";
import type { LineDigitalExtra, LineDownloadExtra, LineLicenceKeyExtra } from "./browser";
import { countBuyerDigitalEntitlements } from "./downloads";

const ID_CHUNK = 90;

/**
 * Downloads and licence keys per order line, keyed by order item id
 * (`extras.downloads`, `extras.licenceKeys`). Buyers do not see the keys of an
 * entitlement the store revoked; staff see every key by its last 4.
 */
export async function listLineDeliveries(
    db: Database,
    input: LineExtrasInput,
): Promise<ReadonlyMap<string, LineDigitalExtra>> {
    const result = new Map<string, { downloads: LineDownloadExtra[]; licenceKeys: LineLicenceKeyExtra[] }>();
    if (input.orderItemIds.length === 0) return result;
    const itemIds = [...input.orderItemIds];
    for (let offset = 0; offset < itemIds.length; offset += ID_CHUNK) {
        const chunk = itemIds.slice(offset, offset + ID_CHUNK);
        const rows = await db.select({
            id: digitalEntitlements.id,
            orderItemId: digitalEntitlements.orderItemId,
            kind: digitalEntitlements.kind,
            downloadCount: digitalEntitlements.downloadCount,
            downloadLimit: digitalEntitlements.downloadLimit,
            expiresAt: digitalEntitlements.expiresAt,
            revokedAt: digitalEntitlements.revokedAt,
            displayName: digitalAssets.displayName,
        }).from(digitalEntitlements)
            .innerJoin(digitalAssets, eq(digitalAssets.id, digitalEntitlements.assetId))
            .where(and(eq(digitalEntitlements.orderId, input.orderId), inArray(digitalEntitlements.orderItemId, chunk)))
            .orderBy(asc(digitalEntitlements.createdAt), asc(digitalEntitlements.id))
            .all();
        const keyEntitlements = rows
            .filter((row) => row.kind === "licence_keys" && (input.audience === "staff" || row.revokedAt === null))
            .map((row) => row.id);
        const keys = keyEntitlements.length === 0 ? [] : await db.select({
            id: digitalLicenceKeys.id,
            last4: digitalLicenceKeys.keyLast4,
            orderItemId: digitalLicenceKeys.orderItemId,
        }).from(digitalLicenceKeys)
            .where(and(inArray(digitalLicenceKeys.entitlementId, keyEntitlements), eq(digitalLicenceKeys.status, "assigned")))
            .orderBy(asc(digitalLicenceKeys.createdAt), asc(digitalLicenceKeys.id))
            .all();
        const entry = (orderItemId: string) => {
            let value = result.get(orderItemId);
            if (!value) {
                value = { downloads: [], licenceKeys: [] };
                result.set(orderItemId, value);
            }
            return value;
        };
        for (const row of rows) {
            if (row.kind !== "file") continue;
            entry(row.orderItemId).downloads.push({
                entitlementId: row.id,
                displayName: row.displayName,
                downloadCount: row.downloadCount,
                downloadLimit: row.downloadLimit,
                expiresAt: row.expiresAt,
                revoked: row.revokedAt !== null,
            });
        }
        for (const key of keys) {
            if (key.orderItemId) entry(key.orderItemId).licenceKeys.push({ keyId: key.id, last4: key.last4 });
        }
    }
    return result;
}

/** Downloads and keys available to the signed-in customer (the account "Downloads" count). */
export async function countBuyerDownloads(db: Database, customerId: string): Promise<number> {
    return countBuyerDigitalEntitlements(db, customerId);
}
