// Webhook deliveries (COMMERCE-HOOKS H3). One `webhook_event_deliveries` row per
// (subscription, event) is the delivery's durable state and its bounded
// attempt log: attempts, the last attempt's HTTP status, duration and a short
// masked response excerpt, never a full response body.
//
// A delivery POSTs `{id, topic, apiVersion, occurredAt, resource, facts,
// data}` where `data` is the resource's sealed representation (H5) as the
// endpoint's `customerData` lets it see it,
// signed `Scalius-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)>`,
// with `Scalius-Event-Id` as the receiver's idempotency key. Failures retry 8
// attempts over about 23 hours; an endpoint failing for a day is disabled
// (`disabled_reason = failing`), which the dashboard shows as a notice.

import type { Database } from "@scalius/database/client";
import { chunkRowsForD1, safeBatch } from "@scalius/database/client";
import {
  eventOutbox,
  pluginInstallations,
  webhookDeliveries,
  webhookSubscriptions,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookSubscription,
} from "@scalius/database/schema";
import {
  WEBHOOK_API_VERSION_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TEST_TOPIC,
  WEBHOOK_TOPIC_HEADER,
  eventDataTruncation,
  projectEventRepresentation,
  signWebhookPayload,
  topicMatchesAnyFilter,
  type EventRepresentation,
  type EventTopicFilter,
} from "@scalius/shared/events";
import type { ProtectedCustomerData } from "@scalius/shared/plugins/protected-data";
import { checkOutboundUrl } from "@scalius/shared/outbound-url";
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import {
  toOutboxEvent,
  type EventDelivery,
  type EventFanOutTarget,
  type OutboxEvent,
} from "./event-outbox";
import { parseStoredCustomerData, parseStoredTopicFilters, readWebhookSecret, type AppWebhookAccess } from "./webhook-subscriptions";
import { eventFilterCovered, isPluginHostAllowed } from "@scalius/shared/plugins/manifest";

export const WEBHOOK_MAX_ATTEMPTS = 8;
/** Delay after attempt n (1-based) fails; 7 waits over about 22.6 hours. */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [60, 300, 1_800, 3_600, 10_800, 21_600, 43_200] as const;
/** An endpoint failing this long, with a full retry cycle of failures, is disabled. */
export const WEBHOOK_DISABLE_AFTER_FAILING_SECONDS = 24 * 60 * 60;
export const WEBHOOK_DISABLE_MIN_FAILURES = WEBHOOK_MAX_ATTEMPTS;
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
export const WEBHOOK_RESPONSE_EXCERPT_LENGTH = 256;
/** Bodies above this carry the truncation shape in `data` (`{ truncated: true, id, fetch }`). */
export const WEBHOOK_MAX_BODY_BYTES = 512 * 1024;
const PROCESSING_LEASE_SECONDS = 120;
const MAX_ERROR_LENGTH = 500;
const NEVER = 253_402_300_799;
export const MAX_DELIVERY_FLUSH_LIMIT = 200;
const USER_AGENT = "Scalius-Webhooks/1.0";

export function webhookRetryDelaySeconds(attempts: number): number {
  const index = Math.max(1, Math.min(attempts, WEBHOOK_RETRY_DELAYS_SECONDS.length)) - 1;
  return WEBHOOK_RETRY_DELAYS_SECONDS[index]!;
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 3)}...` : message;
}

/** `whd_` + epoch milliseconds + 12 random hex: unique and time-sortable like event ids. */
export function newDeliveryId(nowMs = Date.now()): string {
  return `whd_${Math.floor(nowMs)}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// ── Response excerpt masking ──────────────────────────────────────────────

/**
 * At most 256 printable characters of a receiver's response, with anything
 * that could be a contact, a number or a credential masked. Response bodies
 * are the receiver's data: keep only enough to debug a status.
 */
export function maskResponseExcerpt(text: string, secret?: string | null): string | null {
  let value = text.slice(0, 4 * WEBHOOK_RESPONSE_EXCERPT_LENGTH);
  if (secret) value = value.split(secret).join("[secret]");
  value = withoutControlCharacters(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, "$1 [redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "[redacted]")
    .replace(/\+?\d[\d\s-]{6,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return null;
  return value.length > WEBHOOK_RESPONSE_EXCERPT_LENGTH ? `${value.slice(0, WEBHOOK_RESPONSE_EXCERPT_LENGTH - 1)}…` : value;
}

async function readResponseExcerpt(response: Response, secret: string): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < 2048) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      received += value.byteLength;
    }
  } catch {
    // A body that fails mid-read still yields its status.
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (chunks.length === 0) return null;
  const bytes = new Uint8Array(Math.min(received, 2048));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.max(0, bytes.length - offset));
    bytes.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= bytes.length) break;
  }
  return maskResponseExcerpt(new TextDecoder().decode(bytes), secret);
}

// ── One HTTP attempt ──────────────────────────────────────────────────────

export interface WebhookAttemptResult {
  ok: boolean;
  responseStatus: number | null;
  durationMs: number;
  responseExcerpt: string | null;
  error: string | null;
}

export type WebhookFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * POSTs one signed body. The URL is re-checked (SSRF guard) before every
 * attempt, redirects are never followed and the request times out.
 */
export async function sendWebhookRequest(options: {
  url: string;
  secret: string;
  body: string;
  eventId: string;
  topic: string;
  apiVersion: string;
  fetch?: WebhookFetch;
  timeoutMs?: number;
  nowSeconds?: number;
}): Promise<WebhookAttemptResult> {
  const check = checkOutboundUrl(options.url);
  if (!check.ok) {
    return { ok: false, responseStatus: null, durationMs: 0, responseExcerpt: null, error: `url_refused: ${check.issue}` };
  }
  const timestamp = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const signature = await signWebhookPayload(options.secret, timestamp, options.body);
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const started = Date.now();
  try {
    const response = await doFetch(check.url.toString(), {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        [WEBHOOK_EVENT_ID_HEADER]: options.eventId,
        [WEBHOOK_TOPIC_HEADER]: options.topic,
        [WEBHOOK_API_VERSION_HEADER]: options.apiVersion,
        [WEBHOOK_SIGNATURE_HEADER]: signature,
      },
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS),
    });
    const responseExcerpt = await readResponseExcerpt(response, options.secret);
    const durationMs = Date.now() - started;
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, responseStatus: response.status, durationMs, responseExcerpt, error: null };
    }
    const error = response.status >= 300 && response.status < 400
      ? "redirect_not_followed: answer with a 2xx status at the subscribed URL"
      : `http_${response.status}`;
    return { ok: false, responseStatus: response.status, durationMs, responseExcerpt, error };
  } catch (error) {
    const durationMs = Date.now() - started;
    const name = error instanceof Error ? error.name : "";
    const message = name === "TimeoutError" || name === "AbortError"
      ? `timeout: no response within ${Math.round((options.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS) / 1000)} s`
      : `network_error: ${normalizeError(error)}`;
    return { ok: false, responseStatus: null, durationMs, responseExcerpt: null, error: message };
  }
}

// ── Representation and body ───────────────────────────────────────────────

/**
 * The resource's sealed representation in full (`EVENT_REPRESENTATION_SCHEMAS`,
 * built through `buildEventRepresentation`), or null when it no longer exists.
 * The API layer reads it; each delivery then applies its subscription's
 * `customerData` (COMMERCE-HOOKS H5).
 */
export type WebhookRepresentationResolver = (event: OutboxEvent) => Promise<EventRepresentation | null>;

/**
 * The signed body: the envelope with the representation as this endpoint may
 * see it (protected fields outside `customerData` read null). A body above
 * 512 KiB carries the documented truncation shape in `data` instead (the id
 * and the operation that reads it), never a silent null.
 */
export function buildWebhookBody(
  event: OutboxEvent,
  apiVersion: string,
  data: EventRepresentation | null,
  customerData: ReadonlySet<ProtectedCustomerData> = new Set(),
): string {
  const envelope = {
    id: event.id,
    topic: event.topic,
    apiVersion,
    occurredAt: new Date(event.occurredAt * 1000).toISOString(),
    resource: { type: event.resourceType, id: event.resourceId },
    facts: event.facts,
    data: data ? projectEventRepresentation(event.resourceType, data, customerData) : null,
  };
  const body = JSON.stringify(envelope);
  if (new TextEncoder().encode(body).byteLength <= WEBHOOK_MAX_BODY_BYTES) return body;
  return JSON.stringify({
    ...envelope,
    data: eventDataTruncation(event.resourceType, event.resourceId, event.facts as Record<string, unknown>),
  });
}

// ── Fan-out target ────────────────────────────────────────────────────────

/** Bound values per delivery insert row (id, subscription, event, topic, resource type and id). */
const DELIVERY_INSERT_PARAMETERS_PER_ROW = 6;

export const webhookFanOutTarget: EventFanOutTarget = {
  name: "webhooks",
  async hasSubscribers(db) {
    const row = await db
      .select({ id: webhookSubscriptions.id })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.status, "active"))
      .limit(1)
      .get();
    return Boolean(row);
  },
  async fanOut(db, event) {
    // Endpoints created after the event never receive it, and an app's only
    // while the app is active (each delivery re-checks its grant).
    const subscriptions = await db
      .select({ id: webhookSubscriptions.id, topics: webhookSubscriptions.topics })
      .from(webhookSubscriptions)
      .where(and(
        eq(webhookSubscriptions.status, "active"),
        lte(webhookSubscriptions.createdAt, event.occurredAt),
        sql`(${webhookSubscriptions.pluginId} IS NULL OR EXISTS (
          SELECT 1 FROM ${pluginInstallations}
          WHERE ${pluginInstallations.pluginId} = ${webhookSubscriptions.pluginId} AND ${pluginInstallations.status} = 'active'
        ))`,
      ))
      .all();
    const matching = subscriptions.filter((subscription) =>
      topicMatchesAnyFilter(event.topic, parseStoredTopicFilters(subscription.topics)));
    if (matching.length === 0) return [];

    const nowMs = Date.now();
    const rows = matching.map((subscription, index) => ({
      id: newDeliveryId(nowMs + index),
      subscriptionId: subscription.id,
      eventId: event.id,
      topic: event.topic,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
    }));
    for (const chunk of chunkRowsForD1(rows, DELIVERY_INSERT_PARAMETERS_PER_ROW)) {
      await db.insert(webhookDeliveries).values(chunk).onConflictDoNothing();
    }
    // A redelivered event re-sends only deliveries still waiting.
    const pending = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.eventId, event.id), eq(webhookDeliveries.status, "pending")))
      .all();
    return pending.map((row): EventDelivery => ({ type: "webhooks.deliver", deliveryId: row.id }));
  },
};

// ── Delivery processing ───────────────────────────────────────────────────

function deliveryClaimableCondition() {
  return and(
    eq(webhookDeliveries.kind, "event"),
    or(
      and(inArray(webhookDeliveries.status, ["pending", "failed"]), lte(webhookDeliveries.nextAttemptAt, sql`unixepoch()`)),
      and(eq(webhookDeliveries.status, "processing"), lte(webhookDeliveries.claimExpiresAt, sql`unixepoch()`)),
    ),
  );
}

export type WebhookDeliveryOutcome =
  | { status: "succeeded" | "failed" | "exhausted" | "cancelled"; deliveryId: string; subscriptionDisabled: boolean; retryInSeconds: number | null }
  | { status: "skipped"; deliveryId: string; reason: "missing" | "not_due" };

/**
 * Sends one delivery: claims it, builds and signs the
 * body, POSTs it, records the attempt and the endpoint's health, and returns
 * when to retry. Only infrastructure errors (the database) throw.
 */
export async function processWebhookDelivery(options: {
  db: Database;
  deliveryId: string;
  encryptionKey: string | undefined;
  resolveRepresentation: WebhookRepresentationResolver;
  fetch?: WebhookFetch;
  onSubscriptionDisabled?: (subscription: { id: string; url: string }) => Promise<void>;
  /**
   * An app-owned subscription's live grant (null: the app is not active).
   * Without it, app-owned deliveries are cancelled: they never send on a
   * grant nobody checked.
   */
  appAccess?: (pluginId: string) => Promise<AppWebhookAccess | null>;
}): Promise<WebhookDeliveryOutcome> {
  const { db, deliveryId } = options;
  const claimId = `whc_${crypto.randomUUID().replace(/-/g, "")}`;
  const claimed = await db
    .update(webhookDeliveries)
    .set({
      status: "processing",
      claimId,
      claimExpiresAt: sql`unixepoch() + ${PROCESSING_LEASE_SECONDS}`,
      // Counted at claim, so a crash mid-attempt still uses one up.
      attempts: sql`${webhookDeliveries.attempts} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(eq(webhookDeliveries.id, deliveryId), deliveryClaimableCondition()))
    .returning();
  const delivery = claimed[0];
  if (!delivery) {
    const exists = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get();
    return { status: "skipped", deliveryId, reason: exists ? "not_due" : "missing" };
  }

  const [subscription, eventRow] = await Promise.all([
    db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, delivery.subscriptionId)).get(),
    delivery.eventId
      ? db.select().from(eventOutbox).where(eq(eventOutbox.id, delivery.eventId)).get()
      : Promise.resolve(undefined),
  ]);
  if (!subscription || subscription.status !== "active") {
    await finishDelivery(db, delivery, claimId, { status: "cancelled", error: "subscription_disabled" });
    return { status: "cancelled", deliveryId, subscriptionDisabled: false, retryInSeconds: null };
  }
  const event = eventRow ? toOutboxEvent(eventRow) : null;
  if (!event) {
    await finishDelivery(db, delivery, claimId, { status: "cancelled", error: eventRow ? "event_unreadable" : "event_pruned" });
    return { status: "cancelled", deliveryId, subscriptionDisabled: false, retryInSeconds: null };
  }
  // An app's endpoint delivers only within its app's live grant.
  let customerData = new Set(parseStoredCustomerData(subscription.customerData));
  if (subscription.pluginId) {
    const access = options.appAccess ? await options.appAccess(subscription.pluginId) : null;
    const refusal = appDeliveryRefusal(access, subscription.url, event.topic);
    if (refusal) {
      await finishDelivery(db, delivery, claimId, { status: "cancelled", error: refusal });
      return { status: "cancelled", deliveryId, subscriptionDisabled: false, retryInSeconds: null };
    }
    customerData = new Set([...customerData].filter((category) => access!.customerData.includes(category)));
  }

  const secret = await readWebhookSecret(subscription, options.encryptionKey);
  let body: string | null = null;
  let internalError: string | null = secret ? null : "signing_secret_unreadable: check CREDENTIAL_ENCRYPTION_KEY, then rotate the secret";
  if (secret) {
    try {
      body = buildWebhookBody(
        event,
        subscription.apiVersion,
        await options.resolveRepresentation(event),
        customerData,
      );
    } catch (error) {
      internalError = `representation_failed: ${normalizeError(error)}`;
    }
  }

  // Our own failures (secret, representation) retry without counting against
  // the endpoint's health.
  if (!secret || body === null) {
    return recordFailure(options, delivery, subscription, claimId, {
      ok: false,
      responseStatus: null,
      durationMs: 0,
      responseExcerpt: null,
      error: internalError ?? "delivery_not_built",
    }, { countsAgainstEndpoint: false });
  }

  const result = await sendWebhookRequest({
    url: subscription.url,
    secret,
    body,
    eventId: event.id,
    topic: event.topic,
    apiVersion: subscription.apiVersion,
    fetch: options.fetch,
  });
  if (result.ok) {
    await safeBatch(db, [
      db.update(webhookDeliveries)
        .set({
          status: "succeeded",
          claimId: null,
          claimExpiresAt: null,
          lastAttemptAt: sql`unixepoch()`,
          responseStatus: result.responseStatus,
          durationMs: result.durationMs,
          responseExcerpt: result.responseExcerpt,
          lastError: null,
          deliveredAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        })
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.claimId, claimId))),
      db.update(webhookSubscriptions)
        .set({ failureStreak: 0, failingSince: null, lastSuccessAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
        .where(eq(webhookSubscriptions.id, subscription.id)),
    ]);
    return { status: "succeeded", deliveryId, subscriptionDisabled: false, retryInSeconds: null };
  }
  const urlRefused = result.error?.startsWith("url_refused") ?? false;
  // A URL the guard refuses will never be accepted: stop retrying it.
  return recordFailure(options, delivery, subscription, claimId, result, {
    countsAgainstEndpoint: true,
    terminal: urlRefused,
  });
}

/** Why an app's delivery may not send under its live grant, or null when it may. */
function appDeliveryRefusal(access: AppWebhookAccess | null, url: string, topic: EventTopicFilter): string | null {
  if (!access) return "app_inactive";
  if (!eventFilterCovered(topic, access.topics)) return "app_topic_not_granted";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "app_host_not_granted";
  }
  return isPluginHostAllowed(parsed.hostname, access.allowedHosts, parsed.port) ? null : "app_host_not_granted";
}

async function finishDelivery(
  db: Database,
  delivery: WebhookDelivery,
  claimId: string,
  outcome: { status: WebhookDeliveryStatus; error: string },
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      status: outcome.status,
      claimId: null,
      claimExpiresAt: null,
      lastError: outcome.error,
      nextAttemptAt: NEVER,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.claimId, claimId)));
}

async function recordFailure(
  options: Parameters<typeof processWebhookDelivery>[0],
  delivery: WebhookDelivery,
  subscription: WebhookSubscription,
  claimId: string,
  result: WebhookAttemptResult,
  policy: { countsAgainstEndpoint: boolean; terminal?: boolean },
): Promise<WebhookDeliveryOutcome> {
  const { db } = options;
  const attempts = Number(delivery.attempts);
  const exhausted = policy.terminal === true || attempts >= WEBHOOK_MAX_ATTEMPTS;
  const retryInSeconds = exhausted ? null : webhookRetryDelaySeconds(attempts);
  const statements: BatchItem<"sqlite">[] = [
    db.update(webhookDeliveries)
      .set({
        status: exhausted ? "exhausted" : "failed",
        claimId: null,
        claimExpiresAt: null,
        lastAttemptAt: sql`unixepoch()`,
        responseStatus: result.responseStatus,
        durationMs: result.durationMs,
        responseExcerpt: result.responseExcerpt,
        lastError: result.error ? normalizeError(result.error) : null,
        nextAttemptAt: exhausted ? NEVER : sql`unixepoch() + ${retryInSeconds}`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.claimId, claimId))),
  ];
  if (policy.countsAgainstEndpoint) {
    statements.push(
      db.update(webhookSubscriptions)
        .set({
          failureStreak: sql`${webhookSubscriptions.failureStreak} + 1`,
          failingSince: sql`COALESCE(${webhookSubscriptions.failingSince}, unixepoch())`,
          lastFailureAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(webhookSubscriptions.id, subscription.id)),
    );
  }
  await safeBatch(db, statements);

  let subscriptionDisabled = false;
  if (policy.countsAgainstEndpoint) {
    const disabled = await db
      .update(webhookSubscriptions)
      .set({
        status: "disabled",
        disabledReason: "failing",
        disabledAt: sql`unixepoch()`,
        version: sql`${webhookSubscriptions.version} + 1`,
        updatedAt: sql`unixepoch()`,
      })
      .where(and(
        eq(webhookSubscriptions.id, subscription.id),
        eq(webhookSubscriptions.status, "active"),
        gte(webhookSubscriptions.failureStreak, WEBHOOK_DISABLE_MIN_FAILURES),
        lte(webhookSubscriptions.failingSince, sql`unixepoch() - ${WEBHOOK_DISABLE_AFTER_FAILING_SECONDS}`),
      ))
      .returning({ id: webhookSubscriptions.id, url: webhookSubscriptions.url });
    if (disabled[0]) {
      subscriptionDisabled = true;
      // Ids only in logs; the URL is merchant configuration, not buyer data.
      console.warn(`[webhooks] Subscription ${disabled[0].id} disabled after sustained delivery failure`);
      await options.onSubscriptionDisabled?.(disabled[0]).catch((error: unknown) => {
        console.warn(`[webhooks] Disabled-subscription notice for ${disabled[0]!.id} failed:`, normalizeError(error));
      });
    }
  }

  return { status: exhausted ? "exhausted" : "failed", deliveryId: delivery.id, subscriptionDisabled, retryInSeconds };
}

// ── Scheduled drain ───────────────────────────────────────────────────────

/** Due retries and expired leases, oldest first: the ids a drain sends next. */
export async function listDueWebhookDeliveries(db: Database, limit = MAX_DELIVERY_FLUSH_LIMIT): Promise<string[]> {
  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(deliveryClaimableCondition())
    .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.id))
    .limit(Math.max(1, Math.min(limit, MAX_DELIVERY_FLUSH_LIMIT)))
    .all();
  return due.map((row) => row.id);
}

// ── Admin actions and reads ───────────────────────────────────────────────

export interface WebhookDeliveryView {
  id: string;
  subscriptionId: string;
  eventId: string | null;
  kind: "event" | "test";
  topic: string;
  resourceType: string | null;
  resourceId: string | null;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  responseStatus: number | null;
  durationMs: number | null;
  responseExcerpt: string | null;
  error: string | null;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
}

export function toWebhookDeliveryView(row: WebhookDelivery): WebhookDeliveryView {
  const waiting = row.status === "pending" || row.status === "failed";
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    eventId: row.eventId ?? null,
    kind: row.kind,
    topic: row.topic,
    resourceType: row.resourceType ?? null,
    resourceId: row.resourceId ?? null,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: row.kind === "test" ? 1 : WEBHOOK_MAX_ATTEMPTS,
    responseStatus: row.responseStatus ?? null,
    durationMs: row.durationMs ?? null,
    responseExcerpt: row.responseExcerpt ?? null,
    error: row.lastError ?? null,
    nextAttemptAt: waiting && Number(row.nextAttemptAt) < NEVER ? Number(row.nextAttemptAt) : null,
    lastAttemptAt: row.lastAttemptAt ?? null,
    deliveredAt: row.deliveredAt ?? null,
    createdAt: Number(row.createdAt),
  };
}

export const DELIVERY_LIST_MAX_LIMIT = 100;

export async function listWebhookDeliveries(db: Database, subscriptionId: string, options: {
  status?: WebhookDeliveryStatus;
  cursor?: string;
  limit?: number;
}): Promise<{ deliveries: WebhookDeliveryView[]; nextCursor: string | null }> {
  const exists = await db.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId)).get();
  if (!exists) throw new NotFoundError("Webhook not found");
  const limit = Math.max(1, Math.min(options.limit ?? 25, DELIVERY_LIST_MAX_LIMIT));
  const conditions = [
    eq(webhookDeliveries.subscriptionId, subscriptionId),
    options.status ? eq(webhookDeliveries.status, options.status) : undefined,
    options.cursor ? lt(webhookDeliveries.id, options.cursor) : undefined,
  ].filter((condition) => condition !== undefined);
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  return {
    deliveries: page.map(toWebhookDeliveryView),
    nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

/** Staff "Retry": a failed, exhausted or cancelled event delivery starts a fresh retry cycle now (the caller sends it). */
export async function retryWebhookDelivery(
  db: Database,
  subscriptionId: string,
  deliveryId: string,
): Promise<WebhookDeliveryView> {
  const subscription = await db
    .select({ status: webhookSubscriptions.status })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, subscriptionId))
    .get();
  if (!subscription) throw new NotFoundError("Webhook not found");
  if (subscription.status !== "active") throw new ConflictError("Turn the webhook on before retrying its deliveries.");
  const rows = await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attempts: 0,
      claimId: null,
      claimExpiresAt: null,
      nextAttemptAt: sql`unixepoch()`,
      lastError: null,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(webhookDeliveries.id, deliveryId),
      eq(webhookDeliveries.subscriptionId, subscriptionId),
      eq(webhookDeliveries.kind, "event"),
      inArray(webhookDeliveries.status, ["failed", "exhausted", "cancelled"]),
      sql`${webhookDeliveries.eventId} IS NOT NULL`,
    ))
    .returning();
  if (!rows[0]) {
    const existing = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.subscriptionId, subscriptionId)))
      .get();
    if (!existing) throw new NotFoundError("Delivery not found");
    throw new ValidationError("Only failed, exhausted or cancelled event deliveries can be retried.");
  }
  return toWebhookDeliveryView(rows[0]);
}

/**
 * Staff "Send test": one synchronous signed POST of a `webhook.test` body,
 * recorded as a `test` delivery. It never retries and never changes the
 * endpoint's health.
 */
export async function sendWebhookTest(
  db: Database,
  subscriptionId: string,
  options: { encryptionKey: string | undefined; fetch?: WebhookFetch },
): Promise<WebhookDeliveryView> {
  const subscription = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId)).get();
  if (!subscription) throw new NotFoundError("Webhook not found");
  const secret = await readWebhookSecret(subscription, options.encryptionKey);
  const testEventId = `evt_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const body = JSON.stringify({
    id: testEventId,
    topic: WEBHOOK_TEST_TOPIC,
    apiVersion: subscription.apiVersion,
    occurredAt: new Date().toISOString(),
    resource: null,
    facts: {},
    data: { subscriptionId: subscription.id, message: "Test delivery from Scalius. Answer with a 2xx status." },
  });
  const result: WebhookAttemptResult = secret
    ? await sendWebhookRequest({
      url: subscription.url,
      secret,
      body,
      eventId: testEventId,
      topic: WEBHOOK_TEST_TOPIC,
      apiVersion: subscription.apiVersion,
      fetch: options.fetch,
    })
    : { ok: false, responseStatus: null, durationMs: 0, responseExcerpt: null, error: "signing_secret_unreadable: check CREDENTIAL_ENCRYPTION_KEY, then rotate the secret" };
  const rows = await db
    .insert(webhookDeliveries)
    .values({
      id: newDeliveryId(),
      subscriptionId: subscription.id,
      eventId: null,
      kind: "test",
      topic: WEBHOOK_TEST_TOPIC,
      status: result.ok ? "succeeded" : "failed",
      attempts: 1,
      nextAttemptAt: NEVER,
      lastAttemptAt: sql`unixepoch()`,
      responseStatus: result.responseStatus,
      durationMs: result.durationMs,
      responseExcerpt: result.responseExcerpt,
      lastError: result.error ? normalizeError(result.error) : null,
      deliveredAt: result.ok ? sql`unixepoch()` : null,
    })
    .returning();
  return toWebhookDeliveryView(rows[0]!);
}

// ── Retention ─────────────────────────────────────────────────────────────

/** Dispatched events are kept a week; dead-lettered ones and deliveries a month. */
export const EVENT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const DEAD_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const DELIVERY_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const PRUNE_BATCH_SIZE = 500;

/**
 * Bounded deletes (at most 500 rows per table per run) of settled events and
 * terminal deliveries past retention. Deliveries keep their topic and
 * resource after their event is pruned (the foreign key sets null).
 */
export async function pruneEventsAndDeliveries(db: Database, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ events: number; deliveries: number }> {
  const deliveries = await db
    .delete(webhookDeliveries)
    .where(inArray(
      webhookDeliveries.id,
      db.select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(and(
          lt(webhookDeliveries.createdAt, nowSeconds - DELIVERY_RETENTION_SECONDS),
          inArray(webhookDeliveries.status, ["succeeded", "failed", "exhausted", "cancelled"]),
        ))
        .limit(PRUNE_BATCH_SIZE),
    ))
    .returning({ id: webhookDeliveries.id });
  const events = await db
    .delete(eventOutbox)
    .where(inArray(
      eventOutbox.id,
      db.select({ id: eventOutbox.id })
        .from(eventOutbox)
        .where(or(
          and(eq(eventOutbox.status, "dispatched"), lt(eventOutbox.dispatchedAt, nowSeconds - EVENT_RETENTION_SECONDS)),
          and(eq(eventOutbox.status, "dead_lettered"), lt(eventOutbox.occurredAt, nowSeconds - DEAD_EVENT_RETENTION_SECONDS)),
        ))
        .limit(PRUNE_BATCH_SIZE),
    ))
    .returning({ id: eventOutbox.id });
  return { events: events.length, deliveries: deliveries.length };
}

/** Each run of C0 control characters or DEL becomes one space. */
function withoutControlCharacters(value: string): string {
  let out = "";
  let inRun = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const control = code < 0x20 || code === 0x7f;
    if (control && !inRun) out += " ";
    if (!control) out += character;
    inRun = control;
  }
  return out;
}
