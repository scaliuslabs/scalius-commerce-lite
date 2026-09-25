// Buyer<->store conversations (Wave A §4). One thread per subject; order
// threads derive buyer access from the order and carry no customer. Messages
// are append-only with a gap-free per-thread `seq`: a post advances
// `conversations.last_seq` by one (CAS on the old value) and inserts the
// message with the new value in the same batch. Vocabulary and limits live in
// `@scalius/shared/conversation`.

import { sqliteTable, text, integer, uniqueIndex, index, check } from "drizzle-orm/sqlite-core";
import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { UNIX_NOW } from "./shared";
import { orders } from "./orders";
import { customers } from "./customers";
import { user } from "./auth";

export const conversations = sqliteTable("conversations", {
    /** `cnv_` + random; safe in buyer URLs. */
    id: text("id").primaryKey(),
    subjectType: text("subject_type", { enum: ["order", "store", "warranty_claim", "review"] }).notNull(),
    /** The claim or review a Wave B thread is about; null for order and store threads. */
    subjectId: text("subject_id"),
    orderId: text("order_id")
        .references(() => orders.id, { onDelete: "restrict" }),
    /** The verified account of a store thread; null on order threads. */
    customerId: text("customer_id")
        .references(() => customers.id, { onDelete: "set null" }),
    subject: text("subject"),
    /** open = needs staff, pending = waiting on the buyer, closed. */
    status: text("status", { enum: ["open", "pending", "closed"] }).notNull().default("open"),
    assigneeUserId: text("assignee_user_id")
        .references(() => user.id, { onDelete: "set null" }),
    lastSeq: integer("last_seq").notNull().default(0),
    customerReadSeq: integer("customer_read_seq").notNull().default(0),
    staffReadSeq: integer("staff_read_seq").notNull().default(0),
    lastMessageAt: integer("last_message_at"),
    lastAuthorType: text("last_author_type", { enum: ["customer", "guest_receipt", "staff", "system"] }),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    updatedAt: integer("updated_at").notNull().default(UNIX_NOW),
    closedAt: integer("closed_at"),
}, (table) => [
    uniqueIndex("conversations_order_thread_unique")
        .on(table.orderId)
        .where(sql`${table.subjectType} = 'order'`),
    uniqueIndex("conversations_subject_unique")
        .on(table.subjectType, table.subjectId)
        .where(sql`${table.subjectId} IS NOT NULL`),
    index("conversations_inbox_idx").on(table.status, sql`${table.lastMessageAt} DESC`, table.id),
    index("conversations_assignee_inbox_idx").on(table.assigneeUserId, table.status, sql`${table.lastMessageAt} DESC`),
    index("conversations_customer_idx")
        .on(table.customerId, sql`${table.lastMessageAt} DESC`)
        .where(sql`${table.customerId} IS NOT NULL`),
    index("conversations_order_idx")
        .on(table.orderId)
        .where(sql`${table.orderId} IS NOT NULL`),
    check("conversations_id_shape", sql`substr(${table.id}, 1, 4) = 'cnv_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("conversations_subject_type_check", sql`${table.subjectType} IN ('order', 'store', 'warranty_claim', 'review')`),
    check("conversations_status_check", sql`${table.status} IN ('open', 'pending', 'closed')`),
    check("conversations_owner_present", sql`${table.orderId} IS NOT NULL OR ${table.customerId} IS NOT NULL`),
    check("conversations_order_subject_shape", sql`${table.subjectType} <> 'order' OR ${table.orderId} IS NOT NULL`),
    check("conversations_subject_length", sql`${table.subject} IS NULL OR length(${table.subject}) BETWEEN 1 AND 120`),
    check("conversations_seq_bounds", sql`${table.customerReadSeq} >= 0 AND ${table.staffReadSeq} >= 0 AND ${table.lastSeq} >= ${table.customerReadSeq} AND ${table.lastSeq} >= ${table.staffReadSeq}`),
    check("conversations_last_author_type_check", sql`${table.lastAuthorType} IS NULL OR ${table.lastAuthorType} IN ('customer', 'guest_receipt', 'staff', 'system')`),
    check("conversations_version_positive", sql`${table.version} >= 1`),
    check("conversations_closed_shape", sql`(${table.status} = 'closed' AND ${table.closedAt} IS NOT NULL) OR (${table.status} <> 'closed' AND ${table.closedAt} IS NULL)`),
    // Triggers: conversations_seq_advance_guard (last_seq steps by one, only
    // after the previous message exists), conversations_identity_immutable,
    // conversations_delete_blocked.
]);

export const conversationMessages = sqliteTable("conversation_messages", {
    /** `msg_` + random. */
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
        .notNull()
        .references(() => conversations.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    kind: text("kind", { enum: ["message", "event"] }).notNull(),
    /** internal = staff note, never in a buyer projection. */
    visibility: text("visibility", { enum: ["public", "internal"] }).notNull().default("public"),
    authorType: text("author_type", { enum: ["customer", "guest_receipt", "staff", "system"] }).notNull(),
    authorCustomerId: text("author_customer_id"),
    authorUserId: text("author_user_id"),
    body: text("body"),
    /** System line kind, e.g. a case submitted or its status changing. */
    eventKind: text("event_kind"),
    eventData: text("event_data"),
    /** Idempotency key of the post, unique per conversation. */
    clientMessageKey: text("client_message_key"),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
}, (table) => [
    uniqueIndex("conversation_messages_conversation_seq_unique").on(table.conversationId, table.seq),
    uniqueIndex("conversation_messages_client_key_unique")
        .on(table.conversationId, table.clientMessageKey)
        .where(sql`${table.clientMessageKey} IS NOT NULL`),
    index("conversation_messages_conversation_created_idx").on(table.conversationId, table.createdAt),
    check("conversation_messages_id_shape", sql`substr(${table.id}, 1, 4) = 'msg_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("conversation_messages_seq_positive", sql`${table.seq} >= 1`),
    check("conversation_messages_kind_check", sql`${table.kind} IN ('message', 'event')`),
    check("conversation_messages_visibility_check", sql`${table.visibility} IN ('public', 'internal')`),
    check("conversation_messages_author_type_check", sql`${table.authorType} IN ('customer', 'guest_receipt', 'staff', 'system')`),
    check("conversation_messages_author_shape", sql`(${table.authorType} <> 'customer' OR ${table.authorCustomerId} IS NOT NULL) AND (${table.authorType} <> 'staff' OR ${table.authorUserId} IS NOT NULL)`),
    check("conversation_messages_buyer_public", sql`${table.visibility} = 'public' OR ${table.authorType} IN ('staff', 'system')`),
    check("conversation_messages_body_shape", sql`(${table.kind} = 'message' AND ${table.body} IS NOT NULL AND length(trim(${table.body})) BETWEEN 1 AND 5000 AND ${table.eventKind} IS NULL) OR (${table.kind} = 'event' AND ${table.eventKind} IS NOT NULL AND length(${table.eventKind}) BETWEEN 1 AND 80 AND (${table.body} IS NULL OR length(${table.body}) <= 5000))`),
    check("conversation_messages_event_data_check", sql`${table.eventData} IS NULL OR (json_valid(${table.eventData}) AND length(${table.eventData}) <= 2000)`),
    check("conversation_messages_client_key_length", sql`${table.clientMessageKey} IS NULL OR length(${table.clientMessageKey}) BETWEEN 1 AND 200`),
    // Triggers: conversation_messages_seq_insert (seq = conversation last_seq),
    // conversation_messages_{update,delete}_blocked.
]);

export const conversationAttachments = sqliteTable("conversation_attachments", {
    /** `att_` + random. */
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
        .notNull()
        .references(() => conversations.id, { onDelete: "restrict" }),
    /** Null while uploaded but not yet attached; unattached rows are swept after an hour. */
    messageId: text("message_id")
        .references(() => conversationMessages.id, { onDelete: "restrict" }),
    uploaderType: text("uploader_type", { enum: ["customer", "guest_receipt", "staff"] }).notNull(),
    /** Customer id, receipt order id, or staff user id of the uploader. */
    uploaderRef: text("uploader_ref").notNull(),
    /** `private/conversations/<cnv>/<att>`: never served publicly. */
    r2Key: text("r2_key").notNull(),
    mediaType: text("media_type").notNull().default("image/webp"),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    createdAt: integer("created_at").notNull().default(UNIX_NOW),
    attachedAt: integer("attached_at"),
}, (table) => [
    uniqueIndex("conversation_attachments_r2_key_unique").on(table.r2Key),
    index("conversation_attachments_message_idx").on(table.messageId),
    index("conversation_attachments_conversation_idx").on(table.conversationId),
    index("conversation_attachments_orphan_idx")
        .on(table.createdAt)
        .where(sql`${table.messageId} IS NULL`),
    check("conversation_attachments_id_shape", sql`substr(${table.id}, 1, 4) = 'att_' AND length(${table.id}) BETWEEN 12 AND 68`),
    check("conversation_attachments_uploader_type_check", sql`${table.uploaderType} IN ('customer', 'guest_receipt', 'staff')`),
    check("conversation_attachments_uploader_ref_length", sql`length(${table.uploaderRef}) BETWEEN 1 AND 200`),
    check("conversation_attachments_r2_key_private", sql`substr(${table.r2Key}, 1, 22) = 'private/conversations/' AND length(${table.r2Key}) <= 200`),
    check("conversation_attachments_media_type_check", sql`${table.mediaType} = 'image/webp'`),
    check("conversation_attachments_size_bounds", sql`${table.sizeBytes} BETWEEN 1 AND 5242880`),
    check("conversation_attachments_dimensions_positive", sql`(${table.width} IS NULL OR ${table.width} > 0) AND (${table.height} IS NULL OR ${table.height} > 0)`),
    check("conversation_attachments_sha256_shape", sql`length(${table.sha256}) = 64`),
    check("conversation_attachments_attach_shape", sql`(${table.messageId} IS NULL AND ${table.attachedAt} IS NULL) OR (${table.messageId} IS NOT NULL AND ${table.attachedAt} IS NOT NULL)`),
    // Triggers: conversation_attachments_attach_guard (attach once, same
    // thread, at most three per message), conversation_attachments_delete_guard.
]);

export type Conversation = InferSelectModel<typeof conversations>;
export type ConversationMessage = InferSelectModel<typeof conversationMessages>;
export type ConversationAttachment = InferSelectModel<typeof conversationAttachments>;
