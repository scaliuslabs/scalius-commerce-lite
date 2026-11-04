import { eventOutbox } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Capture inside the subscription INSERT / first-approval UPDATE, alongside
 * its start timestamp. Seconds cannot order events inside that second, and
 * event ids have random suffixes: remember the identities already committed.
 * The occurred_at index bounds the read to the current second (and future
 * dates, if any). Its size follows that window's traffic, not a row cap: a
 * cap would silently allow historical events beyond it through the fence.
 */
export function captureEventStartExclusions(): SQL {
  return sql`(SELECT json_group_array(${eventOutbox.id}) FROM ${eventOutbox}
    WHERE ${eventOutbox.occurredAt} >= unixepoch())`;
}

/**
 * The same durable subscription-start test for webhook and app fan-out. The
 * event is a literal one, or a drain's event row (`drainEventsSource`).
 */
export function eventAfterSubscriptionStart(
  event: { id: string | SQL; occurredAt: number | SQL },
  startedAt: AnySQLiteColumn,
  exclusions: AnySQLiteColumn,
): SQL {
  return sql`${startedAt} <= ${event.occurredAt} AND NOT EXISTS (
    SELECT 1 FROM json_each(${exclusions}) WHERE CAST(value AS TEXT) = ${event.id}
  )`;
}

/** The events of one drain as a fan-out read joins them: one bound JSON value (`drain_event`). */
export function drainEventsSource(events: ReadonlyArray<{ id: string; topic: string; occurredAt: number }>): SQL {
  const rows = events.map((event) => ({
    i: event.id,
    t: event.topic,
    // A subscriber to `<resource>.*` takes every topic of the resource.
    p: `${event.topic.split(".", 1)[0]}.*`,
    o: event.occurredAt,
  }));
  return sql`json_each(${JSON.stringify(rows)}) AS drain_event`;
}

/** One field of the joined drain event: its id, topic, resource filter or occurrence time. */
export const drainEvent = {
  id: sql<string>`CAST(json_extract(drain_event.value, '$.i') AS TEXT)`,
  topic: sql<string>`CAST(json_extract(drain_event.value, '$.t') AS TEXT)`,
  resourceFilter: sql<string>`CAST(json_extract(drain_event.value, '$.p') AS TEXT)`,
  occurredAt: sql<number>`CAST(json_extract(drain_event.value, '$.o') AS INTEGER)`,
} as const;
