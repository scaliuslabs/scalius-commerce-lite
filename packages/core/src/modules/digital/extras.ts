import type { Database } from "@scalius/database/client";
import { digitalAssets, digitalEntitlements, digitalLicenceKeys, orders } from "@scalius/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { LineExtrasInput } from "../../utils/line-extras";
import type { LineDigitalExtra, LineDownloadExtra, LineLicenceKeyExtra } from "./browser";
import { countBuyerDigitalEntitlements, DIGITAL_ACCESS_ENDED_ORDER_STATUSES } from "./downloads";

const ID_CHUNK = 90;

/**
 * Downloads and licence keys per order line, keyed by order item id
 * (`extras.downloads`, `extras.licenceKeys`). Buyers do not see the keys of an
 * entitlement the store revoked or of a cancelled, refunded or returned order
 * (shown as revoked); staff see every key by its last 4.
 */
export async function listLineDeliveries(
    db: Database,
    input: LineExtrasInput,
): Promise<ReadonlyMap<string, LineDigitalExtra>> {
    const result = new Map<string, { downloads: LineDownloadExtra[]; licenceKeys: LineLicenceKeyExtra[] }>();
    if (input.orderItemIds.length === 0) return result;
    const itemIds = [...input.orderItemIds];
    // Read only for orders that delivered something digital.
    let accessEnded: boolean | undefined;
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
        if (rows.length === 0) continue;
        if (accessEnded === undefined) {
            const order = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, input.orderId)).get();
            accessEnded = (DIGITAL_ACCESS_ENDED_ORDER_STATUSES as readonly string[]).includes(order?.status ?? "");
        }
        const keyEntitlements = rows
            .filter((row) => row.kind === "licence_keys" && (input.audience === "staff" || (row.revokedAt === null && !accessEnded)))
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
                revoked: row.revokedAt !== null || accessEnded,
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
