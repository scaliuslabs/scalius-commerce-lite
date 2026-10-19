// Event outbox and webhooks (COMMERCE-HOOKS H3).
//
// `event_outbox` rows are written only by SQL triggers in the same
// transaction as the domain write (scripts/event-outbox-triggers.ts): ids,
// topic, the resource and thin PII-free facts. Dispatch mirrors the
// notification outbox (pending → processing → dispatched | failed →
// dead_lettered); the API dispatches after each write and on every cron tick.
//
// `webhook_subscriptions` are merchant endpoints (https only, SSRF-checked);
// the signing secret is stored encrypted under CREDENTIAL_ENCRYPTION_KEY and
// shown once. `webhook_event_deliveries` is the bounded per-endpoint attempt log:
// one row per (subscription, event) with its retry state and the last
// attempt's status code, duration and a short masked response excerpt.

import { sqliteTable, text, integer, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { user } from "./auth";

export const EVENT_OUTBOX_STATUSES = [
    "pending",
    "processing",
    "dispatched",
    "failed",
    "dead_lettered",
] as const;
export type EventOutboxStatus = (typeof EVENT_OUTBOX_STATUSES)[number];

/** Active webhook/app topic filters, maintained atomically by subscription triggers. */
export const eventDemand = sqliteTable("event_demand", {
    filter: text("filter").primaryKey(),
});

export const eventOutbox = sqliteTable("event_outbox", {
    /** `evt_` + epoch milliseconds + 12 random hex: unique and time-sortable. */
    id: text("id").primaryKey(),
    /** A topic of the event catalog (`@scalius/shared/events`). */
    topic: text("topic").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    /** Thin facts as JSON (ids, from/to states, quantities); never PII or money. */
    data: text("data").notNull(),
    occurredAt: integer("occurred_at").notNull().default(UNIX_NOW),
    status: text("status", { enum: EVENT_OUTBOX_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(UNIX_NOW),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    lastError: text("last_error"),
    /** Unused since 0148 (queue retirement); the Turso engine cannot drop the column. */
    queuedAt: integer("queued_at"),
    dispatchedAt: integer("dispatched_at"),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("event_outbox_due_idx").on(table.status, table.nextAttemptAt),
    index("event_outbox_claim_idx").on(table.status, table.claimExpiresAt),
    index("event_outbox_resource_idx").on(table.resourceType, table.resourceId, table.occurredAt),
    index("event_outbox_topic_idx").on(table.topic, table.occurredAt),
    index("event_outbox_occurred_idx").on(table.occurredAt),
    check("event_outbox_status_check", sql`${table.status} IN ('pending', 'enqueueing', 'queued', 'processing', 'dispatched', 'failed', 'dead_lettered')`),
    check("event_outbox_data_json", sql`json_valid(${table.data})`),
]);

export const WEBHOOK_SUBSCRIPTION_STATUSES = ["active", "disabled"] as const;
export type WebhookSubscriptionStatus = (typeof WEBHOOK_SUBSCRIPTION_STATUSES)[number];
/** `manual`: staff turned it off; `failing`: sustained delivery failure turned it off. */
export const WEBHOOK_DISABLED_REASONS = ["manual", "failing"] as const;
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];

export const webhookSubscriptions = sqliteTable("webhook_subscriptions", {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    /** JSON array of topic filters: exact topics, `<resource>.*` or `*`. */
    topics: text("topics").notNull(),
    /** The payload version deliveries use (`EVENTS_API_VERSION`). */
    apiVersion: text("api_version").notNull(),
    /**
     * JSON array of the protected customer data categories (`name`, `email`,
     * `phone`, `address`) its deliveries include; the rest read null.
     * Empty (the default): no buyer contact data leaves the store.
     */
    customerData: text("customer_data").notNull().default("[]"),
    description: text("description"),
    /** `enc:` AES-GCM ciphertext of the signing secret (CREDENTIAL_ENCRYPTION_KEY). */
    secretCiphertext: text("secret_ciphertext").notNull(),
    /** The secret's last four characters, so staff can tell secrets apart. */
    secretHint: text("secret_hint").notNull(),
    status: text("status", { enum: WEBHOOK_SUBSCRIPTION_STATUSES }).notNull().default("active"),
    disabledReason: text("disabled_reason", { enum: WEBHOOK_DISABLED_REASONS }),
    disabledAt: integer("disabled_at"),
    /** Consecutive failed attempts since the last success. */
    failureStreak: integer("failure_streak").notNull().default(0),
    /** When the current failure streak began; null while healthy. */
    failingSince: integer("failing_since"),
    lastSuccessAt: integer("last_success_at"),
    lastFailureAt: integer("last_failure_at"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("webhook_subscriptions_status_idx").on(table.status, table.createdAt),
    check("webhook_subscriptions_status_check", sql`${table.status} IN ('active', 'disabled')`),
    check(
        "webhook_subscriptions_disabled_shape",
        sql`(${table.status} = 'active' AND ${table.disabledReason} IS NULL AND ${table.disabledAt} IS NULL) OR (${table.status} = 'disabled' AND ${table.disabledReason} IN ('manual', 'failing') AND ${table.disabledAt} IS NOT NULL)`,
    ),
    check("webhook_subscriptions_url_length", sql`length(${table.url}) BETWEEN 9 AND 2048 AND substr(${table.url}, 1, 8) = 'https://'`),
    check("webhook_subscriptions_topics_json", sql`json_valid(${table.topics}) AND substr(${table.topics}, 1, 1) = '['`),
    check("webhook_subscriptions_description_length", sql`${table.description} IS NULL OR length(${table.description}) <= 200`),
    check("webhook_subscriptions_failure_streak_nonnegative", sql`${table.failureStreak} >= 0`),
    check("webhook_subscriptions_version_positive", sql`${table.version} >= 1`),
]);

export const WEBHOOK_DELIVERY_STATUSES = [
    "pending",
    "processing",
    "succeeded",
    "failed",
    "exhausted",
    "cancelled",
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const webhookDeliveries = sqliteTable("webhook_event_deliveries", {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id")
        .notNull()
        .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    /** Null for a dashboard test send; set null when the event is pruned. */
    eventId: text("event_id").references(() => eventOutbox.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["event", "test"] }).notNull().default("event"),
    topic: text("topic").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    status: text("status", { enum: WEBHOOK_DELIVERY_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(UNIX_NOW),
    claimId: text("claim_id"),
    claimExpiresAt: integer("claim_expires_at"),
    /** Unused since 0148 (queue retirement); the Turso engine cannot drop the column. */
    queuedAt: integer("queued_at"),
    lastAttemptAt: integer("last_attempt_at"),
    /** HTTP status of the last attempt; null when no response arrived. */
    responseStatus: integer("response_status"),
    durationMs: integer("duration_ms"),
    /** At most 256 characters of the response body, secrets masked. */
    responseExcerpt: text("response_excerpt"),
    lastError: text("last_error"),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("webhook_event_deliveries_subscription_event_unique")
        .on(table.subscriptionId, table.eventId)
        .where(sql`${table.eventId} IS NOT NULL`),
    index("webhook_event_deliveries_due_idx").on(table.status, table.nextAttemptAt),
    index("webhook_event_deliveries_claim_idx").on(table.status, table.claimExpiresAt),
    index("webhook_event_deliveries_subscription_created_idx").on(table.subscriptionId, table.createdAt),
    index("webhook_event_deliveries_event_idx").on(table.eventId).where(sql`${table.eventId} IS NOT NULL`),
    index("webhook_event_deliveries_created_idx").on(table.createdAt),
    check("webhook_event_deliveries_kind_check", sql`${table.kind} IN ('event', 'test')`),
    check("webhook_event_deliveries_status_check", sql`${table.status} IN ('pending', 'enqueueing', 'queued', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')`),
    check("webhook_event_deliveries_excerpt_length", sql`${table.responseExcerpt} IS NULL OR length(${table.responseExcerpt}) <= 256`),
    check("webhook_event_deliveries_error_length", sql`${table.lastError} IS NULL OR length(${table.lastError}) <= 500`),
]);

export type EventOutboxRow = InferSelectModel<typeof eventOutbox>;
export type WebhookSubscription = InferSelectModel<typeof webhookSubscriptions>;
export type WebhookDelivery = InferSelectModel<typeof webhookDeliveries>;
