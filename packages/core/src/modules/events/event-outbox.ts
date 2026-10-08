// Event outbox dispatch (COMMERCE-HOOKS H3). Rows are written only by SQL
// triggers in the domain write's transaction; this module moves them to the
// fan-out targets with the notification outbox's state machine:
//
//   pending ──claim──▶ enqueueing ──sent──▶ queued ──consumer──▶ processing
//      ▲                    │                                       │
//      └──── failed ◀───────┴──────── (backoff) ◀───────────────────┤
//                                                                   ▼
//                              dead_lettered (8 attempts)       dispatched
//
// Queue messages carry only the event id. Delivery is at least once: a lost
// message or an expired lease is re-enqueued by the scheduled flush, and every
// target is idempotent by event id. With no subscriber at all, due rows are
// marked dispatched in place and nothing is queued, so an unused store pays one
// indexed read per flush.

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

export interface EventsDispatchQueueMessage {
  type: "events.dispatch";
  eventId: string;
}

export interface WebhookDeliverQueueMessage {
  type: "webhooks.deliver";
  deliveryId: string;
}

/** One plugin event delivery (`plugin_event_deliveries`), processed by the API's plugin host. */
export interface PluginDeliverQueueMessage {
  type: "plugins.deliver";
  deliveryId: string;
}

export type EventsQueueMessage = EventsDispatchQueueMessage | WebhookDeliverQueueMessage | PluginDeliverQueueMessage;

/** The subset of Cloudflare `Queue` the events pipeline uses. */
export interface EventsQueue {
  send(message: EventsQueueMessage, options?: { delaySeconds?: number }): Promise<unknown>;
  sendBatch(messages: Array<{ body: EventsQueueMessage; delaySeconds?: number }>): Promise<unknown>;
}

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
 * A fan-out target: webhooks now, plugin subscribers later. `fanOut` records
 * the target's own durable work for the event (idempotent by event id, so a
 * redelivered event adds nothing) and returns the follow-up queue messages to
 * send once the event is marked dispatched.
 */
export interface EventFanOutTarget {
  readonly name: string;
  /** Cheap check used to skip queueing entirely when nobody listens. */
  hasSubscribers(db: Database): Promise<boolean>;
  fanOut(db: Database, event: OutboxEvent): Promise<EventsQueueMessage[]>;
}

const ENQUEUE_LEASE_SECONDS = 5 * 60;
const PROCESSING_LEASE_SECONDS = 5 * 60;
/** A `queued` row whose message never arrived is replayed after this long. */
export const EVENT_STALE_QUEUED_SECONDS = 30 * 60;
export const MAX_EVENT_DISPATCH_ATTEMPTS = 8;
/** Due rows one flush handles (the scheduled sweep uses the maximum). */
export const MAX_EVENT_FLUSH_LIMIT = 200;
/** Ids per claim/`sendBatch`: within the Queues limit (100) and D1's 100 bound parameters. */
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

function randomId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Due pending/failed rows, expired leases and queued rows whose message was lost. */
function claimableCondition() {
  return or(
    and(
      inArray(eventOutbox.status, ["pending", "failed"]),
      lte(eventOutbox.nextAttemptAt, sql`unixepoch()`),
    ),
    and(
      inArray(eventOutbox.status, ["enqueueing", "processing"]),
      lte(eventOutbox.claimExpiresAt, sql`unixepoch()`),
    ),
    and(
      eq(eventOutbox.status, "queued"),
      lte(eventOutbox.queuedAt, sql`unixepoch() - ${EVENT_STALE_QUEUED_SECONDS}`),
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
  enqueued: number;
  /** Marked dispatched in place because no target had a subscriber. */
  settledWithoutSubscribers: number;
  failed: number;
  skipped: number;
}

/**
 * Hands due outbox rows to the queue (`events.dispatch`, id only): up to
 * `limit` rows, claimed and sent in chunks of 50. Used after a request that
 * wrote an evented table, after queue batches, and by the scheduled sweep.
 */
export async function flushPendingEventOutbox(options: {
  db: Database;
  queue: EventsQueue | undefined;
  targets: readonly EventFanOutTarget[];
  limit?: number;
  /**
   * The events this flush moved on (settled or handed to the queue), parsed
   * from the rows the claim already returns: no extra read. The API fans them
   * out to the realtime hub. Called once, after the flush; never throws into it.
   */
  onFlushed?: (events: OutboxEvent[]) => void | Promise<void>;
}): Promise<EventFlushResult> {
  const result: EventFlushResult = { scanned: 0, enqueued: 0, settledWithoutSubscribers: 0, failed: 0, skipped: 0 };
  const flushed: OutboxEvent[] = [];
  const noteFlushed = (rows: ReadonlyArray<Pick<EventOutboxRow, "id" | "topic" | "resourceType" | "resourceId" | "data" | "occurredAt">>) => {
    if (!options.onFlushed) return;
    for (const row of rows) {
      const event = toOutboxEvent(row);
      if (event) flushed.push(event);
    }
  };
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
    // Nobody listens: settle the rows without a queue round trip. A target
    // added later receives only events that occur after it exists.
    for (let start = 0; start < dueRows.length; start += EVENT_FLUSH_BATCH_SIZE) {
      const ids = dueRows.slice(start, start + EVENT_FLUSH_BATCH_SIZE).map((row) => row.id);
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
        .where(and(inArray(eventOutbox.id, ids), claimableCondition()))
        .returning(flushedColumns());
      noteFlushed(settled);
      result.settledWithoutSubscribers += settled.length;
      result.skipped += ids.length - settled.length;
    }
    await report();
    return result;
  }

  if (!options.queue) return result;
  const queue = options.queue;

  for (let start = 0; start < dueRows.length; start += EVENT_FLUSH_BATCH_SIZE) {
    const ids = dueRows.slice(start, start + EVENT_FLUSH_BATCH_SIZE).map((row) => row.id);
    const claimId = randomId("evc_");
    const claimed = await db
      .update(eventOutbox)
      .set({
        status: "enqueueing",
        claimId,
        claimExpiresAt: sql`unixepoch() + ${ENQUEUE_LEASE_SECONDS}`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(inArray(eventOutbox.id, ids), claimableCondition()))
      .returning({ ...flushedColumns(), attempts: eventOutbox.attempts });
    result.skipped += ids.length - claimed.length;
    if (claimed.length === 0) continue;

    try {
      await queue.sendBatch(claimed.map((row) => ({ body: { type: "events.dispatch" as const, eventId: row.id } })));
    } catch (error) {
      result.failed += claimed.length;
      await db
        .update(eventOutbox)
        .set({
          status: "failed",
          claimId: null,
          claimExpiresAt: null,
          lastError: `queue_send_failed: ${normalizeError(error)}`,
          nextAttemptAt: sql`unixepoch() + 60`,
          updatedAt: sql`unixepoch()`,
        })
        .where(and(inArray(eventOutbox.id, claimed.map((row) => row.id)), eq(eventOutbox.claimId, claimId)))
        .catch((markError: unknown) => {
          console.error("[events] Failed to mark queue send failure:", normalizeError(markError));
        });
      continue;
    }

    result.enqueued += claimed.length;
    noteFlushed(claimed);
    await db
      .update(eventOutbox)
      .set({
        status: "queued",
        claimId: null,
        claimExpiresAt: null,
        queuedAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(inArray(eventOutbox.id, claimed.map((row) => row.id)), eq(eventOutbox.claimId, claimId)))
      .catch((error: unknown) => {
        // The messages are in the queue; the consumer claims by id and an
        // expired lease is re-enqueued by a later flush.
        console.error("[events] Failed to mark events queued:", normalizeError(error));
      });
  }
  await report();
  return result;
}

/** What a flush returns per row: enough to parse the event, so observers need no read. */
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
  | { status: "dispatched"; eventId: string; messages: EventsQueueMessage[] }
  | { status: "skipped"; eventId: string; reason: "missing" | "already_dispatched" | "busy" }
  | { status: "dead_lettered"; eventId: string; reason: string }
  | { status: "failed"; eventId: string; reason: string };

/**
 * The `events.dispatch` consumer: claims the row, lets every target record
 * its work, marks the row dispatched and sends the targets' follow-up
 * messages. A target failure retries the whole event with backoff; targets
 * are idempotent, so the retry only adds what is missing.
 */
export async function processEventDispatch(options: {
  db: Database;
  eventId: string;
  targets: readonly EventFanOutTarget[];
  queue: EventsQueue | undefined;
}): Promise<EventDispatchOutcome> {
  const { db, eventId } = options;
  const claimId = randomId("evc_");
  const rows = await db
    .update(eventOutbox)
    .set({
      status: "processing",
      claimId,
      claimExpiresAt: sql`unixepoch() + ${PROCESSING_LEASE_SECONDS}`,
      attempts: sql`${eventOutbox.attempts} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(eventOutbox.id, eventId),
      or(
        eq(eventOutbox.status, "queued"),
        and(inArray(eventOutbox.status, ["pending", "failed"]), lte(eventOutbox.nextAttemptAt, sql`unixepoch()`)),
        and(inArray(eventOutbox.status, ["enqueueing", "processing"]), lte(eventOutbox.claimExpiresAt, sql`unixepoch()`)),
      ),
    ))
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

  const messages: EventsQueueMessage[] = [];
  try {
    for (const target of options.targets) {
      messages.push(...await target.fanOut(db, event));
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

  if (messages.length > 0 && options.queue) {
    // Follow-up work is durable in the targets' own tables; a failed send is
    // picked up by their scheduled flush.
    for (let start = 0; start < messages.length; start += 100) {
      await options.queue
        .sendBatch(messages.slice(start, start + 100).map((body) => ({ body })))
        .catch((error: unknown) => {
          console.warn(`[events] Follow-up send for ${eventId} failed; the scheduled flush retries:`, normalizeError(error));
        });
    }
  }
  return { status: "dispatched", eventId, messages };
}

async function markEventDeadLettered(db: Database, eventId: string, claimId: string | null, reason: string): Promise<void> {
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
    .where(claimId ? and(eq(eventOutbox.id, eventId), eq(eventOutbox.claimId, claimId)) : eq(eventOutbox.id, eventId));
}

/** `jobs-dlq`: an exhausted `events.dispatch` message dead-letters its row. */
export async function deadLetterEventFromQueue(db: Database, eventId: string, reason: string): Promise<boolean> {
  const rows = await db
    .update(eventOutbox)
    .set({
      status: "dead_lettered",
      claimId: null,
      claimExpiresAt: null,
      lastError: normalizeError(reason),
      nextAttemptAt: DEAD_LETTER_NEXT_ATTEMPT_AT,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(eq(eventOutbox.id, eventId), sql`${eventOutbox.status} <> 'dispatched'`))
    .returning({ id: eventOutbox.id });
  return rows.length > 0;
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
