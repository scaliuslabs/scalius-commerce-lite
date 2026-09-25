// Conversation threads (Wave A §4): access, posting, reading and the staff
// inbox. Posting is one batch: CAS-advance `conversations.last_seq` by one,
// insert the message with that seq, attach its images and write its
// notification outbox rows. Database triggers reject anything else, so `seq`
// stays gap-free under concurrency (C3).
//
// Never touches customers or orders contacts (C2), never mutates money,
// stock, delivery or order status (C5). Logs carry ids only.

import type { Database } from "@scalius/database/client";
import {
  conversationAttachments,
  conversationMessages,
  conversations,
  customers,
  orders,
  user,
} from "@scalius/database/schema";
import {
  CONVERSATION_LIMITS,
  conversationUnreadCount,
  normalizeConversationBody,
  normalizeConversationSubject,
  type ConversationAuthorType,
  type ConversationMessageKind,
  type ConversationMessageVisibility,
  type ConversationStatus,
  type ConversationSubjectType,
} from "@scalius/shared/conversation";
import { formatOrderNumber, parseOrderNumberSearch } from "@scalius/shared/order-utils";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../../errors";
import {
  buildNotificationOutboxInsert,
  enqueueNotificationOutboxById,
  type NotificationInput,
  type NotificationQueue,
} from "../notifications";
import { listOrderSupportRequests } from "../orders";
import { projectMessagesForBuyer } from "./projection";
import type {
  BuyerConversationSummary,
  BuyerConversationThread,
  ConversationActor,
  ConversationAttachmentView,
  ConversationMessageRecord,
  StaffConversationSummary,
  StaffConversationThread,
  StaffInboxSummary,
} from "./types";

const POST_ATTEMPTS = 3;
const INBOX_PAGE_SIZE = 25;
const BUYER_LIST_PAGE_SIZE = 20;
const PREVIEW_LENGTH = 140;
const DAY_SECONDS = 24 * 60 * 60;

type BatchStatements = Parameters<Database["batch"]>[0];
type Statement = BatchStatements[number];

export type ThreadRow = typeof conversations.$inferSelect;

export function newConversationId(): string {
  return `cnv_${nanoid(20)}`;
}

export function newConversationMessageId(): string {
  return `msg_${nanoid(20)}`;
}

export function newConversationAttachmentId(): string {
  return `att_${nanoid(20)}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isConstraintError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /constraint|unique|SQLITE_CONSTRAINT|conversation sequence|message seq|duplicate key/i.test(text);
}

function isClientKeyConflict(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /client_message_key|conversation_messages_client_key_unique/i.test(text);
}

// ─────────────────────────────────────────
// Reads of one thread
// ─────────────────────────────────────────

export async function readThread(db: Database, conversationId: string): Promise<ThreadRow | undefined> {
  return await db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
}

export async function readOrderThread(db: Database, orderId: string): Promise<ThreadRow | undefined> {
  return await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.orderId, orderId), eq(conversations.subjectType, "order")))
    .get();
}

/** The order thread, created (empty) when missing. Creating never touches the order. */
export async function getOrCreateOrderThread(db: Database, orderId: string): Promise<ThreadRow> {
  const existing = await readOrderThread(db, orderId);
  if (existing) return existing;
  const order = await db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).get();
  if (!order) throw new NotFoundError("Order not found");
  const now = nowSeconds();
  await db.insert(conversations).values({
    id: newConversationId(),
    subjectType: "order",
    orderId,
    status: "open",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const created = await readOrderThread(db, orderId);
  if (!created) throw new ConflictError("The conversation could not be started. Please try again.");
  return created;
}

// ─────────────────────────────────────────
// Buyer access (C1)
// ─────────────────────────────────────────

/** A verified account: claimed and holding at least one proven contact. */
export async function isVerifiedCustomerAccount(db: Database, customerId: string): Promise<boolean> {
  const row = await db
    .select({
      claimed: customers.accountClaimedAt,
      phone: customers.phoneVerifiedAt,
      email: customers.emailVerifiedAt,
    })
    .from(customers)
    .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
    .get();
  return Boolean(row?.claimed && (row.phone || row.email));
}

async function ownsOrder(db: Database, customerId: string, orderId: string): Promise<boolean> {
  const row = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(
      eq(orders.id, orderId),
      eq(orders.accountOwnerCustomerId, customerId),
      isNull(orders.deletedAt),
    ))
    .get();
  return Boolean(row);
}

/**
 * Whether a buyer may use an order's thread. Account buyers must own the
 * order (verified ownership); guests present the order's receipt proof, which
 * the route validated before building the actor.
 */
export async function assertBuyerOrderAccess(
  db: Database,
  actor: ConversationActor,
  orderId: string,
): Promise<void> {
  if (actor.kind === "guest_receipt") {
    if (actor.orderId !== orderId) throw new NotFoundError("Conversation not found");
    return;
  }
  if (actor.kind === "customer" && await ownsOrder(db, actor.customerId, orderId)) return;
  throw new NotFoundError("Conversation not found");
}

/**
 * Resolves a thread the buyer may read and post to, or 404s (never 403: ids
 * are not confirmed). Store threads belong to their verified account. Every
 * other thread with an `order_id` (order, warranty_claim, review) derives
 * buyer access from that order, so one rule covers them all and a claimed
 * order carries its threads into the claiming account with no thread write.
 */
export async function resolveBuyerThread(
  db: Database,
  actor: ConversationActor,
  conversationId: string,
): Promise<ThreadRow> {
  const thread = await readThread(db, conversationId);
  if (!thread) throw new NotFoundError("Conversation not found");
  if (thread.subjectType === "store") {
    if (actor.kind !== "customer" || thread.customerId !== actor.customerId) throw new NotFoundError("Conversation not found");
    if (!await isVerifiedCustomerAccount(db, actor.customerId)) throw new NotFoundError("Conversation not found");
    return thread;
  }
  if (thread.orderId) {
    await assertBuyerOrderAccess(db, actor, thread.orderId);
    return thread;
  }
  throw new NotFoundError("Conversation not found");
}

// ─────────────────────────────────────────
// Posting (C3)
// ─────────────────────────────────────────

export interface ConversationLine {
  kind: ConversationMessageKind;
  visibility: ConversationMessageVisibility;
  authorType: ConversationAuthorType;
  authorCustomerId?: string | null;
  authorUserId?: string | null;
  body?: string | null;
  eventKind?: string | null;
  eventData?: Record<string, unknown> | null;
  clientMessageKey?: string | null;
  attachmentIds?: readonly string[];
  /** Readers who have seen this line when it lands (the author's side). */
  readBy?: ReadonlyArray<"customer" | "staff">;
}

interface PlannedLine {
  id: string;
  seq: number;
  line: ConversationLine;
}

interface PlannedAppend {
  statements: Statement[];
  lines: PlannedLine[];
  outboxIds: string[];
}

/** The status a line leaves the thread in, or null when it changes nothing. */
function statusAfter(line: ConversationLine): ConversationStatus | null {
  if (line.kind !== "message" || line.visibility !== "public") return null;
  if (line.authorType === "customer" || line.authorType === "guest_receipt") return "open";
  if (line.authorType === "staff") return "pending";
  return null;
}

function notificationFor(threadId: string, planned: PlannedLine): NotificationInput | null {
  const { line, seq } = planned;
  if (line.kind !== "message" || line.visibility !== "public") return null;
  if (line.authorType === "customer" || line.authorType === "guest_receipt") {
    return {
      subjectType: "conversation",
      subjectId: threadId,
      audience: "staff",
      notificationType: "conversation_message",
      dedupeKey: `conversation:${threadId}:staff:${seq}`,
      source: "conversation-post",
      data: { seq },
    };
  }
  if (line.authorType === "staff") {
    return {
      subjectType: "conversation",
      subjectId: threadId,
      audience: "customer",
      notificationType: "conversation_reply",
      dedupeKey: `conversation:${threadId}:reply:${seq}`,
      source: "conversation-post",
      data: { seq },
    };
  }
  return null;
}

/**
 * Statements appending `lines` to a thread whose last seq is `lastSeq`:
 * each line CAS-advances the sequence by one and inserts its message.
 */
export function planConversationAppend(
  db: Database,
  thread: { id: string; lastSeq: number },
  lines: readonly ConversationLine[],
  options: { notify: boolean },
): PlannedAppend {
  const statements: Statement[] = [];
  const planned: PlannedLine[] = [];
  const outboxIds: string[] = [];
  const now = nowSeconds();

  lines.forEach((line, index) => {
    const seq = thread.lastSeq + index + 1;
    const id = newConversationMessageId();
    const status = statusAfter(line);
    const readBy = new Set(line.readBy ?? []);
    const internalNote = line.visibility === "internal";

    statements.push(db.update(conversations).set({
      lastSeq: seq,
      lastMessageAt: now,
      lastAuthorType: line.authorType,
      version: sql`${conversations.version} + 1`,
      updatedAt: now,
      ...(status ? { status, closedAt: null } : {}),
      ...(readBy.has("staff") || internalNote ? { staffReadSeq: seq } : {}),
      ...(readBy.has("customer")
        ? { customerReadSeq: seq }
        // A note the buyer can never see must not look unread to them.
        : internalNote
          ? { customerReadSeq: sql`CASE WHEN ${conversations.customerReadSeq} = ${seq - 1} THEN ${seq} ELSE ${conversations.customerReadSeq} END` }
          : {}),
    }).where(and(eq(conversations.id, thread.id), eq(conversations.lastSeq, seq - 1))));

    statements.push(db.insert(conversationMessages).values({
      id,
      conversationId: thread.id,
      seq,
      kind: line.kind,
      visibility: line.visibility,
      authorType: line.authorType,
      authorCustomerId: line.authorCustomerId ?? null,
      authorUserId: line.authorUserId ?? null,
      body: line.body ?? null,
      eventKind: line.eventKind ?? null,
      eventData: line.eventData ? JSON.stringify(line.eventData) : null,
      clientMessageKey: line.clientMessageKey ?? null,
      createdAt: now,
    }));

    if (line.attachmentIds && line.attachmentIds.length > 0) {
      statements.push(db.update(conversationAttachments).set({
        messageId: id,
        attachedAt: now,
      }).where(and(
        inArray(conversationAttachments.id, [...line.attachmentIds]),
        eq(conversationAttachments.conversationId, thread.id),
        isNull(conversationAttachments.messageId),
      )));
    }

    const entry = { id, seq, line };
    planned.push(entry);
    const notification = options.notify ? notificationFor(thread.id, entry) : null;
    if (notification) {
      const insert = buildNotificationOutboxInsert(db, notification);
      statements.push(insert.statement);
      outboxIds.push(insert.outboxId);
    }
  });

  return { statements, lines: planned, outboxIds };
}

/** Hands committed outbox rows to the queue; the scheduled flush retries any that fail. */
export async function enqueueConversationNotifications(
  db: Database,
  queue: NotificationQueue | undefined,
  outboxIds: readonly string[],
): Promise<void> {
  if (!queue) return;
  for (const outboxId of outboxIds) {
    await enqueueNotificationOutboxById({ db, queue, outboxId }).catch((error: unknown) => {
      console.error(`[conversations] Notification ${outboxId} not enqueued yet:`, error instanceof Error ? error.message : "unknown error");
    });
  }
}

async function readMessageByClientKey(db: Database, conversationId: string, clientMessageKey: string) {
  return await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(and(
      eq(conversationMessages.conversationId, conversationId),
      eq(conversationMessages.clientMessageKey, clientMessageKey),
    ))
    .get();
}

async function assertBuyerDailyCap(db: Database, conversationId: string): Promise<void> {
  const since = nowSeconds() - DAY_SECONDS;
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(conversationMessages)
    .where(and(
      eq(conversationMessages.conversationId, conversationId),
      gt(conversationMessages.createdAt, since),
      inArray(conversationMessages.authorType, ["customer", "guest_receipt"]),
      eq(conversationMessages.kind, "message"),
    ))
    .get();
  if (Number(row?.count ?? 0) >= CONVERSATION_LIMITS.buyerMessagesPerDay) {
    throw new RateLimitError("You've sent a lot of messages today. Please wait for the store to reply.");
  }
}

function uploaderFor(actor: ConversationActor): { type: "customer" | "guest_receipt" | "staff"; ref: string } {
  if (actor.kind === "customer") return { type: "customer", ref: actor.customerId };
  if (actor.kind === "guest_receipt") return { type: "guest_receipt", ref: actor.orderId };
  return { type: "staff", ref: actor.userId };
}

/** The attachments must be this uploader's, staged in this thread, not yet attached. */
async function assertAttachable(
  db: Database,
  conversationId: string,
  actor: ConversationActor,
  attachmentIds: readonly string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  if (attachmentIds.length > CONVERSATION_LIMITS.attachmentsPerMessage) {
    throw new ValidationError(`Attach up to ${CONVERSATION_LIMITS.attachmentsPerMessage} images per message.`);
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new ValidationError("Each image can be attached once.");
  }
  const uploader = uploaderFor(actor);
  const rows = await db
    .select({ id: conversationAttachments.id })
    .from(conversationAttachments)
    .where(and(
      inArray(conversationAttachments.id, [...attachmentIds]),
      eq(conversationAttachments.conversationId, conversationId),
      isNull(conversationAttachments.messageId),
      eq(conversationAttachments.uploaderType, uploader.type),
      eq(conversationAttachments.uploaderRef, uploader.ref),
    ))
    .all();
  if (rows.length !== attachmentIds.length) {
    throw new ValidationError("An image is missing or already attached. Upload it again.");
  }
}

export interface PostMessageInput {
  actor: ConversationActor;
  body: unknown;
  visibility?: ConversationMessageVisibility;
  clientMessageKey?: string | null;
  attachmentIds?: readonly string[];
}

export interface PostMessageResult {
  conversationId: string;
  messageId: string;
  seq: number;
  created: boolean;
}

/**
 * Appends one message with the seq CAS, retrying a lost race up to three
 * times. A repeated `clientMessageKey` returns the message it first created.
 */
export async function postConversationMessage(
  db: Database,
  thread: ThreadRow,
  input: PostMessageInput,
  options: { queue?: NotificationQueue } = {},
): Promise<PostMessageResult> {
  const body = normalizeConversationBody(input.body);
  if (!body.ok) {
    throw new ValidationError(body.reason === "too_long"
      ? `Messages can be up to ${CONVERSATION_LIMITS.bodyLength} characters.`
      : body.reason === "invalid_characters"
        ? "The message contains characters that can't be sent."
        : "Write a message first.");
  }
  const buyer = input.actor.kind !== "staff";
  const visibility = buyer ? "public" : (input.visibility ?? "public");
  const clientMessageKey = input.clientMessageKey?.trim() || null;
  if (clientMessageKey && clientMessageKey.length > CONVERSATION_LIMITS.clientMessageKeyLength) {
    throw new ValidationError("The message key is too long.");
  }
  const attachmentIds = input.attachmentIds ?? [];

  if (clientMessageKey) {
    const existing = await readMessageByClientKey(db, thread.id, clientMessageKey);
    if (existing) return replayResult(db, thread.id, existing.id);
  }
  if (buyer) await assertBuyerDailyCap(db, thread.id);
  await assertAttachable(db, thread.id, input.actor, attachmentIds);

  const line: ConversationLine = {
    kind: "message",
    visibility,
    authorType: input.actor.kind,
    authorCustomerId: input.actor.kind === "customer" ? input.actor.customerId : null,
    authorUserId: input.actor.kind === "staff" ? input.actor.userId : null,
    body: body.value,
    clientMessageKey,
    attachmentIds,
    readBy: [buyer ? "customer" : "staff"],
  };

  let current = thread;
  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
    const plan = planConversationAppend(db, current, [line], { notify: true });
    try {
      await db.batch(plan.statements as unknown as BatchStatements);
      await enqueueConversationNotifications(db, options.queue, plan.outboxIds);
      const [posted] = plan.lines;
      return { conversationId: thread.id, messageId: posted!.id, seq: posted!.seq, created: true };
    } catch (error) {
      if (clientMessageKey && isClientKeyConflict(error)) {
        const existing = await readMessageByClientKey(db, thread.id, clientMessageKey);
        if (existing) return replayResult(db, thread.id, existing.id);
      }
      if (!isConstraintError(error) || attempt === POST_ATTEMPTS) {
        if (isConstraintError(error)) {
          throw new ConflictError("The conversation changed while you were sending. Please try again.");
        }
        throw error;
      }
      const fresh = await readThread(db, thread.id);
      if (!fresh) throw new NotFoundError("Conversation not found");
      current = fresh;
    }
  }
  throw new ConflictError("The conversation changed while you were sending. Please try again.");
}

async function replayResult(db: Database, conversationId: string, messageId: string): Promise<PostMessageResult> {
  const row = await db.select({ seq: conversationMessages.seq }).from(conversationMessages)
    .where(eq(conversationMessages.id, messageId)).get();
  return { conversationId, messageId, seq: row?.seq ?? 0, created: false };
}

/** A buyer's post to an order thread, which starts the thread on the first message. */
export async function postBuyerOrderMessage(
  db: Database,
  orderId: string,
  input: PostMessageInput,
  options: { queue?: NotificationQueue } = {},
): Promise<PostMessageResult> {
  await assertBuyerOrderAccess(db, input.actor, orderId);
  const thread = await getOrCreateOrderThread(db, orderId);
  return postConversationMessage(db, thread, input, options);
}

/** Staff start or continue an order's thread from the order page. */
export async function postStaffOrderMessage(
  db: Database,
  orderId: string,
  input: PostMessageInput,
  options: { queue?: NotificationQueue } = {},
): Promise<PostMessageResult> {
  if (input.actor.kind !== "staff") throw new ForbiddenError("Staff only");
  const thread = await getOrCreateOrderThread(db, orderId);
  return postConversationMessage(db, thread, input, options);
}

// ─────────────────────────────────────────
// Store threads (verified accounts only)
// ─────────────────────────────────────────

export async function createStoreThread(
  db: Database,
  customerId: string,
  input: { subject: unknown; body: unknown; clientMessageKey?: string | null },
  options: { queue?: NotificationQueue } = {},
): Promise<PostMessageResult> {
  if (!await isVerifiedCustomerAccount(db, customerId)) {
    throw new ForbiddenError("Verify your phone or email to message the store.");
  }
  const subject = normalizeConversationSubject(input.subject);
  if (!subject.ok) {
    throw new ValidationError(subject.reason === "too_long"
      ? `Keep the subject under ${CONVERSATION_LIMITS.subjectLength} characters.`
      : "Add a short subject.");
  }
  const body = normalizeConversationBody(input.body);
  if (!body.ok) {
    throw new ValidationError(body.reason === "too_long"
      ? `Messages can be up to ${CONVERSATION_LIMITS.bodyLength} characters.`
      : "Write a message first.");
  }
  const clientMessageKey = input.clientMessageKey?.trim() || null;
  if (clientMessageKey) {
    const existing = await db
      .select({ conversationId: conversationMessages.conversationId, messageId: conversationMessages.id, seq: conversationMessages.seq })
      .from(conversationMessages)
      .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
      .where(and(
        eq(conversations.customerId, customerId),
        eq(conversations.subjectType, "store"),
        eq(conversationMessages.clientMessageKey, clientMessageKey),
      ))
      .get();
    if (existing) return { ...existing, created: false };
  }

  const open = await db
    .select({ count: sql<number>`count(*)` })
    .from(conversations)
    .where(and(
      eq(conversations.customerId, customerId),
      eq(conversations.subjectType, "store"),
      ne(conversations.status, "closed"),
    ))
    .get();
  if (Number(open?.count ?? 0) >= CONVERSATION_LIMITS.openStoreThreadsPerAccount) {
    throw new ConflictError("You already have several open conversations. Continue one of them instead.");
  }

  const id = newConversationId();
  const now = nowSeconds();
  const plan = planConversationAppend(db, { id, lastSeq: 0 }, [{
    kind: "message",
    visibility: "public",
    authorType: "customer",
    authorCustomerId: customerId,
    body: body.value,
    clientMessageKey,
    readBy: ["customer"],
  }], { notify: true });
  await db.batch([
    db.insert(conversations).values({
      id,
      subjectType: "store",
      customerId,
      subject: subject.value,
      status: "open",
      createdAt: now,
      updatedAt: now,
    }),
    ...plan.statements,
  ] as BatchStatements);
  await enqueueConversationNotifications(db, options.queue, plan.outboxIds);
  const [posted] = plan.lines;
  return { conversationId: id, messageId: posted!.id, seq: posted!.seq, created: true };
}

// ─────────────────────────────────────────
// Reading messages
// ─────────────────────────────────────────

function parseEventData(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readMessagePage(
  db: Database,
  conversationId: string,
  options: { beforeSeq?: number; publicOnly: boolean; withAuthorNames: boolean },
): Promise<{ messages: ConversationMessageRecord[]; hasMore: boolean }> {
  const conditions: SQL[] = [eq(conversationMessages.conversationId, conversationId)];
  if (options.beforeSeq && options.beforeSeq > 0) conditions.push(lt(conversationMessages.seq, options.beforeSeq));
  if (options.publicOnly) conditions.push(eq(conversationMessages.visibility, "public"));
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(and(...conditions))
    .orderBy(desc(conversationMessages.seq))
    .limit(CONVERSATION_LIMITS.pageSize + 1)
    .all();
  const hasMore = rows.length > CONVERSATION_LIMITS.pageSize;
  const page = rows.slice(0, CONVERSATION_LIMITS.pageSize).reverse();
  if (page.length === 0) return { messages: [], hasMore: false };

  const attachments = await db
    .select({
      id: conversationAttachments.id,
      messageId: conversationAttachments.messageId,
      mediaType: conversationAttachments.mediaType,
      sizeBytes: conversationAttachments.sizeBytes,
      width: conversationAttachments.width,
      height: conversationAttachments.height,
    })
    .from(conversationAttachments)
    .where(inArray(conversationAttachments.messageId, page.map((row) => row.id)))
    .orderBy(asc(conversationAttachments.attachedAt), asc(conversationAttachments.id))
    .all();
  const byMessage = new Map<string, ConversationAttachmentView[]>();
  for (const { messageId, ...attachment } of attachments) {
    if (!messageId) continue;
    const list = byMessage.get(messageId) ?? [];
    list.push(attachment);
    byMessage.set(messageId, list);
  }

  const names = new Map<string, string>();
  if (options.withAuthorNames) {
    const userIds = [...new Set(page.map((row) => row.authorUserId).filter((value): value is string => Boolean(value)))];
    if (userIds.length > 0) {
      const users = await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds)).all();
      for (const row of users) names.set(row.id, row.name);
    }
  }

  return {
    hasMore,
    messages: page.map((row) => ({
      id: row.id,
      seq: row.seq,
      kind: row.kind,
      visibility: row.visibility,
      authorType: row.authorType,
      authorUserId: options.withAuthorNames ? row.authorUserId : null,
      authorName: row.authorUserId ? names.get(row.authorUserId) ?? null : null,
      body: row.body,
      eventKind: row.eventKind,
      eventData: parseEventData(row.eventData),
      createdAt: row.createdAt,
      attachments: byMessage.get(row.id) ?? [],
    })),
  };
}

async function buyerUnreadCounts(db: Database, threadIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (threadIds.length === 0) return counts;
  const rows = await db
    .select({ conversationId: conversationMessages.conversationId, count: sql<number>`count(*)` })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(and(
      inArray(conversationMessages.conversationId, [...threadIds]),
      eq(conversationMessages.visibility, "public"),
      sql`${conversationMessages.seq} > ${conversations.customerReadSeq}`,
      // The buyer's own lines are never unread.
      inArray(conversationMessages.authorType, ["staff", "system"]),
    ))
    .groupBy(conversationMessages.conversationId)
    .all();
  for (const row of rows) counts.set(row.conversationId, Number(row.count) || 0);
  return counts;
}

async function orderNumbersById(db: Database, orderIds: readonly string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const ids = [...new Set(orderIds)];
  for (let index = 0; index < ids.length; index += 90) {
    const chunk = ids.slice(index, index + 90);
    const rows = await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders)
      .where(inArray(orders.id, chunk)).all();
    for (const row of rows) result.set(row.id, formatOrderNumber(row.orderNumber, row.id));
  }
  return result;
}

/** A read marker only moves forward and never past the last line (portable SQL, no scalar max/min). */
function advanceMarker(column: typeof conversations.staffReadSeq | typeof conversations.customerReadSeq, target: number): SQL {
  return sql`CASE WHEN ${target} > ${conversations.lastSeq} THEN ${conversations.lastSeq} WHEN ${target} > ${column} THEN ${target} ELSE ${column} END`;
}

/** The buyer's view of one thread: public lines only (C4). */
export async function getBuyerThread(
  db: Database,
  thread: ThreadRow,
  options: { beforeSeq?: number } = {},
): Promise<BuyerConversationThread> {
  const [page, unread, numbers] = await Promise.all([
    readMessagePage(db, thread.id, { beforeSeq: options.beforeSeq, publicOnly: true, withAuthorNames: false }),
    buyerUnreadCounts(db, [thread.id]),
    orderNumbersById(db, thread.orderId ? [thread.orderId] : []),
  ]);
  return {
    id: thread.id,
    subjectType: thread.subjectType,
    subject: thread.subject,
    orderId: thread.orderId,
    orderNumber: thread.orderId ? numbers.get(thread.orderId) ?? null : null,
    status: thread.status,
    lastMessageAt: thread.lastMessageAt,
    unread: unread.get(thread.id) ?? 0,
    lastSeq: thread.lastSeq,
    readSeq: thread.customerReadSeq,
    messages: projectMessagesForBuyer(page.messages),
    hasMore: page.hasMore,
  };
}

export interface BuyerThreadCursor {
  lastMessageAt: number;
  id: string;
}

export function encodeConversationCursor(cursor: BuyerThreadCursor | null): string | null {
  return cursor ? `${cursor.lastMessageAt}.${cursor.id}` : null;
}

export function decodeConversationCursor(value: string | null | undefined): BuyerThreadCursor | null {
  if (!value) return null;
  const match = /^(\d{1,12})\.(cnv_[A-Za-z0-9_-]{8,64})$/.exec(value);
  if (!match) throw new ValidationError("Invalid cursor");
  return { lastMessageAt: Number(match[1]), id: match[2]! };
}

function keysetAfter(cursor: BuyerThreadCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(conversations.lastMessageAt, cursor.lastMessageAt),
    and(eq(conversations.lastMessageAt, cursor.lastMessageAt), lt(conversations.id, cursor.id)),
  );
}

/**
 * Store threads and every order-scoped thread (order, warranty_claim, review)
 * of orders the account owns, newest first.
 */
export async function listBuyerThreads(
  db: Database,
  customerId: string,
  options: { cursor?: string | null } = {},
): Promise<{ items: BuyerConversationSummary[]; nextCursor: string | null }> {
  const cursor = decodeConversationCursor(options.cursor);
  const owned = db.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.accountOwnerCustomerId, customerId), isNull(orders.deletedAt)));
  const orderScoped = and(ne(conversations.subjectType, "store"), inArray(conversations.orderId, owned));
  const verified = await isVerifiedCustomerAccount(db, customerId);
  const rows = await db
    .select()
    .from(conversations)
    .where(and(
      isNotNull(conversations.lastMessageAt),
      verified
        ? or(
          and(eq(conversations.customerId, customerId), eq(conversations.subjectType, "store")),
          orderScoped,
        )
        : orderScoped,
      keysetAfter(cursor),
    ))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(BUYER_LIST_PAGE_SIZE + 1)
    .all();
  const page = rows.slice(0, BUYER_LIST_PAGE_SIZE);
  const [unread, numbers] = await Promise.all([
    buyerUnreadCounts(db, page.map((row) => row.id)),
    orderNumbersById(db, page.flatMap((row) => row.orderId ? [row.orderId] : [])),
  ]);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      subjectType: row.subjectType,
      subject: row.subject,
      orderId: row.orderId,
      orderNumber: row.orderId ? numbers.get(row.orderId) ?? null : null,
      status: row.status,
      lastMessageAt: row.lastMessageAt,
      unread: unread.get(row.id) ?? 0,
    })),
    nextCursor: rows.length > BUYER_LIST_PAGE_SIZE && last?.lastMessageAt
      ? encodeConversationCursor({ lastMessageAt: last.lastMessageAt, id: last.id })
      : null,
  };
}

/** Unread public lines across the buyer's threads (the account Inbox badge). */
export async function countBuyerUnread(db: Database, customerId: string): Promise<number> {
  const { items } = await listBuyerThreads(db, customerId);
  return items.reduce((sum, item) => sum + item.unread, 0);
}

/**
 * The buyer saw everything up to `seq`. The marker skips past internal notes
 * and events that follow, so staff-only lines never keep a thread unread.
 */
export async function markBuyerRead(db: Database, thread: ThreadRow, seq: number): Promise<number> {
  if (!Number.isInteger(seq) || seq < 0) throw new ValidationError("Invalid read position");
  const upTo = Math.min(seq, thread.lastSeq);
  const nextVisible = await db
    .select({ seq: sql<number | null>`min(${conversationMessages.seq})` })
    .from(conversationMessages)
    .where(and(
      eq(conversationMessages.conversationId, thread.id),
      gt(conversationMessages.seq, upTo),
      eq(conversationMessages.visibility, "public"),
    ))
    .get();
  const target = nextVisible?.seq ? Number(nextVisible.seq) - 1 : thread.lastSeq;
  if (target <= thread.customerReadSeq) return thread.customerReadSeq;
  await db.update(conversations)
    .set({ customerReadSeq: advanceMarker(conversations.customerReadSeq, target) })
    .where(eq(conversations.id, thread.id));
  return target;
}

// ─────────────────────────────────────────
// Staff inbox
// ─────────────────────────────────────────

export interface StaffInboxFilters {
  status?: ConversationStatus | "all";
  assignee?: "me" | "none" | string;
  subjectType?: ConversationSubjectType;
  q?: string;
  cursor?: string | null;
}

function escapedLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function staffSummaries(db: Database, rows: Array<{
  thread: ThreadRow;
  orderNumber: number | null;
  orderCustomerName: string | null;
  customerName: string | null;
  assigneeName: string | null;
}>): Promise<StaffConversationSummary[]> {
  if (rows.length === 0) return [];
  const previews = await db
    .select({
      conversationId: conversationMessages.conversationId,
      kind: conversationMessages.kind,
      body: conversationMessages.body,
    })
    .from(conversationMessages)
    .innerJoin(conversations, and(
      eq(conversations.id, conversationMessages.conversationId),
      eq(conversations.lastSeq, conversationMessages.seq),
    ))
    .where(inArray(conversationMessages.conversationId, rows.map((row) => row.thread.id)))
    .all();
  const previewById = new Map(previews.map((row) => [
    row.conversationId,
    row.kind === "message" && row.body ? row.body.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LENGTH) : null,
  ]));
  return rows.map(({ thread, orderNumber, orderCustomerName, customerName, assigneeName }) => ({
    id: thread.id,
    subjectType: thread.subjectType,
    subject: thread.subject,
    status: thread.status,
    orderId: thread.orderId,
    orderNumber: thread.orderId ? formatOrderNumber(orderNumber, thread.orderId) : null,
    customerId: thread.customerId,
    customerName: customerName ?? orderCustomerName ?? null,
    assigneeUserId: thread.assigneeUserId,
    assigneeName,
    lastMessageAt: thread.lastMessageAt,
    lastAuthorType: thread.lastAuthorType,
    preview: previewById.get(thread.id) ?? null,
    unread: conversationUnreadCount(thread.lastSeq, thread.staffReadSeq),
    version: thread.version,
  }));
}

const staffRowSelect = {
  thread: conversations,
  orderNumber: orders.orderNumber,
  orderCustomerName: orders.customerName,
  customerName: customers.name,
  assigneeName: user.name,
};

/** One keyset page (25) of the staff inbox, newest activity first. */
export async function listStaffInbox(
  db: Database,
  userId: string,
  filters: StaffInboxFilters = {},
): Promise<{ items: StaffConversationSummary[]; nextCursor: string | null }> {
  const cursor = decodeConversationCursor(filters.cursor);
  const conditions: Array<SQL | undefined> = [isNotNull(conversations.lastMessageAt), keysetAfter(cursor)];
  const status = filters.status ?? "open";
  if (status !== "all") conditions.push(eq(conversations.status, status));
  if (filters.assignee === "me") conditions.push(eq(conversations.assigneeUserId, userId));
  else if (filters.assignee === "none") conditions.push(isNull(conversations.assigneeUserId));
  else if (filters.assignee) conditions.push(eq(conversations.assigneeUserId, filters.assignee));
  if (filters.subjectType) conditions.push(eq(conversations.subjectType, filters.subjectType));
  const q = filters.q?.trim().slice(0, 100);
  if (q) {
    const number = parseOrderNumberSearch(q);
    const like = `%${escapedLike(q)}%`;
    conditions.push(or(
      ...(number ? [eq(orders.orderNumber, number)] : []),
      sql`${conversations.subject} LIKE ${like} ESCAPE '\\'`,
      sql`${orders.customerName} LIKE ${like} ESCAPE '\\'`,
      sql`${customers.name} LIKE ${like} ESCAPE '\\'`,
    ));
  }

  const rows = await db
    .select(staffRowSelect)
    .from(conversations)
    .leftJoin(orders, eq(orders.id, conversations.orderId))
    .leftJoin(customers, eq(customers.id, conversations.customerId))
    .leftJoin(user, eq(user.id, conversations.assigneeUserId))
    .where(and(...conditions))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(INBOX_PAGE_SIZE + 1)
    .all();
  const page = rows.slice(0, INBOX_PAGE_SIZE);
  const last = page.at(-1)?.thread;
  return {
    items: await staffSummaries(db, page),
    nextCursor: rows.length > INBOX_PAGE_SIZE && last?.lastMessageAt
      ? encodeConversationCursor({ lastMessageAt: last.lastMessageAt, id: last.id })
      : null,
  };
}

export async function getStaffInboxSummary(db: Database, userId: string): Promise<StaffInboxSummary> {
  const row = await db
    .select({
      open: sql<number>`count(*)`,
      mineOpen: sql<number>`coalesce(sum(CASE WHEN ${conversations.assigneeUserId} = ${userId} THEN 1 ELSE 0 END), 0)`,
      unassignedOpen: sql<number>`coalesce(sum(CASE WHEN ${conversations.assigneeUserId} IS NULL THEN 1 ELSE 0 END), 0)`,
    })
    .from(conversations)
    .where(and(eq(conversations.status, "open"), isNotNull(conversations.lastMessageAt)))
    .get();
  return {
    open: Number(row?.open ?? 0),
    mineOpen: Number(row?.mineOpen ?? 0),
    unassignedOpen: Number(row?.unassignedOpen ?? 0),
  };
}

/** A thread with internal notes, order context and the order's cases (staff only). */
export async function getStaffThread(
  db: Database,
  conversationId: string,
  options: { beforeSeq?: number } = {},
): Promise<StaffConversationThread> {
  const row = await db
    .select(staffRowSelect)
    .from(conversations)
    .leftJoin(orders, eq(orders.id, conversations.orderId))
    .leftJoin(customers, eq(customers.id, conversations.customerId))
    .leftJoin(user, eq(user.id, conversations.assigneeUserId))
    .where(eq(conversations.id, conversationId))
    .get();
  if (!row) throw new NotFoundError("Conversation not found");
  return buildStaffThread(db, row, options);
}

/** The order's thread for the order page, or null when nobody has written yet. */
export async function getStaffOrderThread(
  db: Database,
  orderId: string,
  options: { beforeSeq?: number } = {},
): Promise<StaffConversationThread | null> {
  const row = await db
    .select(staffRowSelect)
    .from(conversations)
    .leftJoin(orders, eq(orders.id, conversations.orderId))
    .leftJoin(customers, eq(customers.id, conversations.customerId))
    .leftJoin(user, eq(user.id, conversations.assigneeUserId))
    .where(and(eq(conversations.orderId, orderId), eq(conversations.subjectType, "order")))
    .get();
  return row ? buildStaffThread(db, row, options) : null;
}

async function buildStaffThread(
  db: Database,
  row: {
    thread: ThreadRow;
    orderNumber: number | null;
    orderCustomerName: string | null;
    customerName: string | null;
    assigneeName: string | null;
  },
  options: { beforeSeq?: number },
): Promise<StaffConversationThread> {
  const { thread } = row;
  const [[summary], page, order, cases] = await Promise.all([
    staffSummaries(db, [row]),
    readMessagePage(db, thread.id, { beforeSeq: options.beforeSeq, publicOnly: false, withAuthorNames: true }),
    thread.orderId
      ? db.select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        totalAmountMinor: orders.totalAmountMinor,
        currencyCode: orders.currencyCode,
        createdAt: sql<number | null>`CAST(${orders.createdAt} AS INTEGER)`,
      }).from(orders).where(eq(orders.id, thread.orderId)).get()
      : Promise.resolve(undefined),
    thread.orderId ? listOrderSupportRequests(db, thread.orderId) : Promise.resolve([]),
  ]);
  return {
    ...summary!,
    lastSeq: thread.lastSeq,
    staffReadSeq: thread.staffReadSeq,
    customerReadSeq: thread.customerReadSeq,
    messages: page.messages,
    hasMore: page.hasMore,
    order: order
      ? {
        id: order.id,
        orderNumber: formatOrderNumber(order.orderNumber, order.id),
        status: order.status,
        paymentStatus: order.paymentStatus,
        totalAmountMinor: order.totalAmountMinor,
        currencyCode: order.currencyCode ?? null,
        createdAt: order.createdAt,
      }
      : null,
    cases: cases.map((request) => ({
      id: request.id,
      type: request.type,
      status: request.status,
      label: request.label,
      active: request.active,
      returnId: request.returnId,
    })),
  };
}

export async function markStaffRead(db: Database, conversationId: string, seq: number): Promise<void> {
  if (!Number.isInteger(seq) || seq < 0) throw new ValidationError("Invalid read position");
  await db.update(conversations)
    .set({ staffReadSeq: advanceMarker(conversations.staffReadSeq, seq) })
    .where(eq(conversations.id, conversationId));
}

/** Status and assignment, guarded by the thread version the editor loaded. */
export async function updateStaffThread(
  db: Database,
  conversationId: string,
  input: { version: number; status?: ConversationStatus; assigneeUserId?: string | null },
): Promise<StaffConversationThread> {
  if (input.assigneeUserId) {
    const staff = await db.select({ id: user.id }).from(user).where(eq(user.id, input.assigneeUserId)).get();
    if (!staff) throw new ValidationError("Choose a staff member to assign.");
  }
  const now = nowSeconds();
  const rows = await db.update(conversations).set({
    ...(input.status ? { status: input.status, closedAt: input.status === "closed" ? now : null } : {}),
    ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
    version: sql`${conversations.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(conversations.id, conversationId),
    eq(conversations.version, input.version),
  )).returning({ id: conversations.id });
  if (rows.length === 0) {
    const exists = await readThread(db, conversationId);
    if (!exists) throw new NotFoundError("Conversation not found");
    throw new ConflictError("Someone else changed this conversation. Refresh and try again.");
  }
  return getStaffThread(db, conversationId);
}
