// The post-write drain: only the core events and plugin persistence modules,
// no representations or plugin host, so the middleware's lazy import stays
// small while nobody listens. Deliveries the dispatched events recorded are
// sent by events/dispatch.ts, loaded only then. It also tells the realtime
// hub what moved (realtime/publish.ts).
import type { Database } from "@scalius/database/client";
import {
  dispatchPendingEvents,
  type EventFlushResult,
  type OutboxEvent,
} from "@scalius/core/modules/events";
import { planLimits } from "@scalius/shared/plan-limits";
import type { RealtimeChange, RealtimeTopic } from "@scalius/shared/realtime";
import { changesForEvent, publishRealtime, tableChanges } from "../realtime/publish";
import { API_EVENT_FAN_OUT_TARGETS } from "./targets";

/** Flush observer that sends the moved events to the realtime hub, with any table-level notices, in one RPC. */
export function realtimeFlushObserver(env: Env, tableTopics: Iterable<RealtimeTopic> = []) {
  const extra = tableChanges(tableTopics);
  let published = false;
  const publish = async (events: readonly OutboxEvent[]) => {
    published = true;
    const changes: RealtimeChange[] = [...extra, ...events.flatMap(changesForEvent)];
    await publishRealtime(env, changes);
  };
  return {
    onFlushed: publish,
    /** Table notices still owed when the drain moved no event. */
    finish: async () => {
      if (!published) await publishRealtime(env, extra);
    },
  };
}

/**
 * After a write: dispatch subscribed events and send the deliveries they
 * recorded, within this plan's drain
 * limits. The scheduled tick takes whatever is left.
 */
export async function flushEventsAfterWrite(
  db: Database,
  env: Env,
  ctx: ExecutionContext,
  options: { tableTopics?: Iterable<RealtimeTopic> } = {},
): Promise<EventFlushResult> {
  const realtime = realtimeFlushObserver(env, options.tableTopics);
  try {
    const result = await dispatchPendingEvents({
      db,
      targets: API_EVENT_FAN_OUT_TARGETS,
      limit: planLimits().background.eventsPerDrain,
      onFlushed: realtime.onFlushed,
    });
    if (result.deliveries.length > 0) {
      const { sendEventDeliveries } = await import("./dispatch");
      await sendEventDeliveries(db, env, ctx, result.deliveries.slice(0, planLimits().background.deliveriesPerDrain));
    }
    return result;
  } finally {
    await realtime.finish();
  }
}
