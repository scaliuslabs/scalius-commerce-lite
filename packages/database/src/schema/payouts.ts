// Payouts (0202): money an app sends out of the store to a payee through a
// payout provider (the `payout` port), such as a marketplace paying its
// sellers. One row per payout command, written and committed before the
// provider is called, keyed by the app's idempotency key: a retry of the same
// key finds the row and never creates a second payout. `payee_ref` is the
// app's own reference (a seller id), `payee_account_ref` the provider's
// account reference for that payee (never a card or account number the store
// keeps elsewhere). Status moves forward only (triggers): `pending` (committed,
// the provider not yet answered), `processing` (the provider took it), then
// `paid` or `failed`, both final. Money is integer minor units.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { UNIX_NOW } from "./shared";

export const PAYOUT_STATUSES = ["pending", "processing", "paid", "failed"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const payouts = sqliteTable("payouts", {
    /** `pyt_` + random. */
    id: text("id").primaryKey(),
    /** The app that created it; only it reads and changes it. */
    appId: text("app_id").notNull(),
    /** The payout provider (`<plugin id>:<provider id>`). */
    providerId: text("provider_id").notNull(),
    payeeRef: text("payee_ref").notNull(),
    payeeAccountRef: text("payee_account_ref"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    description: text("description"),
    status: text("status", { enum: PAYOUT_STATUSES }).notNull().default("pending"),
    providerRef: text("provider_ref"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** SHA-256 of the request the key was first used for: another request under it is refused. */
    requestHash: text("request_hash").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
    settledAt: integer("settled_at"),
}, (table) => [
    uniqueIndex("payouts_app_key_unique").on(table.appId, table.idempotencyKey),
    uniqueIndex("payouts_provider_ref_unique").on(table.providerId, table.providerRef)
        .where(sql`${table.providerRef} IS NOT NULL`),
    index("payouts_app_updated_idx").on(table.appId, table.updatedAt, table.id),
    check("payouts_id_shape", sql`substr(${table.id}, 1, 4) = 'pyt_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("payouts_app_id_length", sql`length(${table.appId}) BETWEEN 3 AND 100`),
    check("payouts_provider_shape", sql`instr(${table.providerId}, ':') > 1 AND length(${table.providerId}) <= 160`),
    check("payouts_payee_ref_length", sql`length(${table.payeeRef}) BETWEEN 1 AND 128`),
    check("payouts_payee_account_ref_length", sql`${table.payeeAccountRef} IS NULL OR length(${table.payeeAccountRef}) BETWEEN 1 AND 256`),
    check("payouts_amount_positive", sql`${table.amountMinor} > 0`),
    check("payouts_currency_shape", sql`length(${table.currency}) = 3 AND upper(${table.currency}) = ${table.currency}`),
    check("payouts_description_length", sql`${table.description} IS NULL OR length(${table.description}) BETWEEN 1 AND 200`),
    check("payouts_status_check", sql`${table.status} IN ('pending', 'processing', 'paid', 'failed')`),
    check("payouts_provider_ref_length", sql`${table.providerRef} IS NULL OR length(${table.providerRef}) BETWEEN 1 AND 256`),
    check("payouts_failure_shape", sql`(${table.status} = 'failed') = (${table.failureCode} IS NOT NULL) AND (${table.failureCode} IS NULL OR length(${table.failureCode}) BETWEEN 1 AND 64) AND (${table.failureMessage} IS NULL OR length(${table.failureMessage}) BETWEEN 1 AND 300)`),
    check("payouts_settled_shape", sql`(${table.status} IN ('paid', 'failed')) = (${table.settledAt} IS NOT NULL)`),
    check("payouts_key_length", sql`length(${table.idempotencyKey}) BETWEEN 1 AND 200`),
    check("payouts_request_hash_shape", sql`length(${table.requestHash}) = 64`),
    check("payouts_version_positive", sql`${table.version} >= 1`),
    // Triggers: payouts_identity_immutable (who, how much, to whom and the
    // key never change), payouts_status_forward (pending → processing →
    // paid | failed; paid and failed are final), payouts_delete_blocked.
]);

export type Payout = typeof payouts.$inferSelect;

export const PAYOUT_REVERSAL_STATUSES = ["pending", "processing", "reversed", "failed"] as const;
export type PayoutReversalStatus = (typeof PAYOUT_REVERSAL_STATUSES)[number];
/** The most reversals one payout takes (its representation lists them all). */
export const PAYOUT_REVERSALS_MAX = 20;

/**
 * Payout reversals (0206): money an app takes back from a `paid` payout
 * through its provider (a marketplace clawing back a seller's share after a
 * refund). One row per reversal command, committed `pending` before the
 * provider is called, keyed by the app's idempotency key with the request's
 * hash. The reversal names its payout and copies its app, provider and
 * currency; the triggers refuse one on a payout that is not `paid` (or not
 * the app's), one that would take back more than the payout less its other
 * reversals that have not failed, a 21st, an identity change, a backward
 * status (`pending` → `processing` → `reversed` | `failed`, both final) and
 * a delete. Each insert and status move advances its payout's `version` and
 * `updated_at`, so a payout read or synced shows its reversals.
 */
export const payoutReversals = sqliteTable("payout_reversals", {
    /** `pyr_` + random. */
    id: text("id").primaryKey(),
    payoutId: text("payout_id").notNull().references(() => payouts.id, { onDelete: "restrict" }),
    appId: text("app_id").notNull(),
    providerId: text("provider_id").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    reason: text("reason"),
    status: text("status", { enum: PAYOUT_REVERSAL_STATUSES }).notNull().default("pending"),
    providerRef: text("provider_ref"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
    settledAt: integer("settled_at"),
}, (table) => [
    uniqueIndex("payout_reversals_app_key_unique").on(table.appId, table.idempotencyKey),
    uniqueIndex("payout_reversals_provider_ref_unique").on(table.providerId, table.providerRef)
        .where(sql`${table.providerRef} IS NOT NULL`),
    index("payout_reversals_payout_idx").on(table.payoutId, table.createdAt, table.id),
    check("payout_reversals_id_shape", sql`substr(${table.id}, 1, 4) = 'pyr_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("payout_reversals_amount_positive", sql`${table.amountMinor} > 0`),
    check("payout_reversals_currency_shape", sql`length(${table.currency}) = 3 AND upper(${table.currency}) = ${table.currency}`),
    check("payout_reversals_reason_length", sql`${table.reason} IS NULL OR length(${table.reason}) BETWEEN 1 AND 200`),
    check("payout_reversals_status_check", sql`${table.status} IN ('pending', 'processing', 'reversed', 'failed')`),
    check("payout_reversals_provider_ref_length", sql`${table.providerRef} IS NULL OR length(${table.providerRef}) BETWEEN 1 AND 256`),
    check("payout_reversals_failure_shape", sql`(${table.status} = 'failed') = (${table.failureCode} IS NOT NULL) AND (${table.failureCode} IS NULL OR length(${table.failureCode}) BETWEEN 1 AND 64) AND (${table.failureMessage} IS NULL OR length(${table.failureMessage}) BETWEEN 1 AND 300)`),
    check("payout_reversals_settled_shape", sql`(${table.status} IN ('reversed', 'failed')) = (${table.settledAt} IS NOT NULL)`),
    check("payout_reversals_key_length", sql`length(${table.idempotencyKey}) BETWEEN 1 AND 200`),
    check("payout_reversals_request_hash_shape", sql`length(${table.requestHash}) = 64`),
    check("payout_reversals_version_positive", sql`${table.version} >= 1`),
    // Triggers: payout_reversals_payout_paid and payout_reversals_within_payout
    // (on insert: a paid payout of the same app, provider and currency, and at
    // most the payout less its unfailed reversals, 20 at most),
    // payout_reversals_identity_immutable, payout_reversals_status_forward,
    // payout_reversals_delete_blocked, payout_reversals_touch_payout_insert
    // and payout_reversals_touch_payout_status.
]);

export type PayoutReversal = typeof payoutReversals.$inferSelect;
