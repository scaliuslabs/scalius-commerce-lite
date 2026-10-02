import type { MiddlewareHandler } from "hono";
import type { Database } from "@scalius/database/client";
import { runWithReadObserver, type ReadObserver } from "@scalius/database/read-observer";
import { EVENT_SOURCE_TABLES } from "../events/source-tables";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WRITE_STATEMENT = /^\s*(?:WITH\b[\s\S]*?\b)?(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

/**
 * Notes whether a request wrote a table that fires event triggers. The
 * database transports report each statement's tables; for event source
 * tables they also hand over the SQL, so only writes count, never reads.
 */
export function createEventWriteObserver(): ReadObserver & { readonly wrote: boolean } {
  let wrote = false;
  return {
    get wrote() {
      return wrote;
    },
    valueTables: EVENT_SOURCE_TABLES,
    observeTables() {},
    observeBoundStatement(_tables, sql) {
      if (!wrote && WRITE_STATEMENT.test(sql)) wrote = true;
    },
  };
}

/**
 * "After commit the writer enqueues" (COMMERCE-HOOKS H3) for every route at
 * once: a mutating request that wrote an evented table hands the new outbox
 * rows to the queue after its response (one indexed read when nothing is
 * due; nothing at all for requests that wrote no evented table). The
 * scheduled sweep remains the at-least-once backstop.
 */
export const eventDispatchMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (READ_METHODS.has(c.req.method)) return next();
  const observer = createEventWriteObserver();
  await runWithReadObserver(observer, () => next());
  if (!observer.wrote) return;
  const db = c.get("db") as Database | undefined;
  if (!db) return;
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    const executionCtx = c.executionCtx;
    waitUntil = (promise) => executionCtx.waitUntil(promise);
  } catch {
    return; // No execution context (tests): the scheduled sweep dispatches.
  }
  const env = c.env;
  waitUntil(
    import("../events/flush").then(({ flushEventsAfterWrite }) => flushEventsAfterWrite(db, env)).catch((error: unknown) => {
      console.warn("[events] Post-write flush failed; the scheduled sweep retries:", error instanceof Error ? error.message : "unknown error");
    }),
  );
};
