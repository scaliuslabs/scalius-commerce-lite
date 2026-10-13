// Customers & marketing (migration 0108): marketing consent per customer and
// channel with its audit log, customer tags, saved customer segments, the
// trigger-maintained order statistics segments filter on, and the promotion
// to segment link.
//
// Consent is a fact about one customer record and one address. A row covers
// the contact it was given for (`contact`, normalised: lower-case e-mail or
// E.164 phone); when the customer's e-mail or phone later changes, the old
// row no longer applies to the new address (reads compare it). Every state
// change is copied into `customer_marketing_consent_events` by a trigger in
// the same transaction (with the actor, note and consent text the writer put
// on the row), and emits `customer.consent_changed` into the event outbox.
//
// `customer_order_stats` is maintained only by the 0108 triggers on `orders`
// (recomputed from the customer's orders on every relevant order write), so
// segment filters on spend, order count and order dates are indexed reads.
// Since 0128 a trigger on `customers` also gives every new customer its
// zero row, so the customer list sorts by order facts from these indexes.
// Application code never writes it.

import { sqliteTable, text, integer, index, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { customers } from "./customers";
import { promotions } from "./promotions";

/** Mirrors `MARKETING_CHANNELS` in `@scalius/shared/customer-marketing`. */
export const MARKETING_CHANNEL_VALUES = ["email", "sms", "whatsapp", "push"] as const;
/** Mirrors `MARKETING_CONSENT_STATES`. `pending` is e-mail double opt-in only. */
export const MARKETING_CONSENT_STATE_VALUES = ["subscribed", "unsubscribed", "pending"] as const;
/** Mirrors `MARKETING_CONSENT_SOURCES`. */
export const MARKETING_CONSENT_SOURCE_VALUES = [
    "checkout",
    "account",
    "newsletter",
    "admin",
    "import",
    "plugin",
    "link",
] as const;
/** Mirrors `MARKETING_CONSENT_ACTORS`. */
export const MARKETING_CONSENT_ACTOR_VALUES = ["buyer", "staff", "plugin", "system"] as const;

const inList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

/** Immutable reviewed content and audience; drafts remain in the authoring app. */
export const marketingRuns = sqliteTable("marketing_runs", {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    draftId: text("draft_id").notNull(),
    draftRevision: integer("draft_revision").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    name: text("name").notNull(),
    channel: text("channel", { enum: MARKETING_CHANNEL_VALUES }).notNull(),
    contentJson: text("content_json").notNull(),
    audienceJson: text("audience_json").notNull(),
    segmentId: text("segment_id").notNull(),
    segmentRevision: integer("segment_revision").notNull(),
    segmentName: text("segment_name").notNull(),
    timeZone: text("time_zone").notNull(),
    evaluatedAt: integer("evaluated_at"),
    scheduledAt: integer("scheduled_at").notNull(),
    status: text("status", { enum: ["scheduled", "enrolling", "sending", "completed", "cancelled", "failed"] }).notNull().default("scheduled"),
    revision: integer("revision").notNull().default(1),
    enrollCursor: text("enroll_cursor"),
    dispatchCursor: text("dispatch_cursor"),
    step: integer("step").notNull().default(0),
    enrolledCount: integer("enrolled_count").notNull().default(0),
    deduplicatedCount: integer("deduplicated_count").notNull().default(0),
    createdBy: text("created_by").notNull(),
    cancelledBy: text("cancelled_by"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    cancelledAt: integer("cancelled_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("marketing_runs_request_unique").on(table.pluginId, table.idempotencyKey),
    index("marketing_runs_due_idx").on(table.status, table.scheduledAt, table.id),
    index("marketing_runs_app_list_idx").on(table.pluginId, table.createdAt, table.id),
    check("marketing_runs_channel", sql`${table.channel} IN ('email', 'sms', 'whatsapp', 'push')`),
    check("marketing_runs_status", sql`${table.status} IN ('scheduled', 'enrolling', 'sending', 'completed', 'cancelled', 'failed')`),
    check("marketing_runs_content", sql`json_valid(${table.contentJson}) AND length(${table.contentJson}) <= 64000`),
    check("marketing_runs_audience", sql`json_valid(${table.audienceJson}) AND length(${table.audienceJson}) <= 8000`),
    check("marketing_runs_revision", sql`${table.revision} > 0 AND ${table.draftRevision} > 0 AND ${table.segmentRevision} > 0`),
    check("marketing_runs_counts", sql`${table.step} >= 0 AND ${table.enrolledCount} >= 0 AND ${table.deduplicatedCount} >= 0`),
]);

/** A fixed target identity; never retarget after a customer's address changes. */
export const marketingRunRecipients = sqliteTable("marketing_run_recipients", {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => marketingRuns.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    recipientHash: text("recipient_hash").notNull(),
    outboxId: text("outbox_id"),
    status: text("status", { enum: ["enrolled", "queued", "sending", "accepted", "delivered", "failed", "unconfirmed", "skipped", "cancelled"] }).notNull().default("enrolled"),
    reason: text("reason"),
    dispatchStartedAt: integer("dispatch_started_at"),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("marketing_run_recipients_target_unique").on(table.runId, table.recipientHash),
    uniqueIndex("marketing_run_recipients_outbox_unique").on(table.outboxId).where(sql`${table.outboxId} IS NOT NULL`),
    index("marketing_run_recipients_progress_idx").on(table.runId, table.status, table.id),
    check("marketing_run_recipients_status", sql`${table.status} IN ('enrolled', 'queued', 'sending', 'accepted', 'delivered', 'failed', 'unconfirmed', 'skipped', 'cancelled')`),
    check("marketing_run_recipients_hash", sql`length(${table.recipientHash}) = 64`),
]);

/** The default marketing frequency cap is one attempted send per channel/contact/local day. */
export const marketingContactSlots = sqliteTable("marketing_contact_slots", {
    channel: text("channel", { enum: MARKETING_CHANNEL_VALUES }).notNull(),
    recipientHash: text("recipient_hash").notNull(),
    day: text("day").notNull(),
    runId: text("run_id").notNull(),
    recipientId: text("recipient_id").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.channel, table.recipientHash, table.day] }),
    index("marketing_contact_slots_retention_idx").on(table.day),
    check("marketing_contact_slots_channel", sql`${table.channel} IN ('email', 'sms', 'whatsapp', 'push')`),
    check("marketing_contact_slots_hash", sql`length(${table.recipientHash}) = 64`),
    check("marketing_contact_slots_day", sql`length(${table.day}) = 10`),
]);

export const customerMarketingConsents = sqliteTable("customer_marketing_consents", {
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: MARKETING_CHANNEL_VALUES }).notNull(),
    state: text("state", { enum: MARKETING_CONSENT_STATE_VALUES }).notNull(),
    /** The normalised address this consent was given for. */
    contact: text("contact").notNull(),
    /** Where the latest state change came from. */
    source: text("source", { enum: MARKETING_CONSENT_SOURCE_VALUES }).notNull(),
    /** Who made the latest change; copied into the audit log by trigger. */
    actor: text("actor", { enum: MARKETING_CONSENT_ACTOR_VALUES }).notNull(),
    /** Staff user id or plugin id behind the latest change. */
    actorId: text("actor_id"),
    /** Staff audit note of the latest change. */
    note: text("note"),
    /** `<surface>:<12 hex>` of the consent text shown when the buyer agreed. */
    consentTextVersion: text("consent_text_version"),
    /** The consent text shown (kept on the audit row as proof). */
    consentText: text("consent_text"),
    /** When the current subscription began (double opt-in: when confirmed). */
    subscribedAt: integer("subscribed_at"),
    unsubscribedAt: integer("unsubscribed_at"),
    /** Double opt-in: when the confirmation mail was last requested. */
    requestedAt: integer("requested_at"),
    /** Double opt-in: SHA-256 hex of the single-use confirmation token. */
    confirmationHash: text("confirmation_hash"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.customerId, table.channel] }),
    uniqueIndex("customer_marketing_consents_confirmation_unique")
        .on(table.confirmationHash)
        .where(sql`${table.confirmationHash} IS NOT NULL`),
    index("customer_marketing_consents_channel_state_idx").on(table.channel, table.state, table.customerId),
    check("customer_marketing_consents_channel_check", sql`${table.channel} IN (${sql.raw(inList(MARKETING_CHANNEL_VALUES))})`),
    check("customer_marketing_consents_state_check", sql`${table.state} IN (${sql.raw(inList(MARKETING_CONSENT_STATE_VALUES))})`),
    check("customer_marketing_consents_source_check", sql`${table.source} IN (${sql.raw(inList(MARKETING_CONSENT_SOURCE_VALUES))})`),
    check("customer_marketing_consents_actor_check", sql`${table.actor} IN (${sql.raw(inList(MARKETING_CONSENT_ACTOR_VALUES))})`),
    check("customer_marketing_consents_pending_email", sql`${table.state} <> 'pending' OR ${table.channel} = 'email'`),
    check(
        "customer_marketing_consents_pending_shape",
        sql`(${table.state} = 'pending') = (${table.confirmationHash} IS NOT NULL AND ${table.requestedAt} IS NOT NULL)`,
    ),
    check("customer_marketing_consents_subscribed_shape", sql`${table.state} <> 'subscribed' OR ${table.subscribedAt} IS NOT NULL`),
    check("customer_marketing_consents_contact_length", sql`length(${table.contact}) BETWEEN 3 AND 320`),
    check("customer_marketing_consents_note_length", sql`${table.note} IS NULL OR length(${table.note}) BETWEEN 1 AND 500`),
    check(
        "customer_marketing_consents_text_length",
        sql`(${table.consentTextVersion} IS NULL OR length(${table.consentTextVersion}) BETWEEN 3 AND 64) AND (${table.consentText} IS NULL OR length(${table.consentText}) BETWEEN 1 AND 500)`,
    ),
]);

/** One row per consent state change, written only by the 0108 triggers. */
export const customerMarketingConsentEvents = sqliteTable("customer_marketing_consent_events", {
    id: text("id").primaryKey(),
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: MARKETING_CHANNEL_VALUES }).notNull(),
    previousState: text("previous_state", { enum: MARKETING_CONSENT_STATE_VALUES }),
    state: text("state", { enum: MARKETING_CONSENT_STATE_VALUES }).notNull(),
    source: text("source", { enum: MARKETING_CONSENT_SOURCE_VALUES }).notNull(),
    actor: text("actor", { enum: MARKETING_CONSENT_ACTOR_VALUES }).notNull(),
    actorId: text("actor_id"),
    note: text("note"),
    contact: text("contact").notNull(),
    consentTextVersion: text("consent_text_version"),
    consentText: text("consent_text"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    index("customer_marketing_consent_events_customer_idx").on(table.customerId, table.createdAt),
]);

/**
 * A customer's tags (customer_tags is a retired legacy name): normalised (trimmed, inner spaces collapsed, lower-case;
 * `@scalius/shared/customer-marketing` `normalizeCustomerTag`), at most 40
 * characters. `(tag, customer_id)` serves "customers with tag X".
 */
export const customerTagLinks = sqliteTable("customer_tag_links", {
    customerId: text("customer_id")
        .notNull()
        .references(() => customers.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.customerId, table.tag] }),
    index("customer_tag_links_tag_idx").on(table.tag, table.customerId),
    check("customer_tag_links_tag_shape", sql`length(${table.tag}) BETWEEN 1 AND 40 AND ${table.tag} = trim(${table.tag}) AND ${table.tag} = lower(${table.tag}) AND instr(${table.tag}, '  ') = 0 AND instr(${table.tag}, ',') = 0`),
]);

/**
 * A saved customer filter. `definition` is the canonical JSON of
 * `customerSegmentDefinitionSchema` (`@scalius/shared/customer-marketing`);
 * membership is evaluated live. Segments are only ever soft-deleted so a
 * promotion that targeted one keeps a valid reference (and matches nobody).
 */
export const customerSegments = sqliteTable("customer_segments", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    definition: text("definition").notNull(),
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
    deletedAt: integer("deleted_at"),
}, (table) => [
    uniqueIndex("customer_segments_name_unique").on(sql`lower(${table.name})`).where(sql`${table.deletedAt} IS NULL`),
    index("customer_segments_list_idx").on(table.deletedAt, table.updatedAt),
    check("customer_segments_id_shape", sql`substr(${table.id}, 1, 4) = 'seg_' AND length(${table.id}) BETWEEN 8 AND 40`),
    check("customer_segments_name_valid", sql`${table.name} = trim(${table.name}) AND length(${table.name}) BETWEEN 1 AND 80`),
    check("customer_segments_description_length", sql`${table.description} IS NULL OR length(${table.description}) BETWEEN 1 AND 300`),
    check("customer_segments_definition_json", sql`json_valid(${table.definition}) AND json_type(${table.definition}) = 'object' AND length(${table.definition}) <= 8000`),
    check("customer_segments_revision_positive", sql`${table.revision} >= 1`),
]);

/**
 * Per-customer order facts for segments and the customer list: orders that
 * are real (not `incomplete`, not deleted), positive paid amounts in minor
 * units, and the first/last order time. Trigger-maintained (0108).
 */
export const customerOrderStats = sqliteTable("customer_order_stats", {
    customerId: text("customer_id")
        .primaryKey()
        .references(() => customers.id, { onDelete: "cascade" }),
    ordersCount: integer("orders_count").notNull().default(0),
    totalSpentMinor: integer("total_spent_minor").notNull().default(0),
    firstOrderAt: integer("first_order_at"),
    lastOrderAt: integer("last_order_at"),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    // The customer list's order-fact sorts walk these in order, ending with
    // the keyset tiebreaker (0128); every customer has a row.
    index("customer_order_stats_orders_list_idx").on(table.ordersCount, table.customerId),
    index("customer_order_stats_spent_list_idx").on(table.totalSpentMinor, table.customerId),
    index("customer_order_stats_first_order_idx").on(table.firstOrderAt),
    index("customer_order_stats_last_order_list_idx").on(table.lastOrderAt, table.customerId),
    check("customer_order_stats_nonnegative", sql`${table.ordersCount} >= 0 AND ${table.totalSpentMinor} >= 0`),
]);

/**
 * A promotion limited to customers in any of these segments (signed-in
 * accounts only). Part of the promotion rule: written through the promotion
 * revision batch, and buyer-visible (public offer reads skip targeted
 * promotions), so it advances `promo:<id>` cache keys.
 */
export const promotionCustomerSegments = sqliteTable("promotion_customer_segments", {
    promotionId: text("promotion_id")
        .notNull()
        .references(() => promotions.id, { onDelete: "cascade" }),
    segmentId: text("segment_id")
        .notNull()
        .references(() => customerSegments.id, { onDelete: "restrict" }),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    primaryKey({ columns: [table.promotionId, table.segmentId] }),
    index("promotion_customer_segments_segment_idx").on(table.segmentId),
]);

export type CustomerMarketingConsent = InferSelectModel<typeof customerMarketingConsents>;
export type CustomerMarketingConsentEvent = InferSelectModel<typeof customerMarketingConsentEvents>;
export type CustomerTagLink = InferSelectModel<typeof customerTagLinks>;
export type CustomerSegment = InferSelectModel<typeof customerSegments>;
export type CustomerOrderStats = InferSelectModel<typeof customerOrderStats>;
export type PromotionCustomerSegment = InferSelectModel<typeof promotionCustomerSegments>;
