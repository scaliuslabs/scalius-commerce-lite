// Chat-channel threads (0199, COMMERCE-HOOKS H18): a messaging app delivers
// buyers' WhatsApp, Messenger, … messages into the inbox, and staff replies
// go back out on the channel.
//
// - One thread per channel and contact (`conversation_channel_contacts`,
//   unique by channel and contact key): a store thread of the contact's
//   customer, marked with its channel, that the buyer never reads on the
//   storefront. Its first message creates it, in one batch with the line.
// - A message is applied once per provider and message id
//   (`conversation_channel_messages`, unique per provider): a redelivered
//   push finds the row and changes nothing. Attachments are kept as
//   references (the provider's media id or an https URL), never the bytes.
// - A staff (or app) public reply in a channel thread records an outbound
//   row `pending` in the post's batch; the reply notification sends it
//   through the thread's provider (notifications/conversation-notifications.ts)
//   and receipts move it forward only: sent, delivered, read, or failed.
//
// Logs carry ids only, never the contact or the words.

import type { Database } from "@scalius/database/client";
import {
  conversationChannelContacts,
  conversationChannelMessages,
  conversations,
} from "@scalius/database/schema";
import { CONVERSATION_LIMITS, normalizeConversationBody } from "@scalius/shared/conversation";
import type {
  MessagingAttachment,
  MessagingChannel,
  MessagingInboundMessage,
  MessagingReceipt,
} from "@scalius/shared/plugins/providers";
import { and, eq, inArray } from "drizzle-orm";
import { ConflictError } from "../../errors";
import type { NotificationSender } from "../notifications";
import {
  newConversationId,
  planConversationAppend,
  readThread,
  sendConversationNotifications,
  type ConversationLine,
} from "./threads";

type BatchStatements = Parameters<Database["batch"]>[0];

const RECEIVE_ATTEMPTS = 3;
/** The stored attachment references of one message (the column's bound). */
const ATTACHMENTS_JSON_MAX = 8_000;

/** Who wrote on a channel: where replies go, and the profile name the channel gave. */
export interface ChannelContact {
  channel: MessagingChannel;
  /** E.164 on WhatsApp and Viber, the channel's own sender id otherwise. */
  address: string;
  name: string | null;
}

export type ChannelReceiveOutcome =
  | { status: "received"; conversationId: string; messageId: string; seq: number; created: boolean }
  /** The provider delivered this message id before: nothing changed. */
  | { status: "duplicate"; conversationId: string; messageId: string };

export interface ReceiveChannelMessageInput {
  /** The messaging app provider that delivered it (`<app id>:<provider id>`). */
  providerId: string;
  message: MessagingInboundMessage;
  /**
   * The customer a new contact's thread belongs to, found or created by the
   * caller (the customers domain sits beside this one, not below it).
   */
  customerFor: (contact: ChannelContact) => Promise<string>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isConstraintError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /constraint|unique|SQLITE_CONSTRAINT|conversation sequence|message seq|duplicate key/i.test(text);
}

/** The line's text: the buyer's words, else an attachment's caption, else what was sent. */
export function channelMessageBody(message: Pick<MessagingInboundMessage, "text" | "attachments">): string {
  for (const candidate of [message.text, ...(message.attachments ?? []).map((attachment) => attachment.caption)]) {
    const body = normalizeConversationBody(candidate);
    if (body.ok) return body.value;
  }
  const kinds = [...new Set((message.attachments ?? []).map((attachment) => attachment.kind))];
  return kinds.length ? `[${kinds.join(", ")}]` : "[message]";
}

/** The references kept for a message, within the column's bound: URLs go before references do. */
export function storedChannelAttachments(attachments: readonly MessagingAttachment[] | undefined): string | null {
  if (!attachments?.length) return null;
  const kept = attachments.slice(0, CONVERSATION_LIMITS.attachmentsPerMessage * 4).map((attachment) => ({
    kind: attachment.kind,
    ...(attachment.ref ? { ref: attachment.ref } : {}),
    ...(attachment.url ? { url: attachment.url } : {}),
    ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}),
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
  }));
  let json = JSON.stringify(kept);
  if (json.length <= ATTACHMENTS_JSON_MAX) return json;
  // A long URL is dropped where the provider's media id can fetch the file.
  const lean = kept.map((attachment) => attachment.ref ? { ...attachment, url: undefined } : attachment);
  while (lean.length > 0) {
    json = JSON.stringify(lean);
    if (json.length <= ATTACHMENTS_JSON_MAX) return json;
    lean.pop();
  }
  return null;
}

async function findDelivered(db: Database, providerId: string, providerMessageId: string) {
  return await db
    .select({ conversationId: conversationChannelMessages.conversationId, messageId: conversationChannelMessages.messageId })
    .from(conversationChannelMessages)
    .where(and(
      eq(conversationChannelMessages.providerId, providerId),
      eq(conversationChannelMessages.providerMessageId, providerMessageId),
    ))
    .get();
}

/** The thread of a channel and contact, if the contact wrote before. */
export async function findChannelThread(db: Database, channel: MessagingChannel, address: string) {
  return await db
    .select({ conversationId: conversationChannelContacts.conversationId })
    .from(conversationChannelContacts)
    .where(and(eq(conversationChannelContacts.channel, channel), eq(conversationChannelContacts.contactKey, address)))
    .get();
}

/**
 * Files one inbound message in its contact's thread, creating the thread on
 * the contact's first message. A message id the provider delivered before
 * changes nothing (`duplicate`), however often it is pushed or raced.
 */
export async function receiveChannelMessage(
  db: Database,
  input: ReceiveChannelMessageInput,
  options: { send?: NotificationSender } = {},
): Promise<ChannelReceiveOutcome> {
  const { providerId, message } = input;
  const contact: ChannelContact = { channel: message.channel, address: message.from.address, name: message.from.name ?? null };
  const body = channelMessageBody(message);
  const attachments = storedChannelAttachments(message.attachments);
  const now = nowSeconds();
  let customerId: string | null = null;

  for (let attempt = 1; attempt <= RECEIVE_ATTEMPTS; attempt += 1) {
    const delivered = await findDelivered(db, providerId, message.messageId);
    if (delivered) return { status: "duplicate", ...delivered };

    const existing = await findChannelThread(db, contact.channel, contact.address);
    const thread = existing ? await readThread(db, existing.conversationId) : undefined;
    if (existing && !thread) throw new ConflictError("The contact's conversation is missing.");
    if (!thread) customerId ??= await input.customerFor(contact);
    const owner = thread?.customerId ?? customerId!;
    const id = thread?.id ?? newConversationId();
    const line: ConversationLine = {
      kind: "message",
      visibility: "public",
      authorType: "customer",
      authorCustomerId: owner,
      body,
    };
    const plan = planConversationAppend(db, { id, lastSeq: thread?.lastSeq ?? 0 }, [line], { notify: true });
    const posted = plan.lines[0]!;
    const statements: unknown[] = [];
    if (!thread) {
      statements.push(
        db.insert(conversations).values({
          id,
          subjectType: "store",
          customerId: owner,
          channel: contact.channel,
          status: "open",
          createdAt: now,
          updatedAt: now,
        }),
        db.insert(conversationChannelContacts).values({
          conversationId: id,
          channel: contact.channel,
          contactKey: contact.address,
          contactName: contact.name,
          providerId,
          lastInboundAt: now,
          createdAt: now,
          updatedAt: now,
        }),
      );
    } else {
      // Replies go out through the provider that last delivered from the contact.
      statements.push(db.update(conversationChannelContacts).set({
        providerId,
        ...(contact.name ? { contactName: contact.name } : {}),
        lastInboundAt: now,
        updatedAt: now,
      }).where(eq(conversationChannelContacts.conversationId, id)));
    }
    statements.push(...plan.statements, db.insert(conversationChannelMessages).values({
      messageId: posted.id,
      conversationId: id,
      direction: "inbound",
      providerId,
      providerMessageId: message.messageId,
      status: "received",
      attachments,
      createdAt: now,
      updatedAt: now,
    }));
    try {
      await db.batch(statements as unknown as BatchStatements);
    } catch (error) {
      // A concurrent delivery of the same message, or a line or thread raced in: read again.
      if (!isConstraintError(error) || attempt === RECEIVE_ATTEMPTS) throw error;
      continue;
    }
    await sendConversationNotifications(options.send, plan.outboxIds);
    return { status: "received", conversationId: id, messageId: posted.id, seq: posted.seq, created: !thread };
  }
  throw new ConflictError("The conversation changed while the message was filed. The provider retries it.");
}

/** Which statuses a receipt may follow: a receipt never moves an outbound line backwards. */
const RECEIPT_FROM: Record<MessagingReceipt["status"], ReadonlyArray<"pending" | "sent" | "delivered">> = {
  sent: ["pending"],
  delivered: ["pending", "sent"],
  read: ["pending", "sent", "delivered"],
  failed: ["pending", "sent"],
};

/**
 * Applies a delivery receipt to the store's outbound line the provider sent
 * as `providerRef`, forward only. Another provider's line is never reached.
 */
export async function applyChannelReceipt(
  db: Database,
  providerId: string,
  receipt: Pick<MessagingReceipt, "providerRef" | "status">,
): Promise<"applied" | "unchanged" | "unknown"> {
  const target = and(
    eq(conversationChannelMessages.providerId, providerId),
    eq(conversationChannelMessages.providerMessageId, receipt.providerRef),
    eq(conversationChannelMessages.direction, "outbound"),
  );
  const moved = await db.update(conversationChannelMessages).set({
    status: receipt.status,
    ...(receipt.status === "failed" ? { failure: "The channel reported the message undelivered." } : {}),
    updatedAt: nowSeconds(),
  }).where(and(target, inArray(conversationChannelMessages.status, [...RECEIPT_FROM[receipt.status]])))
    .returning({ messageId: conversationChannelMessages.messageId });
  if (moved.length > 0) return "applied";
  const known = await db.select({ messageId: conversationChannelMessages.messageId })
    .from(conversationChannelMessages).where(target).get();
  return known ? "unchanged" : "unknown";
}
