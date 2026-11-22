// App event deliveries' queue declaration and their held marker and release
// (event-deliveries.ts, "Held"): a leaf both the delivery pipeline and the
// installation writes use.
import type { Database } from "@scalius/database/client";
import { pluginEventDeliveries } from "@scalius/database/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { leasedQueue, NEVER_DUE } from "../../utils/leased-queue";
import { maskPluginLogText } from "./logs";

export const PLUGIN_DELIVERY_MAX_ATTEMPTS = 8;

/** App event deliveries on the queue kernel (utils/leased-queue.ts). */
export const PLUGIN_DELIVERY_QUEUE = leasedQueue(pluginEventDeliveries, {
  name: "app event delivery",
  states: { waiting: "pending", running: "processing", retrying: "failed", done: "succeeded", givenUp: "exhausted", cancelled: "cancelled" },
  base: "pd",
  /** A claim outlives the longest invocation (30 s wall time) with room for the bridge. */
  leaseSeconds: 120,
  maxAttempts: PLUGIN_DELIVERY_MAX_ATTEMPTS,
  /** The same 7 waits over about 22.6 hours as webhooks. */
  backoff: [60, 300, 1_800, 3_600, 10_800, 21_600, 43_200],
  doneAt: "deliveredAt",
  errorLength: 500,
  // An app's error is its own text: masked like its log.
  describeError: (text) => maskPluginLogText(text).trim() || "The delivery failed.",
  cancels: true,
  releases: true,
  holds: true,
  staffRetry: true,
});

/** A held delivery's next attempt: none until its app runs again. */
export const HELD_UNTIL = NEVER_DUE;

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
