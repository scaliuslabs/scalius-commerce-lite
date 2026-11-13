// API-layer wiring of the event outbox (COMMERCE-HOOKS H3): sending webhook
// and app deliveries and the scheduled drain. Core owns the state machines;
// this file supplies the credential key, the sealed representations, the staff
// notice and, for app deliveries, the host. Every step works from a durable
// row (backoff in `next_attempt_at`, terminal `dead_lettered`/`exhausted`), so
// a drain that stops early leaves the rest due for the next tick.
//
// A pass sends a few deliveries at once (`DELIVERY_CONCURRENCY`), one endpoint
// (a webhook subscription, an app) at a time per endpoint, so one slow endpoint
// holds one slot and never the others' turn. A delivery starts only while it can
// finish inside the pass (`DELIVERY_PASS_MS`, inside the 30 s a Worker keeps
// working after its response): the rest stay unclaimed and due for the next
// drain, never cut off mid-flight. A webhook endpoint that fails a send (a
// timeout, an error status) gets nothing more in that pass, and its other due
// rows wait out its backoff (not attempted, so not counted per row; the send
// counted against the endpoint, which a day of failures disables), so they do
// not head the next drain's list; the list itself reads a bounded slice and
// takes endpoints in turn (`listDueWebhookDeliveries`). Delivery stays at least once,
// signed and retried with backoff by its row; nothing promises an order across
// deliveries.

import { safeBatch, type Database } from "@scalius/database/client";
import { pluginEventDeliveries, webhookDeliveries } from "@scalius/database/schema";
import { inArray } from "drizzle-orm";
import {
  deferDueEndpointDeliveries,
  dispatchPendingEvents,
  listDueWebhookDeliveryTargets,
  processWebhookDelivery,
  pruneEventsAndDeliveries,
  WEBHOOK_REQUEST_TIMEOUT_MS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
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

/** A delivery to send, with its endpoint when the list already knows it (`webhook:<subscription>`). */
export type PassDelivery = EventDelivery & { endpoint?: string };

/** Deliveries a pass sends at once (each to a different endpoint). */
export const DELIVERY_CONCURRENCY = 4;
/**
 * How long a pass keeps starting deliveries: a delivery started at its end may
 * still take its full request timeout and its row writes inside the 30 s a
 * Worker keeps working after the response.
 */
export const DELIVERY_PASS_MS = 30_000 - WEBHOOK_REQUEST_TIMEOUT_MS - 5_000;
/** Ids per endpoint read (D1 binds at most 100 values). */
const ENDPOINT_READ_CHUNK = 90;

/** When a pass that starts now stops starting deliveries (epoch ms). */
export function deliveryPassDeadline(now = Date.now()): number {
  return now + DELIVERY_PASS_MS;
}

/**
 * Each delivery's endpoint (`webhook:<subscription>`, `app:<id>`), read in one
 * round trip, only when the pass has more deliveries than slots: below that
 * every delivery has a slot of its own and the read would buy nothing.
 */
async function endpointsOf(db: Database, all: readonly PassDelivery[]): Promise<Map<string, string>> {
  const endpoints = new Map<string, string>();
  // Deliveries the due list named already carry their endpoint.
  const deliveries = all.filter((delivery) => delivery.endpoint === undefined);
  if (all.length <= DELIVERY_CONCURRENCY || deliveries.length === 0) return endpoints;
  const webhookIds = deliveries.filter((delivery) => delivery.type === "webhooks.deliver").map((delivery) => delivery.deliveryId);
  const pluginIds = deliveries.filter((delivery) => delivery.type === "plugins.deliver").map((delivery) => delivery.deliveryId);
  const reads = [
    ...chunks(webhookIds).map((ids) => db.select({ id: webhookDeliveries.id, endpoint: webhookDeliveries.subscriptionId }).from(webhookDeliveries).where(inArray(webhookDeliveries.id, ids))),
    ...chunks(pluginIds).map((ids) => db.select({ id: pluginEventDeliveries.id, endpoint: pluginEventDeliveries.pluginId }).from(pluginEventDeliveries).where(inArray(pluginEventDeliveries.id, ids))),
  ];
  if (reads.length === 0) return endpoints;
  const webhookReads = chunks(webhookIds).length;
  const results = await safeBatch(db, reads as never) as Array<Array<{ id: string; endpoint: string | null }>>;
  results.forEach((rows, index) => {
    for (const row of rows) endpoints.set(row.id, `${index < webhookReads ? "webhook" : "app"}:${row.endpoint ?? row.id}`);
  });
  return endpoints;
}

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let index = 0; index < ids.length; index += ENDPOINT_READ_CHUNK) out.push(ids.slice(index, index + ENDPOINT_READ_CHUNK));
  return out;
}

/**
 * Sends deliveries a few at a time, one per endpoint at once, starting each only
 * before `deadline` (see the file comment). Returns how many it started; the
 * rest stay due for the next drain. Delivery failures are recorded in their
 * rows; only database errors throw.
 */
export async function sendEventDeliveries(
  db: Database,
  env: Env,
  ctx: ExecutionContext,
  deliveries: readonly PassDelivery[],
  deadline: number = deliveryPassDeadline(),
): Promise<{ sent: number }> {
  if (deliveries.length === 0) return { sent: 0 };
  // A checkout carries its signed recovery link (the store URL and the master secret sign it).
  const resolveRepresentation = createWebhookRepresentationResolver(db, { env, storefrontUrl: env.STOREFRONT_URL });
  const appAccess = appWebhookAccessReader(db);
  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const endpoints = await endpointsOf(db, deliveries);
  // One lane per endpoint, in the order the drain listed them; a delivery without a known endpoint is its own.
  const lanes = new Map<string, EventDelivery[]>();
  for (const delivery of deliveries) {
    const key = delivery.endpoint ?? endpoints.get(delivery.deliveryId) ?? `delivery:${delivery.deliveryId}`;
    const lane = lanes.get(key);
    if (lane) lane.push(delivery);
    else lanes.set(key, [delivery]);
  }
  const waiting = [...lanes.values()];
  let sent = 0;
  // Each worker takes the next endpoint with deliveries left and sends that endpoint's deliveries in turn.
  const worker = async () => {
    for (let lane = waiting.shift(); lane; lane = waiting.shift()) {
      for (const delivery of lane) {
        if (Date.now() >= deadline) return;
        sent += 1;
        // An endpoint that failed a send gets nothing more this pass.
        if (await sendOne(delivery) === "unhealthy") break;
      }
    }
  };
  const sendOne = async (delivery: PassDelivery): Promise<"unhealthy" | void> => {
    if (delivery.type === "plugins.deliver") {
      const { processPluginEventDelivery } = await import("../plugins/event-delivery");
      const outcome = await processPluginEventDelivery({ db, env, ctx, deliveryId: delivery.deliveryId });
      if (outcome.status === "failed" || outcome.status === "exhausted") {
        // Ids and status only: the app's own error is in its log.
        console.warn(`[plugins] Delivery ${outcome.deliveryId} ${outcome.status}${outcome.retryInSeconds ? `, retry in ${outcome.retryInSeconds}s` : ""}`);
      }
      return;
    }
    // Whether the endpoint itself was reached (a platform fault before the send is not the endpoint's).
    let reached = false;
    const outcome = await processWebhookDelivery({
      db,
      deliveryId: delivery.deliveryId,
      encryptionKey,
      resolveRepresentation,
      appAccess,
      fetch: (input, init) => {
        reached = true;
        return fetch(input, init);
      },
      onSubscriptionDisabled: (subscription) =>
        sendWebhookDisabledNotice(db, env, { subscriptionId: subscription.id, url: subscription.url }),
    });
    if (outcome.status === "failed" || outcome.status === "exhausted") {
      // Ids and status only: never the URL's query, the body or the response.
      console.warn(`[webhooks] Delivery ${outcome.deliveryId} ${outcome.status}${outcome.retryInSeconds ? `, retry in ${outcome.retryInSeconds}s` : ""}`);
    }
    if (reached && (outcome.status === "failed" || outcome.status === "exhausted")) {
      // Its other due rows wait out its backoff: they would only fail too, and head every drain.
      if (!outcome.subscriptionDisabled) await deferDueEndpointDeliveries(db, delivery.deliveryId, outcome.retryInSeconds ?? WEBHOOK_RETRY_DELAYS_SECONDS[0]);
      return "unhealthy";
    }
  };
  await Promise.all(Array.from({ length: Math.min(DELIVERY_CONCURRENCY, lanes.size) }, worker));
  return { sent };
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
  // One pass: the three sends share its deadline.
  const deadline = deliveryPassDeadline();
  let room = limits.deliveriesPerDrain;
  const fresh = events.deliveries.slice(0, room);
  const freshSent = (await sendEventDeliveries(db, env, ctx, fresh, deadline)).sent;
  room -= fresh.length;
  const webhookIds = room > 0 && Date.now() < deadline ? await listDueWebhookDeliveryTargets(db, room) : [];
  const webhooksSent = (await sendEventDeliveries(db, env, ctx, webhookIds.map((row) => ({
    type: "webhooks.deliver" as const,
    deliveryId: row.id,
    endpoint: `webhook:${row.subscriptionId}`,
  })), deadline)).sent;
  room -= webhookIds.length;
  const pluginIds = room > 0 && Date.now() < deadline ? await listDuePluginEventDeliveries(db, room) : [];
  const pluginsSent = (await sendEventDeliveries(db, env, ctx, pluginIds.map((deliveryId) => ({ type: "plugins.deliver" as const, deliveryId })), deadline)).sent;
  return { events, deliveries: freshSent + webhooksSent, pluginDeliveries: pluginsSent };
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
