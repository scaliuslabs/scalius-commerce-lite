// Sends one plugin event delivery (docs/platform/PLUGINS.md, "Extension
// points" 1): claims it, hands the event envelope to the plugin through the
// host, and records the outcome. Retries, the dead-letter state and the
// in-flight cap live in the delivery row (@scalius/core/modules/plugins,
// event-deliveries.ts): a drain that finds the row due sends it again.
//
// What a plugin receives: `{ id, topic, apiVersion, occurredAt, resource,
// facts }`, the webhook body without `data` (a plugin reads the current
// resource with `ctx.api`). `id` is the idempotency key: the same event may
// arrive more than once.

import type { Database } from "@scalius/database/client";
import { eventOutbox } from "@scalius/database/schema";
import {
  cancelPluginEventDelivery,
  claimPluginEventDelivery,
  completePluginEventDelivery,
  failPluginEventDelivery,
  getPluginInstallation,
  holdPluginEventDelivery,
  releasePluginEventDelivery,
} from "@scalius/core/modules/plugins";
import { toOutboxEvent, type OutboxEvent } from "@scalius/core/modules/events";
import { EVENTS_API_VERSION, topicMatchesAnyFilter } from "@scalius/shared/events";
import type { PluginEvent } from "@scalius/plugin-sdk";
import { eq } from "drizzle-orm";
import type { PluginHostOptions } from "./host";

/** A delivery the host just updated in place is sent again after this long. */
const OUTDATED_RETRY_SECONDS = 5;

export type PluginDeliveryOutcome =
  | { status: "succeeded" | "cancelled" | "busy" | "released" | "held"; deliveryId: string; retryInSeconds: number | null }
  | { status: "failed" | "exhausted"; deliveryId: string; retryInSeconds: number | null }
  | { status: "skipped"; deliveryId: string; reason: "missing" | "not_due" };

/** The envelope a plugin's event handler receives. */
export function pluginEventEnvelope(event: OutboxEvent): PluginEvent {
  return {
    id: event.id,
    topic: event.topic,
    apiVersion: EVENTS_API_VERSION,
    occurredAt: new Date(event.occurredAt * 1000).toISOString(),
    resource: { type: event.resourceType, id: event.resourceId },
    facts: event.facts as Record<string, unknown>,
  };
}

export async function processPluginEventDelivery(options: {
  db: Database;
  env: Env;
  ctx: ExecutionContext;
  deliveryId: string;
  /** Test seam (the host's loader choice). */
  loaderFor?: PluginHostOptions["loaderFor"];
}): Promise<PluginDeliveryOutcome> {
  const { db, env, deliveryId } = options;
  const claim = await claimPluginEventDelivery(db, deliveryId);
  if (claim.status === "skipped") return { status: "skipped", deliveryId, reason: claim.reason };
  if (claim.status === "busy") {
    // The plugin has as many deliveries in flight as it may: the row stays
    // due and the next drain sends it.
    return { status: "busy", deliveryId, retryInSeconds: null };
  }
  const { delivery, claimId } = claim;

  const [installation, eventRow] = await Promise.all([
    getPluginInstallation(db, delivery.pluginId),
    delivery.eventId ? db.select().from(eventOutbox).where(eq(eventOutbox.id, delivery.eventId)).get() : Promise.resolve(undefined),
  ]);
  // Only an uninstall or a grant that no longer covers the topic ends a
  // delivery; an app that is off keeps it until it runs again (held).
  if (!installation || !installation.grant || !topicMatchesAnyFilter(delivery.topic as never, installation.grant.events)) {
    await cancelPluginEventDelivery(db, delivery, claimId, installation ? "The app no longer receives this event." : "The app was uninstalled.");
    return { status: "cancelled", deliveryId, retryInSeconds: null };
  }
  if (installation.status !== "active") {
    await holdPluginEventDelivery(db, delivery, claimId);
    return { status: "held", deliveryId, retryInSeconds: null };
  }
  const event = eventRow ? toOutboxEvent(eventRow) : null;
  if (!event) {
    await cancelPluginEventDelivery(db, delivery, claimId, eventRow ? "The event could not be read." : "The event was pruned.");
    return { status: "cancelled", deliveryId, retryInSeconds: null };
  }

  const { PluginHost } = await import("./host");
  const host = new PluginHost({ env, ctx: options.ctx, db, ...(options.loaderFor ? { loaderFor: options.loaderFor } : {}) });
  const started = Date.now();
  const outcome = await host.invokeEvent(installation, pluginEventEnvelope(event));
  const durationMs = Date.now() - started;
  if (outcome.ok) {
    await completePluginEventDelivery(db, delivery, claimId, { durationMs });
    if (delivery.topic === "order.created" && installation.grant.scopes.includes("write_orders")) {
      // This app may have held the order; its automatic lines waited for it
      // (fulfilment/hold-window.ts) and go out now unless it did.
      const { autoFulfilAfterResponse } = await import("../background/auto-fulfil");
      await autoFulfilAfterResponse({ env, executionCtx: options.ctx }, db, delivery.resourceId, "app hold window");
    }
    return { status: "succeeded", deliveryId, retryInSeconds: null };
  }
  if (outcome.failure === "outdated") {
    // The host just brought the installation in step with the deployed
    // code: not the plugin's attempt. The next one runs the new version.
    await releasePluginEventDelivery(db, delivery, claimId, { delaySeconds: OUTDATED_RETRY_SECONDS, reason: outcome.error ?? "The app was updated." });
    return { status: "released", deliveryId, retryInSeconds: OUTDATED_RETRY_SECONDS };
  }
  if (outcome.failure === "inactive") {
    await holdPluginEventDelivery(db, delivery, claimId);
    return { status: "held", deliveryId, retryInSeconds: null };
  }
  const failed = await failPluginEventDelivery(db, delivery, claimId, { error: outcome.error ?? "The app failed.", durationMs });
  return { status: failed.status, deliveryId, retryInSeconds: failed.retryInSeconds };
}
