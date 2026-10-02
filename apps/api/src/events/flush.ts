// The post-write flush: only the core events module, no representations, so
// the middleware's lazy import stays small.
import type { Database } from "@scalius/database/client";
import {
  EVENT_FAN_OUT_TARGETS,
  flushPendingEventOutbox,
  type EventFlushResult,
  type EventsQueue,
} from "@scalius/core/modules/events";

/** Events handed to the queue right after a write (the scheduled sweep takes the rest). */
export const POST_WRITE_EVENT_FLUSH_LIMIT = 50;

export function eventsQueue(env: Env): EventsQueue | undefined {
  return env.JOBS_QUEUE as unknown as EventsQueue | undefined;
}

/** After a write: hand that write's events to the queue (or settle them when nobody listens). */
export async function flushEventsAfterWrite(db: Database, env: Env): Promise<EventFlushResult> {
  return flushPendingEventOutbox({
    db,
    queue: eventsQueue(env),
    targets: EVENT_FAN_OUT_TARGETS,
    limit: POST_WRITE_EVENT_FLUSH_LIMIT,
  });
}
