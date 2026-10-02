// API-layer wiring of the event outbox (COMMERCE-HOOKS H3): the flush after
// writes, the two queue message handlers and the scheduled sweep. Core owns
// the state machines; this file supplies the queue, the credential key, the
// admin representations and the staff notice.

import type { Database } from "@scalius/database/client";
import {
  EVENT_FAN_OUT_TARGETS,
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
import { eventsQueue } from "./flush";
import { createWebhookRepresentationResolver } from "./representations";

export { EVENT_SOURCE_TABLES } from "./source-tables";
export { flushEventsAfterWrite, POST_WRITE_EVENT_FLUSH_LIMIT } from "./flush";

export function isEventsQueueMessage(payload: { type?: unknown }): payload is EventsQueueMessage {
  return payload.type === "events.dispatch" || payload.type === "webhooks.deliver";
}

/**
 * `events.dispatch` and `webhooks.deliver`. Delivery failures are recorded
 * and retried by the events pipeline itself (backoff in the row), so the
 * message is acked; only infrastructure errors throw for a queue retry.
 */
export async function processEventsQueueMessage(
  payload: EventsQueueMessage,
  db: Database,
  env: Env,
): Promise<void> {
  if (payload.type === "events.dispatch") {
    const outcome = await processEventDispatch({
      db,
      eventId: payload.eventId,
      targets: EVENT_FAN_OUT_TARGETS,
      queue: eventsQueue(env),
    });
    if (outcome.status === "failed" || outcome.status === "dead_lettered") {
      console.warn(`[events] Dispatch of ${outcome.eventId} ${outcome.status}: ${outcome.reason}`);
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

/** Scheduled sweep: due events, due delivery retries, then retention. */
export async function runScheduledEventMaintenance(db: Database, env: Env): Promise<{
  events: EventFlushResult;
  deliveries: Awaited<ReturnType<typeof flushDueWebhookDeliveries>>;
  pruned: Awaited<ReturnType<typeof pruneEventsAndDeliveries>>;
}> {
  const events = await flushPendingEventOutbox({
    db,
    queue: eventsQueue(env),
    targets: EVENT_FAN_OUT_TARGETS,
    limit: MAX_EVENT_FLUSH_LIMIT,
  });
  const deliveries = await flushDueWebhookDeliveries({ db, queue: eventsQueue(env), limit: MAX_DELIVERY_FLUSH_LIMIT });
  const pruned = await pruneEventsAndDeliveries(db);
  return { events, deliveries, pruned };
}
