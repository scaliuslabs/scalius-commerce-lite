// Event outbox dispatch (COMMERCE-HOOKS H3). Rows are written only by SQL
// triggers in the domain write's transaction; the API drains them right after
// that write (`waitUntil`) and on every scheduled tick:
//
//   pending ──claim──▶ processing ──targets recorded──▶ dispatched
//      ▲                    │
//      └── failed ◀─────────┤ (backoff in next_attempt_at)
//                           └──▶ dead_lettered (8 attempts)
//
// Delivery is at least once: a drain that dies leaves an expired lease the
// next drain reclaims (until its attempts are spent: queue-claim.ts), and
// every target is idempotent by event id. Event
// triggers only enqueue topics with demand, so an unused store has no rows.

import { safeBatch, type Database } from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { eventOutbox, type EventOutboxRow } from "@scalius/database/schema";
import {
  EVENTS_API_VERSION,
  isEventResourceType,
  isEventTopic,
  parseEventFacts,
  type EventFacts,
  type EventResourceType,
  type EventTopic,
} from "@scalius/shared/events";
import { and, asc, desc, eq, lt, lte, sql, type SQL } from "drizzle-orm";
import { keepsDying, newClaimToken, RUNNER_NEVER_FINISHED } from "../../utils/queue-claim";
import { leasedQueue } from "../../utils/leased-queue";

export const MAX_EVENT_DISPATCH_ATTEMPTS = 8;

/** The event outbox on the queue kernel (utils/leased-queue.ts). */
export const EVENT_QUEUE = leasedQueue(eventOutbox, {
  name: "event",
  states: { waiting: "pending", running: "processing", retrying: "failed", done: "dispatched", givenUp: "dead_lettered" },
  base: "ev",
  leaseSeconds: 5 * 60,
  maxAttempts: MAX_EVENT_DISPATCH_ATTEMPTS,
  /** 30 s doubling: the eighth failure gives up. */
  backoff: [30, 60, 120, 240, 480, 960, 1_920],
  doneAt: "dispatchedAt",
  errorLength: 500,
  capReason: "event_attempt_limit_reached",
});

/**
 * Work a fan-out target recorded for an event: one durable delivery row the
 * API sends next (its own retries live in that row).
 */
export type EventDelivery =
  | { type: "webhooks.deliver"; deliveryId: string }
  | { type: "plugins.deliver"; deliveryId: string };

/** A delivery a fan-out recorded, with the event it is for. */
export type FannedOutDelivery = EventDelivery & { eventId: string };

/** One event as targets see it: the stored facts parsed against the catalog. */
export interface OutboxEvent<T extends EventTopic = EventTopic> {
  id: string;
  topic: T;
  resourceType: EventResourceType;
  resourceId: string;
  facts: EventFacts<T>;
  /** Epoch seconds of the domain write. */
  occurredAt: number;
}

/**
 * A fan-out target: webhooks and app subscribers. `fanOut` records the
 * target's own durable work for one drain's events (idempotent by event id,
 * so a redelivered event adds nothing) and returns the deliveries still
 * waiting. It reads its subscribers once for all the events, whatever their
 * number.
 */
export interface EventFanOutTarget {
  readonly name: string;
  /** Whether this delivery target currently has subscribers. */
  hasSubscribers(db: Database): Promise<boolean>;
  fanOut(db: Database, events: readonly OutboxEvent[]): Promise<FannedOutDelivery[]>;
}

type SQLiteBatchItem = BatchItem<"sqlite">;

/** Due rows one drain may take (the scheduled sweep's ceiling). */
export const MAX_EVENT_FLUSH_LIMIT = 200;
/** Default number of events one drain may take. */
export const EVENT_FLUSH_BATCH_SIZE = 50;

/**
 * The ids of up to `limit` due rows, oldest first: one bounded walk of
 * `event_outbox_due_idx` per retryable state and of `event_outbox_claim_idx`
 * for expired leases, each stopping after `limit`. One `OR` sorted by due
 * time would read every due row first (a backlog of a million events read a
 * million rows on every drain). Ties keep index order.
 */
const DUE_WALKS = [
  { status: EVENT_QUEUE.states.waiting, column: sql.raw(`"next_attempt_at"`) },
  { status: EVENT_QUEUE.states.retrying, column: sql.raw(`"next_attempt_at"`) },
  { status: EVENT_QUEUE.states.running, column: sql.raw(`"claim_expires_at"`) },
] as const;

/** One due state's bounded index walk, oldest first; a lapsed lease only on its first lapse. */
function dueWalk(walk: (typeof DUE_WALKS)[number], limit: number): SQL {
  const firstLapse = walk.status === EVENT_QUEUE.states.running ? sql`AND NOT ${keepsDying(sql.raw(`"claim_id"`), EVENT_QUEUE.base)}` : sql``;
  return sql`SELECT "id", ${walk.column} AS "due" FROM "event_outbox"
    WHERE "status" = ${walk.status} AND ${walk.column} <= unixepoch() ${firstLapse} ORDER BY ${walk.column} LIMIT ${limit}`;
}

/**
 * The rows a drain claims together, oldest due first: pending, failed past
 * its backoff, and a lease on its first lapse (a deploy or a timeout is no
 * reason to single it out). A lapsed row orders by its lease's end, so it
 * takes its turn among fresh rows and never waits behind them.
 */
function batchEventIds(limit: number): SQL {
  const [pending, failed, lease] = DUE_WALKS;
  return sql`SELECT "id" FROM (
    SELECT "id", "due" FROM (${dueWalk(pending, limit)}) AS "pending_due"
    UNION ALL SELECT "id", "due" FROM (${dueWalk(failed, limit)}) AS "failed_due"
    UNION ALL SELECT "id", "due" FROM (${dueWalk(lease, limit)}) AS "lease_due"
  ) AS "due_rows" ORDER BY "due" LIMIT ${limit}`;
}

/**
 * Whether `dispatchPendingEvents` would find a row: its three walks, one row
 * each (the scheduled drain runs only when one finds a row).
 */
export function eventOutboxDueProbes(): SQL[] {
  return DUE_WALKS.map((walk) => dueWalk(walk, 1));
}

export interface EventFlushResult {
  /** The rows this drain claimed (a row another drain holds is never claimed, so never counted). */
  scanned: number;
  dispatched: number;
  /** Claimed rows that failed or were dead-lettered. */
  failed: number;
  /** Always 0 for a drain: it claims only rows it can take (`processEventDispatch` reports a busy or settled row). */
  skipped: number;
  /** The deliveries the dispatched events recorded, for the caller to send. */
  deliveries: EventDelivery[];
}

/**
 * Dispatches up to `limit` due outbox rows, oldest first, in a fixed number of
 * round trips whatever the count: one statement claims them all (a lease on
 * its first lapse among them), each target fans the claimed events out at
 * once, and one batch marks them dispatched (or failed with backoff). With
 * `isolate` (the scheduled drain), a row that lapsed again after a claim took
 * it back is claimed alone, in slots of its own each tick, least tried
 * first: a poison event that kills every drain it is in dies alone, so only
 * its own attempts run out, and the tick's queries stay bounded. Runs after a
 * request that wrote an evented table and on every tick.
 *
 * No order is promised between events, of one resource or not: a retried or
 * lapsed event may reach an endpoint after a newer one (each carries its own
 * `occurredAt`), and none was promised before.
 */
export async function dispatchPendingEvents(options: {
  db: Database;
  targets: readonly EventFanOutTarget[];
  limit?: number;
  /**
   * The scheduled drain: up to this many rows that lapsed again after a
   * claim took them back (they keep dying), each claimed alone, least tried
   * first, besides the batch: they never wait behind fresh events.
   */
  isolate?: number;
  /**
   * The events this drain dispatched. The API fans them
   * out to the realtime hub. Called once, after the drain; never throws into it.
   */
  onFlushed?: (events: OutboxEvent[]) => void | Promise<void>;
}): Promise<EventFlushResult> {
  const limit = Math.max(1, Math.min(options.limit ?? EVENT_FLUSH_BATCH_SIZE, MAX_EVENT_FLUSH_LIMIT));
  const isolate = Math.max(0, options.isolate ?? 0);
  const lapsed = isolate > 0 ? { limit: isolate, rows: [] as Array<{ id: string; attempts: number }> } : undefined;
  const outcomes = await claimAndDispatch(options.db, sql`${eventOutbox.id} IN (${batchEventIds(limit)})`, options.targets, lapsed);
  const alone = (lapsed?.rows ?? []).sort((a, b) => a.attempts - b.attempts);
  for (const row of alone) outcomes.push(...await claimAndDispatch(options.db, eq(eventOutbox.id, row.id), options.targets, undefined, true));
  const result: EventFlushResult = { scanned: outcomes.length, dispatched: 0, failed: 0, skipped: 0, deliveries: [] };
  const flushed: OutboxEvent[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "dispatched") {
      result.dispatched += 1;
      result.deliveries.push(...outcome.deliveries);
      flushed.push(outcome.event);
    } else {
      result.failed += 1;
      console.warn(`[events] Dispatch of ${outcome.eventId} ${outcome.status}: ${outcome.reason}`);
    }
  }
  if (options.onFlushed && flushed.length > 0) {
    try {
      await options.onFlushed(flushed);
    } catch (error) {
      console.warn("[events] Flush observer failed:", EVENT_QUEUE.error(error));
    }
  }
  return result;
}

/** Parses a stored row into a catalog event, or null when it is unreadable. */
export function toOutboxEvent(row: Pick<EventOutboxRow, "id" | "topic" | "resourceType" | "resourceId" | "data" | "occurredAt">): OutboxEvent | null {
  if (!isEventTopic(row.topic) || !isEventResourceType(row.resourceType)) return null;
  const facts = parseEventFacts(row.topic, row.data);
  if (!facts) return null;
  return {
    id: row.id,
    topic: row.topic,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    facts,
    occurredAt: Number(row.occurredAt),
  };
}

export type EventDispatchOutcome =
  | { status: "dispatched"; eventId: string; event: OutboxEvent; deliveries: EventDelivery[] }
  | { status: "skipped"; eventId: string; reason: "missing" | "already_dispatched" | "busy" }
  | { status: "dead_lettered"; eventId: string; reason: string }
  | { status: "failed"; eventId: string; reason: string };

/**
 * Claims one row, lets every target record its work and marks the row
 * dispatched. A target failure retries the event with backoff; targets are
 * idempotent, so the retry only adds what is missing.
 */
export async function processEventDispatch(options: {
  db: Database;
  eventId: string;
  targets: readonly EventFanOutTarget[];
}): Promise<EventDispatchOutcome> {
  const { db, eventId } = options;
  const [outcome] = await claimAndDispatch(db, eq(eventOutbox.id, eventId), options.targets);
  if (outcome) return outcome;
  const existing = await db.select({ status: eventOutbox.status }).from(eventOutbox).where(eq(eventOutbox.id, eventId)).get();
  if (!existing) return { status: "skipped", eventId, reason: "missing" };
  return { status: "skipped", eventId, reason: existing.status === "dispatched" ? "already_dispatched" : "busy" };
}

/**
 * The drain's three steps over the claimable rows `which` selects. When the
 * drain's fan-out fails, each event is fanned out alone and only the events
 * that fail on their own retry with their backoff (the retry adds only what is
 * missing); an unreadable row is dead-lettered alone.
 */
async function claimAndDispatch(
  db: Database,
  which: SQL,
  targets: readonly EventFanOutTarget[],
  /** Rows that lapsed again, read in the claim's round trip (after it: the claim takes none of them), oldest lapse first. */
  lapsed?: { limit: number; rows: Array<{ id: string; attempts: number }> },
  /** The claim takes one row by itself (an event that keeps dying). */
  alone = false,
): Promise<Array<Exclude<EventDispatchOutcome, { status: "skipped" }>>> {
  const token = newClaimToken();
  // The claim re-checks each row: a concurrent drain cannot take it twice.
  const claim = EVENT_QUEUE.claim(db, which, { token, alone }).returning();
  let taken: EventOutboxRow[];
  if (lapsed) {
    const [claimedRows, lapsedRows] = await safeBatch(db, [
      claim,
      db.select({ id: eventOutbox.id, attempts: eventOutbox.attempts }).from(eventOutbox)
        .where(and(EVENT_QUEUE.dueBranches()[1], keepsDying(eventOutbox.claimId, EVENT_QUEUE.base)))
        .orderBy(asc(eventOutbox.claimExpiresAt))
        .limit(lapsed.limit),
    ] as never) as [EventOutboxRow[], Array<{ id: string; attempts: number }>];
    taken = claimedRows;
    lapsed.rows.push(...lapsedRows.map((row) => ({ id: row.id, attempts: Number(row.attempts) })));
  } else {
    taken = await claim;
  }
  const outcomes: Array<Exclude<EventDispatchOutcome, { status: "skipped" }>> = taken
    .filter((row) => row.status !== EVENT_QUEUE.states.running)
    .map((row) => ({ status: "dead_lettered", eventId: row.id, reason: RUNNER_NEVER_FINISHED }));
  const claimed = taken.filter((row) => row.status === EVENT_QUEUE.states.running);
  if (claimed.length === 0) return outcomes;
  const rows = claimed.sort((a, b) => Number(a.nextAttemptAt) - Number(b.nextAttemptAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const readable: Array<{ row: EventOutboxRow; event: OutboxEvent }> = [];
  const unreadable: EventOutboxRow[] = [];
  for (const row of rows) {
    const event = toOutboxEvent(row);
    if (event) readable.push({ row, event });
    else unreadable.push(row);
  }

  const deliveries = new Map<string, EventDelivery[]>();
  /** Each event a fan-out failed for, with why. */
  const failures = new Map<string, string>();
  const fanOut = async (events: readonly OutboxEvent[]) => {
    const recorded: FannedOutDelivery[] = [];
    for (const target of targets) recorded.push(...await target.fanOut(db, events));
    for (const { eventId, ...message } of recorded) {
      deliveries.set(eventId, [...(deliveries.get(eventId) ?? []), message as EventDelivery]);
    }
  };
  if (readable.length > 0) {
    try {
      await fanOut(readable.map(({ event }) => event));
    } catch (error) {
      if (readable.length === 1) {
        failures.set(readable[0]!.row.id, EVENT_QUEUE.error(error));
      } else {
        // One event's failure must not fail the drain: each event alone, so
        // only the events that fail on their own retry (targets are
        // idempotent, so what the first pass wrote is not written twice).
        deliveries.clear();
        for (const { event } of readable) {
          try {
            await fanOut([event]);
          } catch (single) {
            failures.set(event.id, EVENT_QUEUE.error(single));
          }
        }
      }
    }
  }

  const underClaim = EVENT_QUEUE.heldByToken(token);
  const statements: SQLiteBatchItem[] = [];
  for (const row of unreadable) {
    statements.push(EVENT_QUEUE.giveUp(db, eq(eventOutbox.id, row.id), underClaim, "unreadable_event: topic, resource or facts do not match the catalog"));
    outcomes.push({ status: "dead_lettered", eventId: row.id, reason: "unreadable_event" });
  }
  const dispatched = readable.filter(({ row }) => !failures.has(row.id));
  if (dispatched.length > 0) {
    const ids = JSON.stringify(dispatched.map(({ row }) => row.id));
    // A slow drain whose events a later claim gave up still records them dispatched.
    statements.push(EVENT_QUEUE.finish(db, sql`${eventOutbox.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${ids}))`, underClaim));
  }
  for (const { row, event } of readable) {
    const failure = failures.get(row.id);
    if (failure === undefined) {
      outcomes.push({ status: "dispatched", eventId: row.id, event, deliveries: deliveries.get(row.id) ?? [] });
      continue;
    }
    const failed = EVENT_QUEUE.fail(db, eq(eventOutbox.id, row.id), underClaim, row.attempts, failure);
    statements.push(failed.statement);
    outcomes.push({ status: failed.gaveUp ? "dead_lettered" : "failed", eventId: row.id, reason: failure });
  }
  if (statements.length > 0) await safeBatch(db, statements as [SQLiteBatchItem, ...SQLiteBatchItem[]]);
  return outcomes;
}

// ── Admin reads ───────────────────────────────────────────────────────────

export interface EventSummary {
  id: string;
  topic: string;
  apiVersion: string;
  resourceType: string;
  resourceId: string;
  facts: Record<string, unknown>;
  occurredAt: number;
  status: string;
  attempts: number;
  dispatchedAt: number | null;
}

export const EVENT_LIST_MAX_LIMIT = 100;

/** Recent events, newest first; `cursor` is the last id of the previous page. */
export async function listRecentEvents(db: Database, options: {
  topic?: string;
  resourceType?: string;
  resourceId?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ events: EventSummary[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, EVENT_LIST_MAX_LIMIT));
  const conditions = [
    options.topic ? eq(eventOutbox.topic, options.topic) : undefined,
    options.resourceType ? eq(eventOutbox.resourceType, options.resourceType) : undefined,
    options.resourceId ? eq(eventOutbox.resourceId, options.resourceId) : undefined,
    options.cursor ? lt(eventOutbox.id, options.cursor) : undefined,
  ].filter((condition) => condition !== undefined);
  const rows = await db
    .select()
    .from(eventOutbox)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(eventOutbox.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  return {
    events: page.map((row) => {
      let facts: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.data) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) facts = parsed as Record<string, unknown>;
      } catch {
        facts = {};
      }
      return {
        id: row.id,
        topic: row.topic,
        apiVersion: EVENTS_API_VERSION,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        facts,
        occurredAt: Number(row.occurredAt),
        status: row.status,
        attempts: Number(row.attempts),
        dispatchedAt: row.dispatchedAt === null ? null : Number(row.dispatchedAt),
      };
    }),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}
