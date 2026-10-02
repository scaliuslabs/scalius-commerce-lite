/**
 * Queue lanes. Cloudflare Queues has one queue per binding and no priorities:
 * a message waits behind every message in front of it. Scalius keeps one
 * `jobs` queue (a store gets exactly one) and makes two lanes out of it:
 *
 * - urgent: OTP delivery, payment events, order and staff notifications,
 *   automatic fulfilment, event/webhook/plugin delivery. A buyer or merchant is
 *   waiting on these.
 * - bulk: rendition and catalogue fan-out (`media.render_variants`,
 *   `catalog.recommendations.refresh`, `catalog.projections.rebuild`). Work
 *   that can take hours and is recomputed from D1 if it is dropped.
 *
 * The lanes hold because bulk producers never put more in the queue than the
 * plan's bulk backlog limit (`bulkQueueCapacity`: the queue's own backlog, read
 * with `metrics()`, bounds what they may add), so an urgent message waits behind
 * a bounded handful of bulk jobs, never a thousand; because a consumer
 * invocation handles urgent messages first (`queueLaneOrder`); and because an
 * OTP whose queue handoff fails is delivered directly (`enqueueAuthOtp`).
 */
import { planLimits, type PlanLimits } from "@scalius/shared/plan-limits";

export type QueueLane = "urgent" | "bulk";

const BULK_TYPES: ReadonlySet<string> = new Set([
  "media.render_variants",
  "catalog.recommendations.refresh",
  "catalog.projections.rebuild",
]);

/** The lane of a message by its `type`. An unknown type is urgent: never starve what is not understood. */
export function queueLane(type: unknown): QueueLane {
  return typeof type === "string" && BULK_TYPES.has(type) ? "bulk" : "urgent";
}

/** Indexes of `bodies` with the urgent lane first; each lane keeps its arrival order. */
export function queueLaneOrder(bodies: ReadonlyArray<unknown>): number[] {
  const indexes = bodies.map((_, index) => index);
  const laneOf = (index: number) => queueLane((bodies[index] as { type?: unknown } | null | undefined)?.type) === "urgent" ? 0 : 1;
  return indexes.sort((a, b) => laneOf(a) - laneOf(b) || a - b);
}

type BacklogQueue = { metrics?: () => Promise<{ backlogCount: number }> };

export interface BulkQueueState {
  /** The queue's backlog, or null when it cannot say. */
  backlog: number | null;
  /** How many bulk messages a producer may enqueue now. */
  capacity: number;
}

/**
 * The room the bulk lane has: what is left under the plan's backlog limit, at
 * most one page. A queue that cannot report its backlog (an older binding) is
 * treated as empty, and one that fails to is treated as busy: a bulk page is
 * never worth a guess.
 */
export async function bulkQueueState(
  queue: BacklogQueue | undefined,
  limits: PlanLimits["queue"] = planLimits().queue,
): Promise<BulkQueueState> {
  if (!queue) return { backlog: null, capacity: 0 };
  if (typeof queue.metrics !== "function") return { backlog: null, capacity: limits.bulkPageSize };
  try {
    const { backlogCount } = await queue.metrics();
    if (!Number.isFinite(backlogCount)) return { backlog: null, capacity: 0 };
    const room = limits.bulkBacklogLimit - backlogCount;
    return { backlog: backlogCount, capacity: Math.max(0, Math.min(limits.bulkPageSize, room)) };
  } catch {
    return { backlog: null, capacity: 0 };
  }
}

export async function bulkQueueCapacity(
  queue: BacklogQueue | undefined,
  limits: PlanLimits["queue"] = planLimits().queue,
): Promise<number> {
  return (await bulkQueueState(queue, limits)).capacity;
}
