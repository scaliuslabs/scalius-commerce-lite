// The post-write flush: only the core events and plugin persistence modules,
// no representations or plugin host, so the middleware's lazy import stays
// small. It also tells the realtime hub what moved (realtime/publish.ts).
import type { Database } from "@scalius/database/client";
import {
  flushPendingEventOutbox,
  type EventFlushResult,
  type EventsQueue,
  type OutboxEvent,
} from "@scalius/core/modules/events";
import type { RealtimeChange, RealtimeTopic } from "@scalius/shared/realtime";
import { changesForEvent, publishRealtime, tableChanges } from "../realtime/publish";
import { API_EVENT_FAN_OUT_TARGETS } from "./targets";

/** Events handed to the queue right after a write (the scheduled sweep takes the rest). */
export const POST_WRITE_EVENT_FLUSH_LIMIT = 50;

export function eventsQueue(env: Env): EventsQueue | undefined {
  return env.JOBS_QUEUE as unknown as EventsQueue | undefined;
}

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
    /** Table notices still owed when the flush moved no event. */
    finish: async () => {
      if (!published) await publishRealtime(env, extra);
    },
  };
}

/** After a write: hand that write's events to the queue (or settle them when nobody listens). */
export async function flushEventsAfterWrite(
  db: Database,
  env: Env,
  options: { tableTopics?: Iterable<RealtimeTopic> } = {},
): Promise<EventFlushResult> {
  const realtime = realtimeFlushObserver(env, options.tableTopics);
  try {
    return await flushPendingEventOutbox({
      db,
      queue: eventsQueue(env),
      targets: API_EVENT_FAN_OUT_TARGETS,
      limit: POST_WRITE_EVENT_FLUSH_LIMIT,
      onFlushed: realtime.onFlushed,
    });
  } finally {
    await realtime.finish();
  }
}
