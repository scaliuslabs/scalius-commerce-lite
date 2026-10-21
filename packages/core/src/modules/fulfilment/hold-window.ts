// The hold window (audit I2): an app's hold (`ctx.orders.hold`) is placed by
// its `order.created` handler, after the order committed. An order paid at
// commit is otherwise handed over in the same invocation, before the app has
// run. So while an app that may hold the order has not seen its
// `order.created` yet, automatic lines wait, at most
// `AUTO_FULFIL_HOLD_WINDOW_SECONDS` after the order was placed; after that the
// sweep hands them over. An app may hold the order when it is active, its
// approved grant carries `write_orders` and receives `order.created`, and it
// was active when the order was placed. Its delivery is done once it
// succeeded, was exhausted or was cancelled; the delivery path runs the order
// again as soon as it succeeds (apps/api/src/plugins/event-delivery.ts).
//
// The window covers the app's first look. A hold that commits while a run is
// already handing over is caught by the run's own batch guard
// (`noOpenOrderHoldCondition` in auto-fulfil.ts): either the hold lands first
// and nothing is handed over, or the handover lands first.
import type { Database } from "@scalius/database/client";
import { eventOutbox, pluginEventDeliveries, pluginInstallations } from "@scalius/database/schema";
import { topicMatchesAnyFilter } from "@scalius/shared/events";
import { and, eq } from "drizzle-orm";

/** How long an order's automatic lines wait for the apps that may hold it. */
export const AUTO_FULFIL_HOLD_WINDOW_SECONDS = 10 * 60;

/** A delivery in one of these states has had its chance to hold the order. */
const SETTLED_DELIVERY_STATUSES: ReadonlySet<string> = new Set(["succeeded", "exhausted", "cancelled"]);

/** The scope and topic that make an app's `order.created` handler able to hold an order. */
export const HOLD_SCOPE = "write_orders";
export const HOLD_TOPIC = "order.created";

/** Whether an approved grant lets an app hold orders from its `order.created` handler. */
export function grantMayHoldOrders(grant: { scopes?: readonly string[]; events?: readonly string[] } | null | undefined): boolean {
  return Boolean(grant?.scopes?.includes(HOLD_SCOPE) && topicMatchesAnyFilter(HOLD_TOPIC, grant.events ?? []));
}

function parseGrant(json: string | null): { scopes?: string[]; events?: string[] } | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as { scopes?: string[]; events?: string[] };
  } catch {
    return null;
  }
}

/**
 * True while an app that may hold the order has not yet finished its
 * `order.created` delivery and the window since `placedAt` (epoch seconds)
 * is open. One indexed read of the active apps; two more only when one of
 * them may hold orders.
 */
export async function awaitingAppHoldDecision(
  db: Database,
  orderId: string,
  placedAt: number,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (now >= placedAt + AUTO_FULFIL_HOLD_WINDOW_SECONDS) return false;
  const installations = await db.select({
    pluginId: pluginInstallations.pluginId,
    grantJson: pluginInstallations.grantJson,
    activatedAt: pluginInstallations.activatedAt,
  }).from(pluginInstallations).where(eq(pluginInstallations.status, "active")).all();
  const holders = installations.filter((installation) =>
    installation.activatedAt !== null
    && installation.activatedAt <= placedAt
    && grantMayHoldOrders(parseGrant(installation.grantJson)));
  if (holders.length === 0) return false;
  const event = await db.select({ id: eventOutbox.id }).from(eventOutbox).where(and(
    eq(eventOutbox.resourceType, "order"),
    eq(eventOutbox.resourceId, orderId),
    eq(eventOutbox.topic, HOLD_TOPIC),
  )).limit(1).get();
  // No event was kept for the order (no demand when it was placed): no app will see it.
  if (!event) return false;
  const deliveries = await db.select({ pluginId: pluginEventDeliveries.pluginId, status: pluginEventDeliveries.status })
    .from(pluginEventDeliveries)
    .where(eq(pluginEventDeliveries.eventId, event.id))
    .all();
  const settled = new Set(deliveries.filter((row) => SETTLED_DELIVERY_STATUSES.has(row.status)).map((row) => row.pluginId));
  return holders.some((holder) => !settled.has(holder.pluginId));
}
