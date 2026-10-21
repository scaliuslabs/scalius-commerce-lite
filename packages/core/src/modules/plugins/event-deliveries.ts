// Plugin event deliveries (docs/platform/PLUGINS.md, "Extension points" 1):
// the plugin subscriber target of the event outbox. One
// `plugin_event_deliveries` row per (plugin, event) is the delivery's durable
// state, mirroring webhook deliveries:
//
//   fan-out ──▶ pending ──drain──▶ processing ──▶ succeeded
//                  ▲                  │
//                  └─ failed (backoff) ◀┤──▶ exhausted (8 attempts)
//                                     └──▶ cancelled (plugin inactive, event pruned)
//
// Delivery is at least once: a dead Worker or an expired lease redelivers, so the same event can reach a plugin more than once. The
// event id (`event.id`) is the plugin's idempotency key, stable across every
// attempt and redelivery. Plugins also receive events caused by their own
// writes (as Shopify apps do); handlers must be idempotent and convergent
// (write only when something would change). The platform bounds loops with
// the per-plugin `ctx.api` rate limit and a per-plugin cap on deliveries in
// flight; it does not attribute writes to plugins (events are written by SQL
// triggers inside the domain transaction, which carries no principal on
// D1/TursoDB), so there is no event chain depth.
//
// With no active subscriber the target costs one indexed read per flush that
// has due events, and nothing else.

import type { Database } from "@scalius/database/client";
import { chunkRowsForD1 } from "@scalius/database/client";
import {
  pluginEventDeliveries,
  type PluginEventDeliveryRow,
  type PluginEventDeliveryStatus,
} from "@scalius/database/schema";
import { topicMatchesAnyFilter } from "@scalius/shared/events";
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { EventDelivery, EventFanOutTarget } from "../events";
import { PluginError } from "./errors";
import { maskPluginLogText } from "./logs";
import { hasActiveEventPlugins, listActiveEventPlugins, getActivePluginInstallation } from "./registry";

export const PLUGIN_DELIVERY_MAX_ATTEMPTS = 8;
/** Delay after attempt n (1-based) fails; the same 7 waits over about 22.6 hours as webhooks. */
export const PLUGIN_DELIVERY_RETRY_DELAYS_SECONDS = [60, 300, 1_800, 3_600, 10_800, 21_600, 43_200] as const;
/** A claim outlives the longest invocation (30 s wall time) with room for the bridge. */
export const PLUGIN_DELIVERY_LEASE_SECONDS = 120;
/** Deliveries of one plugin in flight at once; the rest stay due for the next drain. */
export const PLUGIN_DELIVERY_MAX_IN_FLIGHT = 4;
export const MAX_PLUGIN_DELIVERY_FLUSH_LIMIT = 200;
export const PLUGIN_DELIVERY_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const PLUGIN_DELIVERY_LIST_MAX_LIMIT = 100;
const MAX_ERROR_LENGTH = 500;
const NEVER = 253_402_300_799;
const PRUNE_BATCH_SIZE = 500;
/** Bound values per delivery insert row (id, plugin, event, topic, resource type and id). */
const INSERT_PARAMETERS_PER_ROW = 6;

export function pluginDeliveryRetryDelaySeconds(attempts: number): number {
  const index = Math.max(1, Math.min(attempts, PLUGIN_DELIVERY_RETRY_DELAYS_SECONDS.length)) - 1;
  return PLUGIN_DELIVERY_RETRY_DELAYS_SECONDS[index]!;
}

/** `pld_` + epoch milliseconds (13 digits) + 12 random hex: unique and time-sortable. */
export function newPluginDeliveryId(nowMs = Date.now()): string {
  return `pld_${String(Math.floor(nowMs)).padStart(13, "0")}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function normalizeError(error: unknown): string {
  const message = maskPluginLogText(error instanceof Error ? error.message : String(error)).trim() || "The delivery failed.";
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
}

// ── Fan-out ───────────────────────────────────────────────────────────────

export const pluginEventFanOutTarget: EventFanOutTarget = {
  name: "plugins",
  hasSubscribers: (db) => hasActiveEventPlugins(db),
  async fanOut(db, event) {
    const subscribers = await listActiveEventPlugins(db, event.topic);
    // The approved grant decides, and a plugin activated after the event never receives it.
    const eligible = subscribers.filter(({ installation }) =>
      installation.grant !== null
      && topicMatchesAnyFilter(event.topic, installation.grant.events)
      && installation.activatedAt !== null
      && installation.activatedAt <= event.occurredAt);
    if (eligible.length === 0) return [];
    const nowMs = Date.now();
    const rows = eligible.map(({ installation }, index) => ({
      id: newPluginDeliveryId(nowMs + index),
      pluginId: installation.pluginId,
      eventId: event.id,
      topic: event.topic,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
    }));
    for (const chunk of chunkRowsForD1(rows, INSERT_PARAMETERS_PER_ROW)) {
      await db.insert(pluginEventDeliveries).values(chunk).onConflictDoNothing();
    }
    // A redelivered event re-sends only deliveries still waiting.
    const pending = await db
      .select({ id: pluginEventDeliveries.id })
      .from(pluginEventDeliveries)
      .where(and(eq(pluginEventDeliveries.eventId, event.id), eq(pluginEventDeliveries.status, "pending")))
      .all();
    return pending.map((row): EventDelivery => ({ type: "plugins.deliver", deliveryId: row.id }));
  },
};

// ── Claim and finish ──────────────────────────────────────────────────────

/** The due states, each one index range. */
function claimableBranches() {
  return [
    and(inArray(pluginEventDeliveries.status, ["pending", "failed"]), lte(pluginEventDeliveries.nextAttemptAt, sql`unixepoch()`))!,
    and(eq(pluginEventDeliveries.status, "processing"), lte(pluginEventDeliveries.claimExpiresAt, sql`unixepoch()`))!,
  ];
}

function claimableCondition() {
  return or(...claimableBranches());
}

/**
 * Whether `listDuePluginEventDeliveries` would find a row: one bounded index
 * probe per due state (the scheduled drain runs only when one finds a row).
 */
export function pluginEventDeliveryDueProbes(db: Database) {
  return claimableBranches().map((where) =>
    db.select({ id: pluginEventDeliveries.id }).from(pluginEventDeliveries).where(where).limit(1));
}

/** Fewer than `limit` deliveries of the row's plugin hold a live claim. */
function underInFlightLimit(limit: number) {
  // The outer reference is spelled out: an UPDATE's columns render unqualified.
  return sql`(SELECT count(*) FROM plugin_event_deliveries AS in_flight
    WHERE in_flight.plugin_id = plugin_event_deliveries.plugin_id
      AND in_flight.status = 'processing'
      AND in_flight.claim_expires_at > unixepoch()) < ${limit}`;
}

export type PluginDeliveryClaim =
  | { status: "claimed"; delivery: PluginEventDeliveryRow; claimId: string }
  | { status: "busy"; pluginId: string }
  | { status: "skipped"; reason: "missing" | "not_due" };

/**
 * Claims a delivery for one attempt (counted at claim, so a crash mid-attempt
 * still uses one up), unless its plugin already has `maxInFlight` deliveries
 * running: then it is left as it was and reported busy.
 */
export async function claimPluginEventDelivery(
  db: Database,
  deliveryId: string,
  options: { maxInFlight?: number } = {},
): Promise<PluginDeliveryClaim> {
  const claimId = `pdc_${crypto.randomUUID().replace(/-/g, "")}`;
  const claimed = await db
    .update(pluginEventDeliveries)
    .set({
      status: "processing",
      claimId,
      claimExpiresAt: sql`unixepoch() + ${PLUGIN_DELIVERY_LEASE_SECONDS}`,
      attempts: sql`${pluginEventDeliveries.attempts} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(pluginEventDeliveries.id, deliveryId),
      claimableCondition(),
      underInFlightLimit(options.maxInFlight ?? PLUGIN_DELIVERY_MAX_IN_FLIGHT),
    ))
    .returning();
  if (claimed[0]) return { status: "claimed", delivery: claimed[0], claimId };
  const existing = await db
    .select({ pluginId: pluginEventDeliveries.pluginId, claimable: sql<number>`CASE WHEN ${claimableCondition()} THEN 1 ELSE 0 END` })
    .from(pluginEventDeliveries)
    .where(eq(pluginEventDeliveries.id, deliveryId))
    .get();
  if (!existing) return { status: "skipped", reason: "missing" };
  return Number(existing.claimable) === 1 ? { status: "busy", pluginId: existing.pluginId } : { status: "skipped", reason: "not_due" };
}

function claimed(delivery: PluginEventDeliveryRow, claimId: string) {
  return and(eq(pluginEventDeliveries.id, delivery.id), eq(pluginEventDeliveries.claimId, claimId));
}

export async function completePluginEventDelivery(
  db: Database,
  delivery: PluginEventDeliveryRow,
  claimId: string,
  result: { durationMs: number },
): Promise<void> {
  await db.update(pluginEventDeliveries).set({
    status: "succeeded",
    claimId: null,
    claimExpiresAt: null,
    lastAttemptAt: sql`unixepoch()`,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    lastError: null,
    deliveredAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  }).where(claimed(delivery, claimId));
}

/**
 * Records a failed attempt: retried with backoff until the attempt limit,
 * then exhausted (the dead-letter state the dashboard lists and can retry).
 * The next drain that finds the row due sends it again.
 */
export async function failPluginEventDelivery(
  db: Database,
  delivery: PluginEventDeliveryRow,
  claimId: string,
  result: { error: string; durationMs: number },
): Promise<{ status: "failed" | "exhausted"; retryInSeconds: number | null }> {
  const attempts = Number(delivery.attempts);
  const exhausted = attempts >= PLUGIN_DELIVERY_MAX_ATTEMPTS;
  const retryInSeconds = exhausted ? null : pluginDeliveryRetryDelaySeconds(attempts);
  await db.update(pluginEventDeliveries).set({
    status: exhausted ? "exhausted" : "failed",
    claimId: null,
    claimExpiresAt: null,
    lastAttemptAt: sql`unixepoch()`,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    lastError: normalizeError(result.error),
    nextAttemptAt: exhausted ? NEVER : sql`unixepoch() + ${retryInSeconds}`,
    updatedAt: sql`unixepoch()`,
  }).where(claimed(delivery, claimId));
  return { status: exhausted ? "exhausted" : "failed", retryInSeconds };
}

/** The plugin cannot take this delivery any more (inactive, uninstalled, event pruned). */
export async function cancelPluginEventDelivery(
  db: Database,
  delivery: PluginEventDeliveryRow,
  claimId: string,
  reason: string,
): Promise<void> {
  await db.update(pluginEventDeliveries).set({
    status: "cancelled",
    claimId: null,
    claimExpiresAt: null,
    lastError: normalizeError(reason),
    nextAttemptAt: NEVER,
    updatedAt: sql`unixepoch()`,
  }).where(claimed(delivery, claimId));
}

/**
 * Gives a claimed delivery back without using up its attempt (the platform,
 * not the plugin, was not ready: its code is being updated in place).
 */
export async function releasePluginEventDelivery(
  db: Database,
  delivery: PluginEventDeliveryRow,
  claimId: string,
  options: { delaySeconds: number; reason: string },
): Promise<void> {
  await db.update(pluginEventDeliveries).set({
    status: "failed",
    attempts: sql`CASE WHEN ${pluginEventDeliveries.attempts} > 0 THEN ${pluginEventDeliveries.attempts} - 1 ELSE 0 END`,
    claimId: null,
    claimExpiresAt: null,
    lastError: normalizeError(options.reason),
    nextAttemptAt: sql`unixepoch() + ${Math.max(1, Math.round(options.delaySeconds))}`,
    updatedAt: sql`unixepoch()`,
  }).where(claimed(delivery, claimId));
}

// ── Scheduled drain and retention ─────────────────────────────────────────

/** Due retries and expired leases, oldest first: the ids a drain sends next. */
export async function listDuePluginEventDeliveries(db: Database, limit = MAX_PLUGIN_DELIVERY_FLUSH_LIMIT): Promise<string[]> {
  const due = await db
    .select({ id: pluginEventDeliveries.id })
    .from(pluginEventDeliveries)
    .where(claimableCondition())
    .orderBy(asc(pluginEventDeliveries.nextAttemptAt), asc(pluginEventDeliveries.id))
    .limit(Math.max(1, Math.min(limit, MAX_PLUGIN_DELIVERY_FLUSH_LIMIT)))
    .all();
  return due.map((row) => row.id);
}

/** Bounded delete (500 rows per run) of terminal deliveries older than 30 days. */
export async function prunePluginEventDeliveries(db: Database, nowSeconds = Math.floor(Date.now() / 1000)): Promise<number> {
  const rows = await db
    .delete(pluginEventDeliveries)
    .where(inArray(
      pluginEventDeliveries.id,
      db.select({ id: pluginEventDeliveries.id })
        .from(pluginEventDeliveries)
        .where(and(
          lt(pluginEventDeliveries.createdAt, nowSeconds - PLUGIN_DELIVERY_RETENTION_SECONDS),
          inArray(pluginEventDeliveries.status, ["succeeded", "failed", "exhausted", "cancelled"]),
        ))
        .limit(PRUNE_BATCH_SIZE),
    ))
    .returning({ id: pluginEventDeliveries.id });
  return rows.length;
}

// ── Admin reads and actions ───────────────────────────────────────────────

export interface PluginEventDeliveryView {
  id: string;
  pluginId: string;
  eventId: string | null;
  topic: string;
  resourceType: string;
  resourceId: string;
  status: PluginEventDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  durationMs: number | null;
  error: string | null;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
}

export function toPluginEventDeliveryView(row: PluginEventDeliveryRow): PluginEventDeliveryView {
  const waiting = row.status === "pending" || row.status === "failed";
  return {
    id: row.id,
    pluginId: row.pluginId,
    eventId: row.eventId ?? null,
    topic: row.topic,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: PLUGIN_DELIVERY_MAX_ATTEMPTS,
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
    error: row.lastError ?? null,
    nextAttemptAt: waiting && Number(row.nextAttemptAt) < NEVER ? Number(row.nextAttemptAt) : null,
    lastAttemptAt: row.lastAttemptAt === null ? null : Number(row.lastAttemptAt),
    deliveredAt: row.deliveredAt === null ? null : Number(row.deliveredAt),
    createdAt: Number(row.createdAt),
  };
}

/** Newest first; `cursor` is the last id of the previous page. */
export async function listPluginEventDeliveries(db: Database, pluginId: string, options: {
  status?: PluginEventDeliveryStatus;
  cursor?: string;
  limit?: number;
} = {}): Promise<{ deliveries: PluginEventDeliveryView[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(options.limit ?? 25, PLUGIN_DELIVERY_LIST_MAX_LIMIT));
  const rows = await db
    .select()
    .from(pluginEventDeliveries)
    .where(and(
      eq(pluginEventDeliveries.pluginId, pluginId),
      options.status ? eq(pluginEventDeliveries.status, options.status) : undefined,
      options.cursor ? lt(pluginEventDeliveries.id, options.cursor) : undefined,
    ))
    .orderBy(desc(pluginEventDeliveries.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  return {
    deliveries: page.map(toPluginEventDeliveryView),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

/** Staff "Retry": a failed, exhausted or cancelled delivery of an active plugin starts a fresh retry cycle now (the caller sends it). */
export async function retryPluginEventDelivery(
  db: Database,
  pluginId: string,
  deliveryId: string,
): Promise<PluginEventDeliveryView> {
  if (!(await getActivePluginInstallation(db, pluginId))) {
    throw new PluginError("installation_inactive", "Activate the app before retrying its deliveries.");
  }
  const rows = await db.update(pluginEventDeliveries).set({
    status: "pending",
    attempts: 0,
    claimId: null,
    claimExpiresAt: null,
    nextAttemptAt: sql`unixepoch()`,
    lastError: null,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(pluginEventDeliveries.id, deliveryId),
    eq(pluginEventDeliveries.pluginId, pluginId),
    inArray(pluginEventDeliveries.status, ["failed", "exhausted", "cancelled"]),
    sql`${pluginEventDeliveries.eventId} IS NOT NULL`,
  )).returning();
  if (!rows[0]) {
    const existing = await db
      .select({ id: pluginEventDeliveries.id, eventId: pluginEventDeliveries.eventId })
      .from(pluginEventDeliveries)
      .where(and(eq(pluginEventDeliveries.id, deliveryId), eq(pluginEventDeliveries.pluginId, pluginId)))
      .get();
    if (!existing) throw new PluginError("delivery_not_found", "Delivery not found.");
    throw new PluginError("delivery_not_retryable", existing.eventId === null
      ? "Its event was pruned; it cannot be delivered again."
      : "Only failed, exhausted or cancelled deliveries can be retried.");
  }
  return toPluginEventDeliveryView(rows[0]);
}
