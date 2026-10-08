import type { MiddlewareHandler } from "hono";
import type { Database } from "@scalius/database/client";
import { runWithReadObserver, type ReadObserver } from "@scalius/database/read-observer";
import type { RealtimeTopic } from "@scalius/shared/realtime";
import { EVENT_SOURCE_TABLES } from "../events/source-tables";
import { REALTIME_TABLE_TOPICS } from "../realtime/tables";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITE_STATEMENT = /^\s*(?:WITH\b[\s\S]*?\b)?(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const OBSERVED_TABLES: ReadonlySet<string> = new Set([...EVENT_SOURCE_TABLES, ...Object.keys(REALTIME_TABLE_TOPICS)]);

/**
 * Notes whether a request (or queue message) wrote a table that fires event
 * triggers, and which realtime topics its writes to tables without events
 * touched. The database transports report each statement's tables; for the
 * observed tables they also hand over the SQL, so only writes count.
 */
export function createEventWriteObserver(): ReadObserver & {
  readonly wrote: boolean;
  readonly realtimeTopics: ReadonlySet<RealtimeTopic>;
} {
  let wrote = false;
  const realtimeTopics = new Set<RealtimeTopic>();
  return {
    get wrote() {
      return wrote;
    },
    realtimeTopics,
    valueTables: OBSERVED_TABLES,
    observeTables() {},
    observeBoundStatement(tables, sql) {
      if (!WRITE_STATEMENT.test(sql)) return;
      for (const table of tables) {
        if (EVENT_SOURCE_TABLES.has(table)) wrote = true;
        const topic = REALTIME_TABLE_TOPICS[table];
        if (topic) realtimeTopics.add(topic);
      }
    },
  };
}

/**
 * "After commit the writer enqueues" (COMMERCE-HOOKS H3) for every route at
 * once: a mutating request that wrote an evented table hands the new outbox
 * rows to the queue after its response (one indexed read when nothing is
 * due; nothing at all for requests that wrote no evented table). The
 * scheduled sweep remains the at-least-once backstop. The same flush tells
 * the realtime hub what changed (one RPC, no read); a write to a realtime
 * table without events (inbox, reviews) sends only that notice.
 */
export const eventDispatchMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (READ_METHODS.has(c.req.method)) return next();
  const observer = createEventWriteObserver();
  await runWithReadObserver(observer, () => next());
  const topics = [...observer.realtimeTopics];
  if (!observer.wrote && topics.length === 0) return;
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    const executionCtx = c.executionCtx;
    waitUntil = (promise) => executionCtx.waitUntil(promise);
  } catch {
    return; // No execution context (tests): the scheduled sweep dispatches.
  }
  const env = c.env;
  if (!observer.wrote) {
    waitUntil(
      import("../realtime/publish").then(({ publishRealtime, tableChanges }) => publishRealtime(env, tableChanges(topics))),
    );
    return;
  }
  const db = c.get("db") as Database | undefined;
  if (!db) return;
  waitUntil(
    import("../events/flush").then(({ flushEventsAfterWrite }) => flushEventsAfterWrite(db, env, { tableTopics: topics })).catch((error: unknown) => {
      console.warn("[events] Post-write flush failed; the scheduled sweep retries:", error instanceof Error ? error.message : "unknown error");
    }),
  );
};
