// Producer side of the realtime hub: the change notices the API sends after a
// write commits. Two sources, both free of database reads:
//
//   1. Event outbox rows, as the flush claims or settles them (the rows it
//      already returns): ids, states and revisions from the catalog facts.
//   2. Tables without events (the inbox and reviews): the write observer of the
//      request or queue message saw the write, so a table-level `changed`.
//
// One RPC to the hub per flush or write, never per row. Failures are dropped:
// the dashboard refetches on reconnect and on focus, and the database stays
// the authority.
import type { OutboxEvent } from "@scalius/core/modules/events";
import type { RealtimeChange, RealtimeTopic } from "@scalius/shared/realtime";
import type { RealtimeHub } from "./hub";

/** The store's one hub (the deployment is one store). */
export const REALTIME_HUB_NAME = "store";

export function realtimeHub(env: Env): DurableObjectStub<RealtimeHub> | null {
  const namespace = env.REALTIME_HUB;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(REALTIME_HUB_NAME));
}

export { REALTIME_TABLE_TOPICS, REALTIME_TABLES } from "./tables";

export function tableChanges(topics: Iterable<RealtimeTopic>): RealtimeChange[] {
  return [...new Set(topics)].map((topic) => ({ topic, kind: "changed" }));
}

/** One outbox event as dashboard notices (ids, states, revisions; never the event's other data). */
export function changesForEvent(event: Pick<OutboxEvent, "topic" | "resourceId" | "facts">): RealtimeChange[] {
  const facts = event.facts as Record<string, unknown>;
  const status = typeof facts.status === "string" ? facts.status : undefined;
  const rev = typeof facts.revision === "number" ? facts.revision : undefined;
  switch (event.topic) {
    case "order.created":
      return [{ topic: "orders", kind: event.topic, id: event.resourceId, ...(status ? { status } : {}) }];
    case "order.updated":
    case "order.cancelled":
    case "order.fulfilled":
      return [{ topic: "orders", kind: event.topic, id: event.resourceId, ...(status ? { status } : {}) }];
    case "order.paid":
    case "order.refunded":
      return [
        { topic: "orders", kind: event.topic, id: event.resourceId },
        { topic: "payments", kind: event.topic, id: event.resourceId },
      ];
    case "return.updated": {
      const orderId = typeof facts.orderId === "string" ? facts.orderId : undefined;
      return [
        { topic: "returns", kind: event.topic, id: event.resourceId, ...(status ? { status } : {}) },
        ...(orderId ? [{ topic: "orders" as const, kind: event.topic, id: orderId }] : []),
      ];
    }
    case "product.created":
    case "product.updated":
    case "product.deleted":
    case "product.publication_changed":
      return [{ topic: "products", kind: event.topic, id: event.resourceId, ...(rev !== undefined ? { rev } : {}) }];
    case "inventory.level_changed": {
      const productId = typeof facts.productId === "string" ? facts.productId : undefined;
      return [{ topic: "inventory", kind: event.topic, id: productId ?? event.resourceId }];
    }
    case "inventory.purchase_order_updated":
    case "inventory.transfer_updated":
      return [{ topic: "inventory", kind: event.topic, id: event.resourceId, ...(rev !== undefined ? { rev } : {}) }];
    case "customer.created":
    case "customer.updated":
    case "customer.consent_changed":
      return [{ topic: "customers", kind: event.topic, id: event.resourceId }];
    default:
      return [];
  }
}

/** Drops exact repeats (a stock burst names one product many times). */
export function dedupeChanges(changes: readonly RealtimeChange[]): RealtimeChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.topic}|${change.kind}|${change.id ?? ""}|${change.rev ?? ""}|${change.status ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Sends notices to the hub: one RPC, never throws. */
export async function publishRealtime(env: Env, changes: readonly RealtimeChange[]): Promise<void> {
  if (changes.length === 0) return;
  const hub = realtimeHub(env);
  if (!hub) return;
  try {
    await hub.publish(dedupeChanges(changes));
  } catch (error) {
    // Ids and status only; the dashboard catches up on reconnect.
    console.warn("[realtime] Publish failed:", error instanceof Error ? error.name : "unknown");
  }
}

/** Staff with an open dashboard, or null when the hub cannot say (then nobody counts as online). */
export async function onlineStaffIds(env: Env): Promise<ReadonlySet<string> | null> {
  const hub = realtimeHub(env);
  if (!hub) return null;
  try {
    return new Set(await hub.online());
  } catch {
    return null;
  }
}
