// Warranty (Wave B §5). Reusable policies with immutable revisions; a product
// references a policy, and checkout freezes the current revision onto the
// order line (`order_items.warranty_revision_id`). A trigger on the fulfilment
// ledger creates one warranty record per fulfilment line (start = handover,
// expiry from the revision) and voids it with its fulfilment. Claims are
// records plus a `warranty_claim` conversation; they never move money, stock
// or order status. Vocabulary lives in `@scalius/shared/warranty`.
//
// Lifetime (0214): `lifetime = 1` is a duration with no end. SQLite cannot
// alter the duration CHECKs of these referenced tables, so a lifetime policy
// and revision keep the longest period (120 years) in `duration_value` and
// `duration_unit`, which an older reader shows; every reader here reads
// `lifetime` first, and its records have no `expires_at`.
//
// App coverage (0214): an app issues records for units of an order line
// under its own policy (`warranty_policies.app_id`, keyed by the app's
// `app_key`), one record per unit with a buyer-facing `code`; they have no
// fulfilment line and are voided by the app.

import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { orders, orderItems } from "./orders";
import { orderFulfillments, orderFulfillmentLines } from "./fulfilment";
import { conversations } from "./conversations";

export const warrantyPolicies = sqliteTable("warranty_policies", {
    /** `wrp_` + random. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    provider: text("provider", { enum: ["brand", "store"] }).notNull(),
    durationValue: integer("duration_value").notNull(),
    /** The SQLite date modifier word, so triggers compute expiry without CASE. */
    durationUnit: text("duration_unit", { enum: ["days", "months", "years"] }).notNull(),
    /** "7-day replacement"; NULL = none. */
    replacementDays: integer("replacement_days"),
    terms: text("terms"),
    /**
     * The revision checkout freezes onto lines. Not a foreign key (revisions
     * reference their policy); the service writes it with the revision insert.
     */
    currentRevisionId: text("current_revision_id").notNull(),
    archivedAt: integer("archived_at"),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
    /** 1: the warranty never ends (0214); `duration_*` then hold 120 years. */
    lifetime: integer("lifetime").notNull().default(0),
    /** The app that owns this policy (its coverage plans), or NULL for the store's own. */
    appId: text("app_id"),
    /** The app's key for the plan, unique per app; set exactly with `app_id`. */
    appKey: text("app_key"),
}, (table) => [
    index("warranty_policies_archived_idx").on(table.archivedAt, table.name),
    uniqueIndex("warranty_policies_app_key_unique").on(table.appId, table.appKey).where(sql`${table.appId} IS NOT NULL`),
    check("warranty_policies_id_shape", sql`substr(${table.id}, 1, 4) = 'wrp_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("warranty_policies_name_length", sql`length(trim(${table.name})) BETWEEN 1 AND 80`),
    check("warranty_policies_provider_check", sql`${table.provider} IN ('brand', 'store')`),
    check("warranty_policies_duration_range", sql`${table.durationValue} BETWEEN 1 AND 120`),
    check("warranty_policies_duration_unit_check", sql`${table.durationUnit} IN ('days', 'months', 'years')`),
    check("warranty_policies_replacement_range", sql`${table.replacementDays} IS NULL OR ${table.replacementDays} BETWEEN 0 AND 90`),
    check("warranty_policies_terms_length", sql`${table.terms} IS NULL OR length(${table.terms}) <= 4000`),
    check("warranty_policies_version_positive", sql`${table.version} >= 1`),
    check("warranty_policies_lifetime_check", sql`${table.lifetime} = 0 OR (${table.lifetime} = 1 AND ${table.durationValue} = 120 AND ${table.durationUnit} = 'years')`),
    check("warranty_policies_app_shape", sql`(${table.appId} IS NULL) = (${table.appKey} IS NULL)`),
]);

/** Immutable buyer-facing copies of a policy; an edit inserts a new revision. */
export const warrantyPolicyRevisions = sqliteTable("warranty_policy_revisions", {
    /** `wrr_` + random. */
    id: text("id").primaryKey(),
    policyId: text("policy_id")
        .notNull()
        .references(() => warrantyPolicies.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    provider: text("provider", { enum: ["brand", "store"] }).notNull(),
    durationValue: integer("duration_value").notNull(),
    durationUnit: text("duration_unit", { enum: ["days", "months", "years"] }).notNull(),
    replacementDays: integer("replacement_days"),
    terms: text("terms"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    /** 1: the warranty never ends (0214), frozen like every other term. */
    lifetime: integer("lifetime").notNull().default(0),
}, (table) => [
    uniqueIndex("warranty_policy_revisions_policy_revision_unique").on(table.policyId, table.revision),
    check("warranty_policy_revisions_id_shape", sql`substr(${table.id}, 1, 4) = 'wrr_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("warranty_policy_revisions_revision_positive", sql`${table.revision} >= 1`),
    check("warranty_policy_revisions_name_length", sql`length(trim(${table.name})) BETWEEN 1 AND 80`),
    check("warranty_policy_revisions_provider_check", sql`${table.provider} IN ('brand', 'store')`),
    check("warranty_policy_revisions_duration_range", sql`${table.durationValue} BETWEEN 1 AND 120`),
    check("warranty_policy_revisions_duration_unit_check", sql`${table.durationUnit} IN ('days', 'months', 'years')`),
    check("warranty_policy_revisions_replacement_range", sql`${table.replacementDays} IS NULL OR ${table.replacementDays} BETWEEN 0 AND 90`),
    check("warranty_policy_revisions_terms_length", sql`${table.terms} IS NULL OR length(${table.terms}) <= 4000`),
    check("warranty_policy_revisions_lifetime_check", sql`${table.lifetime} = 0 OR (${table.lifetime} = 1 AND ${table.durationValue} = 120 AND ${table.durationUnit} = 'years')`),
    // Triggers: warranty_policy_revisions_update_blocked, warranty_policy_revisions_delete_blocked.
]);

/**
 * A warranty record: one per fulfilment line whose order line froze a
 * revision (trigger-created, W1), or one per unit an app issued (0214).
 */
export const orderItemWarranties = sqliteTable("order_item_warranties", {
    /** `wty_` + the fulfilment line id, or `wty_` + random for an app's unit. */
    id: text("id").primaryKey(),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: text("order_item_id")
        .notNull()
        .references(() => orderItems.id, { onDelete: "restrict" }),
    /** The handover; NULL for an app's record. */
    fulfillmentId: text("fulfillment_id")
        .references(() => orderFulfillments.id, { onDelete: "restrict" }),
    fulfillmentLineId: text("fulfillment_line_id")
        .references(() => orderFulfillmentLines.id, { onDelete: "restrict" }),
    revisionId: text("revision_id")
        .notNull()
        .references(() => warrantyPolicyRevisions.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    startsAt: integer("starts_at").notNull(),
    /** NULL: a lifetime warranty, which never ends. */
    expiresAt: integer("expires_at"),
    /** NULL when the revision has no replacement window. */
    replacementUntil: integer("replacement_until"),
    voidedAt: integer("voided_at"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    /** The app that issued it; NULL for a record of the store's own warranty. */
    appId: text("app_id"),
    /** An app record's unit of its line, 1 to the line's quantity. */
    unitNumber: integer("unit_number"),
    /** An app record's buyer-facing id (`8K4-XP2-MN9`): random, never derived from the order. */
    code: text("code"),
}, (table) => [
    uniqueIndex("order_item_warranties_fulfillment_line_unique").on(table.fulfillmentLineId),
    uniqueIndex("order_item_warranties_app_unit_unique")
        .on(table.orderItemId, table.appId, table.unitNumber)
        .where(sql`${table.appId} IS NOT NULL`),
    uniqueIndex("order_item_warranties_code_unique").on(table.code).where(sql`${table.code} IS NOT NULL`),
    index("order_item_warranties_order_idx").on(table.orderId),
    index("order_item_warranties_order_item_idx").on(table.orderItemId),
    index("order_item_warranties_fulfillment_idx").on(table.fulfillmentId),
    index("order_item_warranties_active_expiry_idx")
        .on(table.expiresAt)
        .where(sql`${table.voidedAt} IS NULL`),
    check("order_item_warranties_quantity_positive", sql`${table.quantity} > 0`),
    check("order_item_warranties_window", sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.startsAt}`),
    check(
        "order_item_warranties_source_shape",
        sql`(${table.appId} IS NULL AND ${table.fulfillmentId} IS NOT NULL AND ${table.fulfillmentLineId} IS NOT NULL AND ${table.unitNumber} IS NULL AND ${table.code} IS NULL)
            OR (${table.appId} IS NOT NULL AND ${table.fulfillmentId} IS NULL AND ${table.fulfillmentLineId} IS NULL AND ${table.unitNumber} >= 1 AND ${table.quantity} = 1 AND length(${table.code}) = 11)`,
    ),
]);

export const warrantyClaims = sqliteTable("warranty_claims", {
    /** `wcl_` + random; the claim thread's `subject_id`. */
    id: text("id").primaryKey(),
    warrantyId: text("warranty_id")
        .notNull()
        .references(() => orderItemWarranties.id, { onDelete: "restrict" }),
    orderId: text("order_id")
        .notNull()
        .references(() => orders.id, { onDelete: "restrict" }),
    orderItemId: text("order_item_id")
        .notNull()
        .references(() => orderItems.id, { onDelete: "restrict" }),
    conversationId: text("conversation_id")
        .notNull()
        .references(() => conversations.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["open", "in_progress", "resolved", "rejected"] }).notNull().default("open"),
    resolution: text("resolution", { enum: ["repair", "replacement", "refund", "other"] }),
    quantity: integer("quantity").notNull().default(1),
    openedBy: text("opened_by", { enum: ["customer", "guest_receipt", "staff"] }).notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
    closedAt: integer("closed_at"),
}, (table) => [
    uniqueIndex("warranty_claims_conversation_unique").on(table.conversationId),
    uniqueIndex("warranty_claims_open_unique")
        .on(table.warrantyId)
        .where(sql`${table.status} IN ('open', 'in_progress')`),
    index("warranty_claims_status_created_idx").on(table.status, sql`${table.createdAt} DESC`, table.id),
    index("warranty_claims_order_idx").on(table.orderId),
    // A warranty's latest claims (order pages), and an order line's delete (amendment).
    index("warranty_claims_warranty_idx").on(table.warrantyId),
    index("warranty_claims_order_item_idx").on(table.orderItemId),
    check("warranty_claims_id_shape", sql`substr(${table.id}, 1, 4) = 'wcl_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("warranty_claims_status_check", sql`${table.status} IN ('open', 'in_progress', 'resolved', 'rejected')`),
    check("warranty_claims_resolution_check", sql`${table.resolution} IS NULL OR ${table.resolution} IN ('repair', 'replacement', 'refund', 'other')`),
    check("warranty_claims_resolved_shape", sql`${table.status} <> 'resolved' OR ${table.resolution} IS NOT NULL`),
    check("warranty_claims_closed_shape", sql`(${table.status} IN ('resolved', 'rejected')) = (${table.closedAt} IS NOT NULL)`),
    check("warranty_claims_quantity_positive", sql`${table.quantity} >= 1`),
    check("warranty_claims_opened_by_check", sql`${table.openedBy} IN ('customer', 'guest_receipt', 'staff')`),
    check("warranty_claims_version_positive", sql`${table.version} >= 1`),
]);

export type WarrantyPolicy = InferSelectModel<typeof warrantyPolicies>;
export type WarrantyPolicyRevision = InferSelectModel<typeof warrantyPolicyRevisions>;
export type OrderItemWarranty = InferSelectModel<typeof orderItemWarranties>;
export type WarrantyClaim = InferSelectModel<typeof warrantyClaims>;
