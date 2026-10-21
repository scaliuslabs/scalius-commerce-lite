// Held event deliveries (event-deliveries.ts, "Held"): the marker and the
// release, a leaf both the delivery pipeline and the installation writes use.
import type { Database } from "@scalius/database/client";
import { pluginEventDeliveries } from "@scalius/database/schema";
import { and, eq, gte, sql } from "drizzle-orm";

/** A held delivery's next attempt: none until its app runs again. */
export const HELD_UNTIL = 253_402_300_799;

/**
 * The statement that makes an app's held deliveries due, for the batch that
 * makes the app active again (activation, an approved or narrower update, a
 * restored release). They drain oldest first under the in-flight cap.
 */
export function releaseHeldPluginDeliveriesStatement(db: Database, pluginId: string) {
  return db.update(pluginEventDeliveries).set({
    nextAttemptAt: sql`unixepoch()`,
    lastError: null,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(pluginEventDeliveries.pluginId, pluginId),
    eq(pluginEventDeliveries.status, "pending"),
    gte(pluginEventDeliveries.nextAttemptAt, HELD_UNTIL),
  ));
}
