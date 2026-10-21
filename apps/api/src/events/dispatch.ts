// API-layer wiring of the event outbox (COMMERCE-HOOKS H3): sending webhook
// and app deliveries and the scheduled drain. Core owns the state machines;
// this file supplies the credential key, the sealed representations, the staff
// notice and, for app deliveries, the host. Every step works from a durable
// row (backoff in `next_attempt_at`, terminal `dead_lettered`/`exhausted`), so
// a drain that stops early leaves the rest due for the next tick.

import type { Database } from "@scalius/database/client";
import {
  dispatchPendingEvents,
  listDueWebhookDeliveries,
  processWebhookDelivery,
  pruneEventsAndDeliveries,
  type EventDelivery,
  type EventFlushResult,
} from "@scalius/core/modules/events";
import { sendWebhookDisabledNotice } from "@scalius/core/modules/notifications";
import { planLimits } from "@scalius/shared/plan-limits";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { realtimeFlushObserver } from "./flush";
import { createWebhookRepresentationResolver } from "./representations";
import { appWebhookAccessReader } from "../plugins/webhook-access";
import { API_EVENT_FAN_OUT_TARGETS } from "./targets";

export { EVENT_SOURCE_TABLES } from "./source-tables";
export { flushEventsAfterWrite } from "./flush";

/** Sends deliveries one at a time. Delivery failures are recorded in their rows; only database errors throw. */
export async function sendEventDeliveries(
  db: Database,
  env: Env,
  ctx: ExecutionContext,
  deliveries: readonly EventDelivery[],
): Promise<{ sent: number }> {
  const resolveRepresentation = createWebhookRepresentationResolver(db);
  const appAccess = appWebhookAccessReader(db);
  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  for (const delivery of deliveries) {
    if (delivery.type === "plugins.deliver") {
      const { processPluginEventDelivery } = await import("../plugins/event-delivery");
      const outcome = await processPluginEventDelivery({ db, env, ctx, deliveryId: delivery.deliveryId });
      if (outcome.status === "failed" || outcome.status === "exhausted") {
        // Ids and status only: the app's own error is in its log.
        console.warn(`[plugins] Delivery ${outcome.deliveryId} ${outcome.status}${outcome.retryInSeconds ? `, retry in ${outcome.retryInSeconds}s` : ""}`);
      }
      continue;
    }
    const outcome = await processWebhookDelivery({
      db,
      deliveryId: delivery.deliveryId,
      encryptionKey,
      resolveRepresentation,
      appAccess,
      onSubscriptionDisabled: (subscription) =>
        sendWebhookDisabledNotice(db, env, { subscriptionId: subscription.id, url: subscription.url }),
    });
    if (outcome.status === "failed" || outcome.status === "exhausted") {
      // Ids and status only: never the URL's query, the body or the response.
      console.warn(`[webhooks] Delivery ${outcome.deliveryId} ${outcome.status}${outcome.retryInSeconds ? `, retry in ${outcome.retryInSeconds}s` : ""}`);
    }
  }
  return { sent: deliveries.length };
}

/**
 * The tick's event drain: due events (dispatched, their new deliveries sent),
 * then due webhook and app delivery retries, each within the plan's limits.
 * Retention is `runScheduledEventRetention`.
 */
export async function runScheduledEventMaintenance(db: Database, env: Env, ctx: ExecutionContext): Promise<{
  events: EventFlushResult;
  deliveries: number;
  pluginDeliveries: number;
}> {
  const { listDuePluginEventDeliveries } = await import("@scalius/core/modules/plugins");
  const limits = planLimits().background;
  // Expiries and other sweeps write orders too: the hub hears them as after a request.
  const realtime = realtimeFlushObserver(env);
  const events = await dispatchPendingEvents({
    db,
    targets: API_EVENT_FAN_OUT_TARGETS,
    limit: limits.eventsPerDrain,
    onFlushed: realtime.onFlushed,
  });
  let room = limits.deliveriesPerDrain;
  const fresh = events.deliveries.slice(0, room);
  await sendEventDeliveries(db, env, ctx, fresh);
  room -= fresh.length;
  const webhookIds = room > 0 ? await listDueWebhookDeliveries(db, room) : [];
  await sendEventDeliveries(db, env, ctx, webhookIds.map((deliveryId) => ({ type: "webhooks.deliver" as const, deliveryId })));
  room -= webhookIds.length;
  const pluginIds = room > 0 ? await listDuePluginEventDeliveries(db, room) : [];
  await sendEventDeliveries(db, env, ctx, pluginIds.map((deliveryId) => ({ type: "plugins.deliver" as const, deliveryId })));
  return { events, deliveries: fresh.length + webhookIds.length, pluginDeliveries: pluginIds.length };
}

/** Scheduled sweep: retention of settled events and deliveries (no one is waiting on it, so it rides a slice). */
export async function runScheduledEventRetention(db: Database): Promise<Awaited<ReturnType<typeof pruneEventsAndDeliveries>> & { pluginDeliveries: number }> {
  const { dropExpiredHeldPluginDeliveries, prunePluginEventDeliveries } = await import("@scalius/core/modules/plugins");
  // What apps that are off keep stays inside the plan's bound (their events are kept while they wait).
  await dropExpiredHeldPluginDeliveries(db);
  // Plugin deliveries first: they reference events by id (set null on prune).
  const prunedPluginDeliveries = await prunePluginEventDeliveries(db);
  const pruned = await pruneEventsAndDeliveries(db);
  return { ...pruned, pluginDeliveries: prunedPluginDeliveries };
}
