// API-layer wiring of the event outbox (COMMERCE-HOOKS H3): the flush after
// writes, the queue message handlers and the scheduled sweep. Core owns the
// state machines; this file supplies the queue, the credential key, the admin
// representations, the staff notice and, for plugin deliveries, the host.

import type { Database } from "@scalius/database/client";
import {
  MAX_DELIVERY_FLUSH_LIMIT,
  MAX_EVENT_FLUSH_LIMIT,
  flushDueWebhookDeliveries,
  flushPendingEventOutbox,
  processEventDispatch,
  processWebhookDelivery,
  pruneEventsAndDeliveries,
  type EventFlushResult,
  type EventsQueueMessage,
} from "@scalius/core/modules/events";
import { sendWebhookDisabledNotice } from "@scalius/core/modules/notifications";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { eventsQueue, realtimeFlushObserver } from "./flush";
import { createWebhookRepresentationResolver } from "./representations";
import { API_EVENT_FAN_OUT_TARGETS } from "./targets";

export { EVENT_SOURCE_TABLES } from "./source-tables";
export { flushEventsAfterWrite, POST_WRITE_EVENT_FLUSH_LIMIT } from "./flush";

export function isEventsQueueMessage(payload: { type?: unknown }): payload is EventsQueueMessage {
  return payload.type === "events.dispatch" || payload.type === "webhooks.deliver" || payload.type === "plugins.deliver";
}

/**
 * `events.dispatch`, `webhooks.deliver` and `plugins.deliver`. Delivery
 * failures are recorded and retried by the events pipeline itself (backoff in
 * the row), so the message is acked; only infrastructure errors throw for a
 * queue retry.
 */
export async function processEventsQueueMessage(
  payload: EventsQueueMessage,
  db: Database,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  if (payload.type === "events.dispatch") {
    const outcome = await processEventDispatch({
      db,
      eventId: payload.eventId,
      targets: API_EVENT_FAN_OUT_TARGETS,
      queue: eventsQueue(env),
    });
    if (outcome.status === "failed" || outcome.status === "dead_lettered") {
      console.warn(`[events] Dispatch of ${outcome.eventId} ${outcome.status}: ${outcome.reason}`);
    }
    return;
  }
  if (payload.type === "plugins.deliver") {
    const { processPluginEventDelivery } = await import("../plugins/event-delivery");
    const outcome = await processPluginEventDelivery({ db, env, ctx: ctx ?? detachedExecutionContext(), deliveryId: payload.deliveryId });
    if (outcome.status === "failed" || outcome.status === "exhausted") {
      // Ids and status only: the plugin's own error is in its log.
      console.warn(`[plugins] Delivery ${outcome.deliveryId} ${outcome.status}${outcome.retryInSeconds ? `, retry in ${outcome.retryInSeconds}s` : ""}`);
    }
    return;
  }
  const outcome = await processWebhookDelivery({
    db,
    deliveryId: payload.deliveryId,
    encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
    resolveRepresentation: createWebhookRepresentationResolver(db),
    queue: eventsQueue(env),
    onSubscriptionDisabled: (subscription) =>
      sendWebhookDisabledNotice(db, env, { subscriptionId: subscription.id, url: subscription.url }),
  });
  if (outcome.status === "failed" || outcome.status === "exhausted") {
    // Ids and status only: never the URL's query, the body or the response.
    console.warn(`[webhooks] Delivery ${outcome.deliveryId} ${outcome.status}${outcome.retryInSeconds ? `, retry in ${outcome.retryInSeconds}s` : ""}`);
  }
}

/** Tests and callers without a context: background work is awaited by nobody. */
function detachedExecutionContext(): ExecutionContext {
  return { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
}

/** Scheduled sweep: due events and due webhook and plugin delivery retries. Retention is `runScheduledEventRetention`. */
export async function runScheduledEventMaintenance(db: Database, env: Env): Promise<{
  events: EventFlushResult;
  deliveries: Awaited<ReturnType<typeof flushDueWebhookDeliveries>>;
  pluginDeliveries: { scanned: number; enqueued: number; failed: number; skipped: number };
}> {
  const { flushDuePluginEventDeliveries, MAX_PLUGIN_DELIVERY_FLUSH_LIMIT } = await import("@scalius/core/modules/plugins");
  // Expiries and other sweeps write orders too: the hub hears them as after a request.
  const realtime = realtimeFlushObserver(env);
  const events = await flushPendingEventOutbox({
    db,
    queue: eventsQueue(env),
    targets: API_EVENT_FAN_OUT_TARGETS,
    limit: MAX_EVENT_FLUSH_LIMIT,
    onFlushed: realtime.onFlushed,
  });
  const deliveries = await flushDueWebhookDeliveries({ db, queue: eventsQueue(env), limit: MAX_DELIVERY_FLUSH_LIMIT });
  const pluginDeliveries = await flushDuePluginEventDeliveries({ db, queue: eventsQueue(env), limit: MAX_PLUGIN_DELIVERY_FLUSH_LIMIT });
  return { events, deliveries, pluginDeliveries };
}

/** Scheduled sweep: retention of settled events and deliveries (no one is waiting on it, so it rides a slice). */
export async function runScheduledEventRetention(db: Database): Promise<Awaited<ReturnType<typeof pruneEventsAndDeliveries>> & { pluginDeliveries: number }> {
  const { prunePluginEventDeliveries } = await import("@scalius/core/modules/plugins");
  // Plugin deliveries first: they reference events by id (set null on prune).
  const prunedPluginDeliveries = await prunePluginEventDeliveries(db);
  const pruned = await pruneEventsAndDeliveries(db);
  return { ...pruned, pluginDeliveries: prunedPluginDeliveries };
}
