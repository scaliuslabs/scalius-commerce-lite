import { and, eq, sql } from "drizzle-orm";
import { orders } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";

export async function rollbackOrderStatusIfInventoryUnchanged(
    db: Database,
    params: {
        orderId: string;
        previousStatus: string;
        claimedStatus: string;
        claimedVersion: number;
        previousInventoryAction: string;
    },
): Promise<void> {
    await db.update(orders).set({
        status: params.previousStatus,
        version: sql`${orders.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, params.orderId),
        eq(orders.status, params.claimedStatus),
        eq(orders.version, params.claimedVersion),
        eq(orders.inventoryAction, params.previousInventoryAction),
    ));
}
