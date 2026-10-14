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
// next drain reclaims, and every target is idempotent by event id. With no
// subscriber at all, due rows are marked dispatched in place, so an unused
// store pays one indexed read per drain.

import type { Database } from "@scalius/database/client";
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
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";

/**
 * Work a fan-out target recorded for an event: one durable delivery row the
 * API sends next (its own retries live in that row).
 */
export type EventDelivery =
  | { type: "webhooks.deliver"; deliveryId: string }
  | { type: "plugins.deliver"; deliveryId: string };

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
 * target's own durable work for the event (idempotent by event id, so a
 * redelivered event adds nothing) and returns the deliveries still waiting.
 */
export interface EventFanOutTarget {
  readonly name: string;
  /** Cheap check used to settle events in place when nobody listens. */
  hasSubscribers(db: Database): Promise<boolean>;
  fanOut(db: Database, event: OutboxEvent): Promise<EventDelivery[]>;
}

const PROCESSING_LEASE_SECONDS = 5 * 60;
export const MAX_EVENT_DISPATCH_ATTEMPTS = 8;
/** Due rows one drain may take (the scheduled sweep's ceiling). */
export const MAX_EVENT_FLUSH_LIMIT = 200;
/** Ids per settle statement: within D1's 100 bound parameters. */
export const EVENT_FLUSH_BATCH_SIZE = 50;
const MAX_ERROR_LENGTH = 500;
const DEAD_LETTER_NEXT_ATTEMPT_AT = 253_402_300_799;

export function eventDispatchRetryDelaySeconds(attempts: number): number {
  const normalized = Math.max(1, Math.min(attempts, MAX_EVENT_DISPATCH_ATTEMPTS));
  return Math.min(60 * 60, 30 * 2 ** (normalized - 1));
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 3)}...` : message;
}

/** Due pending/failed rows and expired leases. */
function claimableCondition() {
  return or(
    and(
      inArray(eventOutbox.status, ["pending", "failed"]),
      lte(eventOutbox.nextAttemptAt, sql`unixepoch()`),
    ),
    and(
      eq(eventOutbox.status, "processing"),
      lte(eventOutbox.claimExpiresAt, sql`unixepoch()`),
    ),
  );
}

export async function anyEventSubscribers(
  db: Database,
  targets: readonly EventFanOutTarget[],
): Promise<boolean> {
  for (const target of targets) {
    if (await target.hasSubscribers(db)) return true;
  }
  return false;
}

export interface EventFlushResult {
  scanned: number;
  dispatched: number;
  /** Marked dispatched in place because no target had a subscriber. */
  settledWithoutSubscribers: number;
  failed: number;
  skipped: number;
  /** The deliveries the dispatched events recorded, for the caller to send. */
  deliveries: EventDelivery[];
}

/**
 * Dispatches up to `limit` due outbox rows, oldest first: each is claimed,
 * fanned out to the targets and marked dispatched (or failed with backoff).
 * Runs after a request that wrote an evented table and on every tick.
 */
export async function dispatchPendingEvents(options: {
  db: Database;
  targets: readonly EventFanOutTarget[];
  limit?: number;
  /**
   * The events this drain moved on (settled or dispatched). The API fans them
   * out to the realtime hub. Called once, after the drain; never throws into it.
   */
  onFlushed?: (events: OutboxEvent[]) => void | Promise<void>;
}): Promise<EventFlushResult> {
  const result: EventFlushResult = { scanned: 0, dispatched: 0, settledWithoutSubscribers: 0, failed: 0, skipped: 0, deliveries: [] };
  const flushed: OutboxEvent[] = [];
  const report = async () => {
    if (!options.onFlushed || flushed.length === 0) return;
    try {
      await options.onFlushed(flushed);
    } catch (error) {
      console.warn("[events] Flush observer failed:", normalizeError(error));
    }
  };
  const limit = Math.max(1, Math.min(options.limit ?? EVENT_FLUSH_BATCH_SIZE, MAX_EVENT_FLUSH_LIMIT));
  const { db } = options;

  const dueRows = await db
    .select({ id: eventOutbox.id })
    .from(eventOutbox)
    .where(claimableCondition())
    .orderBy(asc(eventOutbox.nextAttemptAt), asc(eventOutbox.id))
    .limit(limit)
    .all();
  result.scanned = dueRows.length;
  if (dueRows.length === 0) return result;

  if (!(await anyEventSubscribers(db, options.targets))) {
    // Nobody listens: settle the due rows in place, oldest first. A target
    // added later receives only events that occur after it exists. `limit`
    // sizes fan-out work (several queries an event); a settle is one
    // statement whatever it takes, so it takes a full EVENT_FLUSH_BATCH_SIZE:
    // a backlog clears in a few drains instead of writing two rows on every
    // later tick, at the same D1 calls per drain.
    const oldestDue = db
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(claimableCondition())
      .orderBy(asc(eventOutbox.nextAttemptAt), asc(eventOutbox.id))
      .limit(EVENT_FLUSH_BATCH_SIZE);
    const settled = await db
      .update(eventOutbox)
      .set({
        status: "dispatched",
        claimId: null,
        claimExpiresAt: null,
        lastError: null,
        dispatchedAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(inArray(eventOutbox.id, oldestDue), claimableCondition()))
      .returning(flushedColumns());
    for (const row of settled) {
      const event = toOutboxEvent(row);
      if (event) flushed.push(event);
    }
    result.settledWithoutSubscribers = settled.length;
    result.scanned = Math.max(result.scanned, result.settledWithoutSubscribers);
    await report();
    return result;
  }

  for (const { id } of dueRows) {
    const outcome = await processEventDispatch({ db, eventId: id, targets: options.targets });
    if (outcome.status === "dispatched") {
      result.dispatched += 1;
      result.deliveries.push(...outcome.deliveries);
      flushed.push(outcome.event);
    } else if (outcome.status === "skipped") {
      result.skipped += 1;
    } else {
      result.failed += 1;
      console.warn(`[events] Dispatch of ${outcome.eventId} ${outcome.status}: ${outcome.reason}`);
    }
  }
  await report();
  return result;
}

/** What a settle returns per row: enough to parse the event, so observers need no read. */
function flushedColumns() {
  return {
    id: eventOutbox.id,
    topic: eventOutbox.topic,
    resourceType: eventOutbox.resourceType,
    resourceId: eventOutbox.resourceId,
    data: eventOutbox.data,
    occurredAt: eventOutbox.occurredAt,
  };
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
 * dispatched. A target failure retries the whole event with backoff; targets
 * are idempotent, so the retry only adds what is missing.
 */
export async function processEventDispatch(options: {
  db: Database;
  eventId: string;
  targets: readonly EventFanOutTarget[];
}): Promise<EventDispatchOutcome> {
  const { db, eventId } = options;
  const claimId = `evc_${crypto.randomUUID().replace(/-/g, "")}`;
  const rows = await db
    .update(eventOutbox)
    .set({
      status: "processing",
      claimId,
      claimExpiresAt: sql`unixepoch() + ${PROCESSING_LEASE_SECONDS}`,
      attempts: sql`${eventOutbox.attempts} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(eq(eventOutbox.id, eventId), claimableCondition()))
    .returning();
  const row = rows[0];
  if (!row) {
    const existing = await db.select({ status: eventOutbox.status }).from(eventOutbox).where(eq(eventOutbox.id, eventId)).get();
    if (!existing) return { status: "skipped", eventId, reason: "missing" };
    return { status: "skipped", eventId, reason: existing.status === "dispatched" ? "already_dispatched" : "busy" };
  }

  const event = toOutboxEvent(row);
  if (!event) {
    await markEventDeadLettered(db, eventId, claimId, "unreadable_event: topic, resource or facts do not match the catalog");
    return { status: "dead_lettered", eventId, reason: "unreadable_event" };
  }

  const deliveries: EventDelivery[] = [];
  try {
    for (const target of options.targets) {
      deliveries.push(...await target.fanOut(db, event));
    }
  } catch (error) {
    const reason = normalizeError(error);
    if (row.attempts >= MAX_EVENT_DISPATCH_ATTEMPTS) {
      await markEventDeadLettered(db, eventId, claimId, `event_attempt_limit_reached: ${reason}`);
      return { status: "dead_lettered", eventId, reason };
    }
    await db
      .update(eventOutbox)
      .set({
        status: "failed",
        claimId: null,
        claimExpiresAt: null,
        lastError: reason,
        nextAttemptAt: sql`unixepoch() + ${eventDispatchRetryDelaySeconds(row.attempts)}`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(eq(eventOutbox.id, eventId), eq(eventOutbox.claimId, claimId)));
    return { status: "failed", eventId, reason };
  }

  await db
    .update(eventOutbox)
    .set({
      status: "dispatched",
      claimId: null,
      claimExpiresAt: null,
      lastError: null,
      dispatchedAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(eq(eventOutbox.id, eventId), eq(eventOutbox.claimId, claimId)));
  return { status: "dispatched", eventId, event, deliveries };
}

async function markEventDeadLettered(db: Database, eventId: string, claimId: string, reason: string): Promise<void> {
  await db
    .update(eventOutbox)
    .set({
      status: "dead_lettered",
      claimId: null,
      claimExpiresAt: null,
      lastError: normalizeError(reason),
      nextAttemptAt: DEAD_LETTER_NEXT_ATTEMPT_AT,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(eq(eventOutbox.id, eventId), eq(eventOutbox.claimId, claimId)));
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
