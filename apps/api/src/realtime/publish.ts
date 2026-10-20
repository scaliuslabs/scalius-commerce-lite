// Producer side of the realtime hub: the change notices the API sends after a
// write commits. Two sources, both free of database reads:
//
//   1. Event outbox rows, as the flush dispatches them (the rows it
//      already returns): ids, states and revisions from the catalog facts.
//   2. Table changes, including topics without event demand: the write observer of the
//      request or background run saw the write, so a table-level `changed`.
//
// One RPC to the hub per flush or write, never per row. Failures are dropped:
// the dashboard refetches on reconnect and on focus, and the database stays
// the authority.
import type { OutboxEvent } from "@scalius/core/modules/events";
import { REALTIME_HUB_NAME, type RealtimeChange, type RealtimeTopic } from "@scalius/shared/realtime";
import type { RealtimeHub } from "./hub";

export { REALTIME_HUB_NAME };

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
    case "variant.inventory_changed": {
      const productId = typeof facts.productId === "string" ? facts.productId : undefined;
      return [{ topic: "inventory", kind: event.topic, id: productId ?? event.resourceId }];
    }
    case "purchase_order.updated":
    case "inventory_transfer.updated":
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
