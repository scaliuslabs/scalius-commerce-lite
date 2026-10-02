// Where an order's stock leaves from (commerce hook H1). Changeable until
// anything has left: the same gate as the customer and delivery details, plus
// nothing deducted and no active ship/pickup fulfilment, checked again inside
// the guarded write. The change and its timeline line commit in one batch.
import { safeBatch, type Database } from "@scalius/database/client";
import { inventoryLocations, orders } from "@scalius/database/schema";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { ConflictError, NotFoundError } from "@scalius/core/errors";
import {
    getDefaultInventoryLocation,
    orderFulfillmentLocationChangeBlockedSql,
    resolveActiveInventoryLocation,
    type InventoryLocationRef,
} from "../../inventory/locations";
import { buildOrderEventInsert, orderEventIdForRequest } from "../timeline";
import { getOrderEditReadiness, orderEditLockMessage } from "./readiness";

export const setOrderFulfillmentLocationSchema = z.object({
    /** An active location, or null for the store default. */
    locationId: z.string().trim().min(1).max(100).nullable(),
    expectedVersion: z.number().int().min(1),
});
export type SetOrderFulfillmentLocationInput = z.infer<typeof setOrderFulfillmentLocationSchema>;

export interface SetOrderFulfillmentLocationResult {
    id: string;
    version: number;
    fulfillmentLocationId: string | null;
    /** The order's previous own location (null = the default). */
    previousFulfillmentLocationId: string | null;
    changed: boolean;
}

/** A location by id whatever its status (an order may still name an archived one). */
async function readLocationRef(db: Database, id: string): Promise<InventoryLocationRef | null> {
    return await db.select({ id: inventoryLocations.id, name: inventoryLocations.name })
        .from(inventoryLocations)
        .where(eq(inventoryLocations.id, id))
        .get() ?? null;
}

export async function setOrderFulfillmentLocation(
    db: Database,
    orderId: string,
    input: SetOrderFulfillmentLocationInput,
    actorId: string | null = null,
): Promise<SetOrderFulfillmentLocationResult> {
    const data = setOrderFulfillmentLocationSchema.parse(input);
    const order = await db.select({
        id: orders.id,
        version: orders.version,
        fulfillmentLocationId: orders.fulfillmentLocationId,
    }).from(orders).where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).get();
    if (!order) throw new NotFoundError("Order not found");
    if (order.version !== data.expectedVersion) {
        throw new ConflictError("This order changed. Reload to see the latest.");
    }
    if (order.fulfillmentLocationId === data.locationId) {
        return {
            id: order.id,
            version: order.version,
            fulfillmentLocationId: order.fulfillmentLocationId,
            previousFulfillmentLocationId: order.fulfillmentLocationId,
            changed: false,
        };
    }
    const readiness = await getOrderEditReadiness(db, orderId);
    if (!readiness?.details.allowed) {
        throw new ConflictError(orderEditLockMessage(readiness?.details.reason ?? null));
    }
    // Where it shipped from and where it ships from now, as the timeline names them.
    const [to, from] = await Promise.all([
        resolveActiveInventoryLocation(db, data.locationId),
        order.fulfillmentLocationId
            ? readLocationRef(db, order.fulfillmentLocationId)
            : getDefaultInventoryLocation(db),
    ]);

    const nextVersion = data.expectedVersion + 1;
    const update = db.update(orders).set({
        fulfillmentLocationId: data.locationId,
        version: sql`${orders.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, data.expectedVersion),
        isNull(orders.deletedAt),
        ne(orders.inventoryAction, "deducted"),
        sql`NOT ${orderFulfillmentLocationChangeBlockedSql(orderId)}`,
        // The location must still be active when the write lands.
        data.locationId
            ? sql`EXISTS (
                SELECT 1 FROM ${inventoryLocations}
                WHERE ${inventoryLocations.id} = ${data.locationId} AND ${inventoryLocations.status} = 'active'
            )`
            : undefined,
    )).returning({ version: orders.version });
    const event = buildOrderEventInsert(db, {
        // One line per order version: a repeat of this change finds it already logged.
        id: await orderEventIdForRequest(orderId, "fulfillment_location_changed", `v${nextVersion}`),
        orderId,
        kind: "fulfillment_location_changed",
        actorId,
        data: {
            fromLocationId: from?.id ?? null,
            fromName: from?.name ?? null,
            toLocationId: to.id,
            toName: to.name,
            // False: the order follows the store default rather than naming a location.
            explicit: data.locationId !== null,
        },
    }, sql`EXISTS (
        SELECT 1 FROM ${orders}
        WHERE ${orders.id} = ${orderId}
          AND ${orders.version} = ${nextVersion}
          AND ${data.locationId === null ? isNull(orders.fulfillmentLocationId) : eq(orders.fulfillmentLocationId, data.locationId)}
    )`);
    const [updated] = await safeBatch(db, [update, event] as const);
    const row = updated[0];
    if (!row) throw new ConflictError("This order changed. Reload to see the latest.");
    return {
        id: orderId,
        version: row.version,
        fulfillmentLocationId: data.locationId,
        previousFulfillmentLocationId: order.fulfillmentLocationId,
        changed: true,
    };
}
