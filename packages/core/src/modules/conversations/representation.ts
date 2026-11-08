// The sealed `conversation` representation (COMMERCE-HOOKS H18): what the
// stable inbox operations answer (`conversations.list`, `conversations.get`,
// `conversations.list_messages`) and what a `conversation.message_received`
// webhook carries. Built in full here; the app edge and each webhook endpoint
// redact the contact by the grant's customer data.
//
// Every read is bounded: a page of threads reads its contacts, last lines and
// their attachments in one query each (ids bound as one JSON value).

import type { Database } from "@scalius/database/client";
import {
  conversationAttachments,
  conversationChannelContacts,
  conversationChannelMessages,
  conversationMessages,
  conversations,
} from "@scalius/database/schema";
import { buildEventRepresentation, type EventRepresentation } from "@scalius/shared/events";
import { allProtectedData } from "@scalius/shared/plugins/protected-data";
import { and, asc, eq, gte, sql, type SQL } from "drizzle-orm";

type ThreadRow = typeof conversations.$inferSelect;
type MessageRow = typeof conversationMessages.$inferSelect;
type ConversationRepresentation = EventRepresentation<"conversation">;
type MessageRepresentation = ConversationRepresentation["lastMessage"] & object;

/** The most threads or lines one page reads. */
export const CONVERSATION_PAGE_MAX = 50;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const inJson = (column: SQL | typeof conversations.id, ids: readonly string[]) =>
  sql`${column} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...new Set(ids)])}))`;

interface StoredChannelAttachment {
  kind?: unknown;
  ref?: unknown;
  url?: unknown;
  mediaType?: unknown;
  name?: unknown;
  sizeBytes?: unknown;
}

const text = (value: unknown) => typeof value === "string" && value ? value : null;

function channelAttachments(json: string | null): MessageRepresentation["attachments"] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as StoredChannelAttachment[]).slice(0, 10).map((attachment) => ({
      kind: text(attachment.kind) ?? "file",
      mediaType: text(attachment.mediaType),
      name: text(attachment.name),
      sizeBytes: typeof attachment.sizeBytes === "number" && Number.isInteger(attachment.sizeBytes) ? attachment.sizeBytes : null,
      ref: text(attachment.ref),
      url: text(attachment.url),
    }));
  } catch {
    return [];
  }
}

/** The lines' attachments and channel facts, one query each. */
async function messageExtras(db: Database, messageIds: readonly string[]) {
  const attachments = new Map<string, MessageRepresentation["attachments"]>();
  const delivery = new Map<string, MessageRepresentation["delivery"]>();
  if (messageIds.length === 0) return { attachments, delivery };
  const [images, channel] = await Promise.all([
    db.select({
      id: conversationAttachments.id,
      messageId: conversationAttachments.messageId,
      mediaType: conversationAttachments.mediaType,
      sizeBytes: conversationAttachments.sizeBytes,
    }).from(conversationAttachments)
      .where(inJson(sql`${conversationAttachments.messageId}`, messageIds))
      .orderBy(asc(conversationAttachments.attachedAt), asc(conversationAttachments.id)).all(),
    db.select().from(conversationChannelMessages)
      .where(inJson(sql`${conversationChannelMessages.messageId}`, messageIds)).all(),
  ]);
  for (const image of images) {
    if (!image.messageId) continue;
    const list = attachments.get(image.messageId) ?? [];
    // A storefront image is referenced by its attachment id (the dashboard serves it to staff).
    list.push({ kind: "image", mediaType: image.mediaType, name: null, sizeBytes: image.sizeBytes, ref: image.id, url: null });
    attachments.set(image.messageId, list);
  }
  for (const row of channel) {
    attachments.set(row.messageId, [...(attachments.get(row.messageId) ?? []), ...channelAttachments(row.attachments)].slice(0, 10));
    delivery.set(row.messageId, { direction: row.direction, status: row.status, providerId: row.providerId });
  }
  return { attachments, delivery };
}

function messageValue(row: MessageRow, extras: Awaited<ReturnType<typeof messageExtras>>): MessageRepresentation {
  const author = row.authorType === "customer" || row.authorType === "guest_receipt"
    ? "customer"
    : row.authorType === "staff" ? (row.authorAppId ? "app" : "staff") : "system";
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    visibility: row.visibility,
    author,
    appId: row.authorAppId ?? null,
    body: row.body,
    eventKind: row.eventKind,
    attachments: extras.attachments.get(row.id) ?? [],
    delivery: extras.delivery.get(row.id) ?? null,
    createdAt: iso(row.createdAt),
  };
}

/** The sealed representations of threads, in the order given. */
export async function conversationRepresentations(db: Database, threads: readonly ThreadRow[]): Promise<ConversationRepresentation[]> {
  if (threads.length === 0) return [];
  const ids = threads.map((thread) => thread.id);
  const [contacts, lastLines] = await Promise.all([
    db.select().from(conversationChannelContacts).where(inJson(sql`${conversationChannelContacts.conversationId}`, ids)).all(),
    db.select({ message: conversationMessages }).from(conversationMessages)
      .innerJoin(conversations, and(eq(conversations.id, conversationMessages.conversationId), eq(conversations.lastSeq, conversationMessages.seq)))
      .where(inJson(sql`${conversations.id}`, ids)).all(),
  ]);
  const extras = await messageExtras(db, lastLines.map(({ message }) => message.id));
  const contactOf = new Map(contacts.map((contact) => [contact.conversationId, contact]));
  const lastOf = new Map(lastLines.map(({ message }) => [message.conversationId, messageValue(message, extras)]));
  const everything = allProtectedData();
  return threads.map((thread) => {
    const contact = contactOf.get(thread.id);
    return buildEventRepresentation("conversation", {
      id: thread.id,
      subjectType: thread.subjectType,
      status: thread.status,
      channel: thread.channel,
      orderId: thread.orderId,
      customerId: thread.customerId,
      subject: thread.subject,
      contact: contact ? { name: contact.contactName, address: contact.contactKey, providerId: contact.providerId } : null,
      assigneeUserId: thread.assigneeUserId,
      lastSeq: thread.lastSeq,
      lastMessageAt: thread.lastMessageAt === null ? null : iso(thread.lastMessageAt),
      lastMessage: lastOf.get(thread.id) ?? null,
      revision: thread.version,
      createdAt: iso(thread.createdAt),
      updatedAt: iso(thread.updatedAt),
      closedAt: thread.closedAt === null ? null : iso(thread.closedAt),
    }, everything);
  });
}

/** One thread's representation, or null. */
export async function readConversationRepresentation(db: Database, conversationId: string): Promise<ConversationRepresentation | null> {
  const thread = await db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  return thread ? (await conversationRepresentations(db, [thread]))[0]! : null;
}

/** Threads in (updatedAt, id) order: `after` is the keyset past a cursor. */
export function listConversationRows(db: Database, options: {
  status?: ThreadRow["status"];
  channel?: string;
  updatedSinceSeconds?: number;
  after?: SQL;
  limit: number;
}): Promise<ThreadRow[]> {
  const where: SQL[] = [];
  if (options.status) where.push(eq(conversations.status, options.status));
  if (options.channel) where.push(eq(conversations.channel, options.channel));
  if (options.updatedSinceSeconds !== undefined) where.push(gte(conversations.updatedAt, options.updatedSinceSeconds));
  if (options.after) where.push(options.after);
  return db.select().from(conversations).where(where.length ? and(...where) : undefined)
    .orderBy(asc(conversations.updatedAt), asc(conversations.id))
    .limit(Math.min(Math.max(options.limit, 1), CONVERSATION_PAGE_MAX + 1)).all();
}

/** A thread's lines in seq order (internal notes included): `after` is the keyset past a cursor. */
export function listConversationMessageRows(db: Database, conversationId: string, options: { after?: SQL; limit: number }): Promise<MessageRow[]> {
  return db.select().from(conversationMessages)
    .where(and(eq(conversationMessages.conversationId, conversationId), options.after))
    .orderBy(asc(conversationMessages.seq), asc(conversationMessages.id))
    .limit(Math.min(Math.max(options.limit, 1), CONVERSATION_PAGE_MAX + 1)).all();
}

/** The sealed representations of lines, in the order given. */
export async function conversationMessageRepresentations(db: Database, rows: readonly MessageRow[]): Promise<MessageRepresentation[]> {
  const extras = await messageExtras(db, rows.map((row) => row.id));
  return rows.map((row) => messageValue(row, extras));
}
