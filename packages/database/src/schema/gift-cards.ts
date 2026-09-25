// Gift cards (Wave B §4). A card is found by an HMAC of its normalized code
// (`code_hash`, unique) and can be shown again from `code_ciphertext`; both
// keys derive from CREDENTIAL_ENCRYPTION_KEY, never SCALIUS_SECRET, so a
// secret rotation cannot orphan live cards. `balance_minor` starts at zero and
// is a trigger projection of the append-only `gift_card_transactions`; a
// BEFORE INSERT guard refuses any overdraft and any redemption of a disabled
// or expired card. Vocabulary lives in `@scalius/shared/gift-card-code`.

import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { orders, orderItems, orderPayments, refundAttempts } from "./orders";
import { customers } from "./customers";
import { user } from "./auth";

export const giftCards = sqliteTable("gift_cards", {
    /** `gc_` + random. */
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    codeCiphertext: text("code_ciphertext").notNull(),
    codeLast4: text("code_last4").notNull(),
    currencyCode: text("currency_code").notNull(),
    initialAmountMinor: integer("initial_amount_minor").notNull(),
    /** Only transactions move it (trigger projection); inserted as 0. */
    balanceMinor: integer("balance_minor").notNull().default(0),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    /** NULL = never expires (the default). */
    expiresAt: integer("expires_at"),
    source: text("source", { enum: ["purchase", "manual", "refund"] }).notNull(),
    sourceOrderId: text("source_order_id")
        .references(() => orders.id, { onDelete: "restrict" }),
    sourceOrderItemId: text("source_order_item_id")
        .references(() => orderItems.id, { onDelete: "restrict" }),
    sourceUnitIndex: integer("source_unit_index"),
    sourceRefundAttemptId: text("source_refund_attempt_id")
        .references(() => refundAttempts.id, { onDelete: "restrict" }),
    customerId: text("customer_id")
        .references(() => customers.id, { onDelete: "set null" }),
    /** Delivery target only; never identity. */
    recipientName: text("recipient_name"),
    recipientEmail: text("recipient_email"),
    recipientPhone: text("recipient_phone"),
    message: text("message"),
    note: text("note"),
    issuedByUserId: text("issued_by_user_id")
        .references(() => user.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("gift_cards_code_hash_unique").on(table.codeHash),
    uniqueIndex("gift_cards_purchase_unit_unique")
        .on(table.sourceOrderItemId, table.sourceUnitIndex)
        .where(sql`${table.source} = 'purchase'`),
    uniqueIndex("gift_cards_refund_attempt_unique")
        .on(table.sourceRefundAttemptId)
        .where(sql`${table.source} = 'refund'`),
    index("gift_cards_customer_idx")
        .on(table.customerId, sql`${table.createdAt} DESC`)
        .where(sql`${table.customerId} IS NOT NULL`),
    index("gift_cards_status_created_idx").on(table.status, sql`${table.createdAt} DESC`, table.id),
    index("gift_cards_last4_idx").on(table.codeLast4),
    index("gift_cards_source_order_idx")
        .on(table.sourceOrderId)
        .where(sql`${table.sourceOrderId} IS NOT NULL`),
    check("gift_cards_id_shape", sql`substr(${table.id}, 1, 3) = 'gc_' AND length(${table.id}) BETWEEN 11 AND 67`),
    check("gift_cards_last4_shape", sql`length(${table.codeLast4}) = 4`),
    check("gift_cards_currency_shape", sql`length(${table.currencyCode}) = 3`),
    check("gift_cards_initial_positive", sql`${table.initialAmountMinor} > 0`),
    check("gift_cards_balance_nonnegative", sql`${table.balanceMinor} >= 0`),
    check("gift_cards_status_check", sql`${table.status} IN ('active', 'disabled')`),
    check("gift_cards_source_check", sql`${table.source} IN ('purchase', 'manual', 'refund')`),
    check("gift_cards_purchase_shape", sql`${table.source} <> 'purchase' OR (${table.sourceOrderId} IS NOT NULL AND ${table.sourceOrderItemId} IS NOT NULL AND ${table.sourceUnitIndex} IS NOT NULL AND ${table.sourceUnitIndex} >= 0)`),
    check("gift_cards_refund_shape", sql`${table.source} <> 'refund' OR ${table.sourceRefundAttemptId} IS NOT NULL`),
    check("gift_cards_recipient_single_contact", sql`${table.recipientEmail} IS NULL OR ${table.recipientPhone} IS NULL`),
    check("gift_cards_recipient_name_length", sql`${table.recipientName} IS NULL OR length(${table.recipientName}) BETWEEN 1 AND 120`),
    check("gift_cards_message_length", sql`${table.message} IS NULL OR length(${table.message}) BETWEEN 1 AND 200`),
    check("gift_cards_note_length", sql`${table.note} IS NULL OR length(${table.note}) BETWEEN 1 AND 500`),
    check("gift_cards_version_positive", sql`${table.version} >= 1`),
    // Triggers: gift_cards_insert_zero_balance, gift_cards_identity_immutable.
]);

export const giftCardTransactions = sqliteTable("gift_card_transactions", {
    /** `gct_` + random; the `provider_ref` of a gift-card tender payment. */
    id: text("id").primaryKey(),
    giftCardId: text("gift_card_id")
        .notNull()
        .references(() => giftCards.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: ["issue", "redeem", "release", "refund", "adjust"] }).notNull(),
    /** Signed: redeem < 0; issue, release, refund > 0; adjust either way. */
    amountMinor: integer("amount_minor").notNull(),
    balanceAfterMinor: integer("balance_after_minor").notNull(),
    orderId: text("order_id")
        .references(() => orders.id, { onDelete: "restrict" }),
    orderPaymentId: text("order_payment_id")
        .references(() => orderPayments.id, { onDelete: "restrict" }),
    refundAttemptId: text("refund_attempt_id")
        .references(() => refundAttempts.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    actorType: text("actor_type", { enum: ["system", "admin", "customer"] }).notNull(),
    actorId: text("actor_id"),
    reason: text("reason"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("gift_card_transactions_idempotency_unique").on(table.idempotencyKey),
    index("gift_card_transactions_card_created_idx").on(table.giftCardId, table.createdAt, table.id),
    index("gift_card_transactions_order_idx")
        .on(table.orderId)
        .where(sql`${table.orderId} IS NOT NULL`),
    check("gift_card_transactions_id_shape", sql`substr(${table.id}, 1, 4) = 'gct_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("gift_card_transactions_kind_check", sql`${table.kind} IN ('issue', 'redeem', 'release', 'refund', 'adjust')`),
    check("gift_card_transactions_amount_sign", sql`${table.amountMinor} <> 0 AND (${table.kind} <> 'redeem' OR ${table.amountMinor} < 0) AND (${table.kind} NOT IN ('issue', 'release', 'refund') OR ${table.amountMinor} > 0)`),
    check("gift_card_transactions_balance_nonnegative", sql`${table.balanceAfterMinor} >= 0`),
    check("gift_card_transactions_actor_type_check", sql`${table.actorType} IN ('system', 'admin', 'customer')`),
    check("gift_card_transactions_idempotency_length", sql`length(trim(${table.idempotencyKey})) BETWEEN 1 AND 200`),
    check("gift_card_transactions_reason_length", sql`${table.reason} IS NULL OR length(${table.reason}) BETWEEN 1 AND 500`),
    check("gift_card_transactions_adjust_reason", sql`${table.kind} <> 'adjust' OR ${table.reason} IS NOT NULL`),
    // Triggers: gift_card_transactions_{balance_guard,redeem_guard,balance_after_guard,
    // project_insert,update_blocked,delete_blocked} (G1).
]);

export type GiftCard = InferSelectModel<typeof giftCards>;
export type GiftCardTransaction = InferSelectModel<typeof giftCardTransactions>;
