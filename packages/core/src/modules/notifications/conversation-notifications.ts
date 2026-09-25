// Thread notifications at send time (Wave A §10). The outbox row carries only
// the thread id and the message seq; this reads the line and resolves the
// recipients now:
//   conversation_reply (staff → buyer): the order's own contact for order
//     threads, verified account contacts for store threads. Email carries the
//     message text (HTML-escaped); SMS is off by default and, when on, carries
//     no text and is coalesced to one per thread per hour.
//   conversation_message (buyer → staff): push ("New message about #1234", no
//     text) and, when enabled, the staff email recipients.
// Reads the conversation tables directly (no conversations-domain import):
// notifications sits below conversations in the domain graph.

import type { Database } from "@scalius/database/client";
import {
  conversationMessages,
  conversations,
  customers,
  notificationDeliveryReceipts,
  orders,
} from "@scalius/database/schema";
import { escapeHtml } from "@scalius/shared/html-escape";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { isReady } from "@scalius/shared/readiness";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { and, eq, gt } from "drizzle-orm";
import { sendEmail, type EmailRuntimeContext } from "../../integrations/email";
import { notificationsDocument } from "../settings/documents";
import { MESSAGE_COPY, type MessageLanguage } from "./message-copy";
import { storeHeaderHtml, type EmailStore } from "./notification-templates";
import {
  NOTIFICATION_TURNED_OFF,
  buildDispatchResult,
  compactProviderLogDetail,
  dispatchWithReceipt,
  emailResultToDeliveryResult,
  maskEmail,
  maskPhone,
  recordProviderBlockedDeliveryIfNeeded,
  recordSkippedDelivery,
  sendAdminPush,
  type DeliveryReceiptSubject,
  type OrderNotificationChannelOutcome,
  type OrderNotificationDispatchResult,
} from "./notifications.service";
import { readStoreIdentity } from "./store-messages";

/** An SMS reply alert goes out at most once per thread per hour (§15 q8). */
export const CONVERSATION_SMS_COALESCE_SECONDS = 60 * 60;
export const CONVERSATION_SMS_COALESCED = "conversation_sms_coalesced";

export interface ConversationNotificationClaim {
  outboxId: string;
  conversationId: string;
  notificationType: "conversation_reply" | "conversation_message";
  seq: number;
}

export interface ConversationNotificationOptions {
  encryptionKey?: string;
  env: Env;
}

export type ConversationNotificationResult =
  | { kind: "dispatched"; result: OrderNotificationDispatchResult }
  | { kind: "nothing_to_send"; reason: string };

interface ThreadFacts {
  id: string;
  subjectType: string;
  orderId: string | null;
  customerId: string | null;
  seq: number;
  kind: string;
  visibility: string;
  authorType: string;
  body: string | null;
}

async function readThreadLine(db: Database, conversationId: string, seq: number): Promise<ThreadFacts | undefined> {
  return await db
    .select({
      id: conversations.id,
      subjectType: conversations.subjectType,
      orderId: conversations.orderId,
      customerId: conversations.customerId,
      seq: conversationMessages.seq,
      kind: conversationMessages.kind,
      visibility: conversationMessages.visibility,
      authorType: conversationMessages.authorType,
      body: conversationMessages.body,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.seq, seq)))
    .get();
}

interface ThreadParty {
  name: string;
  email: string | null;
  phone: string | null;
  orderNumber: string | null;
  /** The buyer reads this thread in their account (verified owner or store thread). */
  inAccount: boolean;
  orderNumberRaw: number | null;
}

/** The buyer side of a thread: the order's own contact, or the account's verified contacts. */
async function readThreadParty(db: Database, thread: ThreadFacts): Promise<ThreadParty | null> {
  if (thread.subjectType === "order" && thread.orderId) {
    const order = await db
      .select({
        id: orders.id,
        name: orders.customerName,
        email: orders.customerEmail,
        phone: orders.customerPhone,
        orderNumber: orders.orderNumber,
        owner: orders.accountOwnerCustomerId,
      })
      .from(orders)
      .where(eq(orders.id, thread.orderId))
      .get();
    if (!order) return null;
    return {
      name: order.name?.trim() || "Customer",
      email: order.email?.trim() || null,
      phone: order.phone?.trim() || null,
      orderNumber: formatOrderNumber(order.orderNumber, order.id),
      orderNumberRaw: order.orderNumber,
      inAccount: Boolean(order.owner),
    };
  }
  if (thread.customerId) {
    const customer = await db
      .select({
        name: customers.name,
        email: customers.email,
        emailVerifiedAt: customers.emailVerifiedAt,
        phone: customers.phone,
        phoneVerifiedAt: customers.phoneVerifiedAt,
        deletedAt: customers.deletedAt,
      })
      .from(customers)
      .where(eq(customers.id, thread.customerId))
      .get();
    if (!customer || customer.deletedAt) return null;
    // Unverified contacts never receive account-thread messages (§4.3).
    return {
      name: customer.name?.trim() || "Customer",
      email: customer.emailVerifiedAt ? customer.email?.trim() || null : null,
      phone: customer.phoneVerifiedAt ? customer.phone?.trim() || null : null,
      orderNumber: null,
      orderNumberRaw: null,
      inAccount: true,
    };
  }
  return null;
}

function dashboardInboxLink(env: object | undefined, conversationId: string): string | null {
  const origin = (env as { BETTER_AUTH_URL?: unknown } | undefined)?.BETTER_AUTH_URL;
  const dashboardUrl = typeof origin === "string" ? origin.trim() : "";
  if (!dashboardUrl) return null;
  try {
    return new URL(`/admin/inbox/${encodeURIComponent(conversationId)}`, dashboardUrl).href;
  } catch {
    return null;
  }
}

/** Where the buyer reads the reply. Never a tokenized URL; phone and email never go in it. */
function buyerThreadLink(storefrontUrl: unknown, thread: ThreadFacts, party: ThreadParty): string | null {
  const origin = normalizeStorefrontOrigin(typeof storefrontUrl === "string" ? storefrontUrl : undefined);
  if (!origin) return null;
  if (party.inAccount) return `${origin}/account/inbox/${encodeURIComponent(thread.id)}`;
  return `${origin}/track-order?order=${encodeURIComponent(String(party.orderNumberRaw ?? thread.orderId ?? ""))}`;
}

const BUTTON = "display:inline-block;padding:12px 20px;background:#202124;color:#ffffff;text-decoration:none;border-radius:4px;";

/** A short branded email around one message. Every value is escaped. */
export function renderConversationEmail(input: {
  language: MessageLanguage;
  store: EmailStore;
  subject: string;
  intro: string;
  message: string | null;
  action: { label: string; href: string } | null;
  footer: string | null;
}): { subject: string; html: string; text: string } {
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
  const quoted = input.message
    ? `<div style="margin:0 0 24px;padding:16px;background:#f1f3f4;border-radius:8px;white-space:pre-wrap;">${escapeHtml(input.message).replace(/\n/g, "<br>")}</div>`
    : "";
  const action = input.action
    ? `<p style="margin:0 0 24px;"><a href="${escapeHtml(input.action.href)}" style="${BUTTON}">${escapeHtml(input.action.label)}</a></p>`
    : "";
  const footer = input.footer ? `<p style="margin:0;color:#5f6368;font-size:14px;">${escapeHtml(input.footer)}</p>` : "";
  const html = `<!doctype html><html lang="${input.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#ffffff;">
<div role="main" style="max-width:560px;margin:0 auto;padding:24px 20px;overflow-wrap:anywhere;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
${storeHeaderHtml(input.store)}
<p style="margin:0 0 16px;">${escapeHtml(input.intro)}</p>
${quoted}${action}${footer}
</div></body></html>`;
  const text = [
    input.store.name,
    input.intro,
    input.message,
    input.action ? `${input.action.label}: ${input.action.href}` : null,
    input.footer,
  ].filter(Boolean).join("\n\n");
  return { subject, html, text };
}

/** An SMS alert for this thread was accepted within the last hour. */
async function smsRecentlyAccepted(db: Database, conversationId: string, now: number): Promise<boolean> {
  const row = await db
    .select({ id: notificationDeliveryReceipts.id })
    .from(notificationDeliveryReceipts)
    .where(and(
      eq(notificationDeliveryReceipts.subjectType, "conversation"),
      eq(notificationDeliveryReceipts.subjectId, conversationId),
      eq(notificationDeliveryReceipts.channel, "sms"),
      gt(notificationDeliveryReceipts.acceptedAt, now - CONVERSATION_SMS_COALESCE_SECONDS),
    ))
    .limit(1)
    .get();
  return Boolean(row);
}

export async function sendConversationNotification(
  db: Database,
  claim: ConversationNotificationClaim,
  options: ConversationNotificationOptions,
): Promise<ConversationNotificationResult> {
  if (!Number.isInteger(claim.seq) || claim.seq < 1) return { kind: "nothing_to_send", reason: "missing_seq" };
  const thread = await readThreadLine(db, claim.conversationId, claim.seq);
  if (!thread) return { kind: "nothing_to_send", reason: "message_missing" };
  if (thread.kind !== "message" || thread.visibility !== "public") {
    return { kind: "nothing_to_send", reason: "not_a_public_message" };
  }
  const buyerLine = thread.authorType === "customer" || thread.authorType === "guest_receipt";
  if (claim.notificationType === "conversation_reply") {
    if (thread.authorType !== "staff") return { kind: "nothing_to_send", reason: "not_a_staff_reply" };
    return { kind: "dispatched", result: await sendReplyToBuyer(db, claim, thread, options) };
  }
  if (!buyerLine) return { kind: "nothing_to_send", reason: "not_a_buyer_message" };
  return { kind: "dispatched", result: await sendMessageToStaff(db, claim, thread, options) };
}

async function sendReplyToBuyer(
  db: Database,
  claim: ConversationNotificationClaim,
  thread: ThreadFacts,
  options: ConversationNotificationOptions,
): Promise<OrderNotificationDispatchResult> {
  const outcomes: OrderNotificationChannelOutcome[] = [];
  const subject: DeliveryReceiptSubject = { subjectType: "conversation", subjectId: thread.id, orderId: null };
  const base = { db, outboxId: claim.outboxId, notificationType: claim.notificationType, ...subject };

  let channels = ["email"];
  try {
    const { getNotificationChannels } = await import("../settings/settings.service");
    channels = (await getNotificationChannels(db)).conversation_reply ?? channels;
  } catch (error: unknown) {
    console.warn("[Notifications] Failed to read reply channels, defaulting to email:", compactProviderLogDetail(error));
  }

  const party = await readThreadParty(db, thread);
  if (!channels.includes("email") && !channels.includes("sms")) {
    outcomes.push(await recordSkippedDelivery({
      ...base,
      channel: "email",
      provider: "email",
      recipient: `conversation:${thread.id}:off`,
      recipientMasked: "turned-off",
      reason: NOTIFICATION_TURNED_OFF,
    }));
    return buildDispatchResult(outcomes);
  }

  const store = await readStoreIdentity(db);
  const copy = MESSAGE_COPY[store.language].conversation;
  const order = party?.orderNumber ?? null;
  const emailContext: EmailRuntimeContext = { db, env: options.env as unknown as Record<string, unknown>, encryptionKey: options.encryptionKey };

  if (channels.includes("email")) {
    const email = party?.email ?? null;
    if (!email) {
      outcomes.push(await recordSkippedDelivery({
        ...base,
        channel: "email",
        provider: "email",
        recipient: `missing-email:${thread.id}`,
        recipientMasked: "missing-email",
        reason: "missing_email_recipient",
      }));
    } else {
      const target = { ...base, channel: "email" as const, provider: "email", recipient: email, recipientMasked: maskEmail(email) };
      const blocked = await recordProviderBlockedDeliveryIfNeeded(target);
      outcomes.push(blocked ?? await dispatchWithReceipt({
        ...target,
        send: async (delivery) => {
          const link = party ? buyerThreadLink(options.env.STOREFRONT_URL, thread, party) : null;
          const rendered = renderConversationEmail({
            language: store.language,
            store,
            subject: copy.replySubject(store.name, order),
            intro: copy.replyIntro(store.name, order),
            message: thread.body,
            action: link ? { label: copy.replyAction, href: link } : null,
            footer: copy.replyNoReply,
          });
          return emailResultToDeliveryResult(await sendEmail({
            ...rendered,
            to: email,
            fromName: store.name ?? undefined,
            idempotencyKey: delivery.receiptKey,
          }, emailContext));
        },
      }));
    }
  }

  if (channels.includes("sms")) {
    outcomes.push(await sendReplySms(db, base, thread, party, store.name, order, options));
  }

  return buildDispatchResult(outcomes);
}

async function sendReplySms(
  db: Database,
  base: DeliveryReceiptSubject & { db: Database; outboxId: string; notificationType: ConversationNotificationClaim["notificationType"] },
  thread: ThreadFacts,
  party: ThreadParty | null,
  storeName: string | null,
  order: string | null,
  options: ConversationNotificationOptions,
): Promise<OrderNotificationChannelOutcome> {
  const phone = party?.phone ?? null;
  if (!phone) {
    return recordSkippedDelivery({
      ...base,
      channel: "sms",
      provider: "sms",
      recipient: `missing-phone:${thread.id}`,
      recipientMasked: "missing-phone",
      reason: "missing_sms_recipient",
    });
  }
  if (await smsRecentlyAccepted(db, thread.id, Math.floor(Date.now() / 1000))) {
    return recordSkippedDelivery({
      ...base,
      channel: "sms",
      provider: "sms",
      recipient: phone,
      recipientMasked: maskPhone(phone),
      reason: CONVERSATION_SMS_COALESCED,
    });
  }
  try {
    const { getActiveSmsProvider, getSmsProviderReadiness } = await import("../../integrations/sms");
    const readiness = await getSmsProviderReadiness(db, options.encryptionKey);
    const providerName = readiness.activeProvider ?? "sms";
    if (!isReady(readiness)) {
      return recordSkippedDelivery({
        ...base,
        channel: "sms",
        provider: providerName,
        recipient: `sms-setup:${thread.id}`,
        recipientMasked: "sms-setup",
        reason: readiness.issues[0]?.message ?? "SMS provider is not configured",
      });
    }
    const provider = await getActiveSmsProvider(db, options.encryptionKey);
    const target = { ...base, channel: "sms" as const, provider: provider?.name ?? providerName, recipient: phone, recipientMasked: maskPhone(phone) };
    const blocked = await recordProviderBlockedDeliveryIfNeeded(target);
    if (blocked) return blocked;
    const copy = MESSAGE_COPY[(await readStoreIdentity(db)).language].conversation;
    return await dispatchWithReceipt({
      ...target,
      send: async () => {
        if (!provider) {
          return { success: false, provider: "sms", providerStatus: "missing_sms_provider", rawResponse: "No active SMS provider configured", retryable: false };
        }
        const result = await provider.sendSms({ to: phone, message: copy.replySms(storeName, order) });
        return {
          success: result.success,
          provider: provider.name,
          providerMessageId: result.providerRef,
          providerStatus: result.rawStatus,
          rawResponse: result.rawStatus,
          retryable: result.retryable,
        };
      },
    });
  } catch (error: unknown) {
    console.error(`[Notifications] Reply SMS failed for conversation ${thread.id}: ${compactProviderLogDetail(error)}`);
    return {
      channel: "sms",
      provider: "sms",
      recipientMasked: maskPhone(phone),
      status: "failed",
      error: compactProviderLogDetail(error),
      retryable: true,
    };
  }
}

async function sendMessageToStaff(
  db: Database,
  claim: ConversationNotificationClaim,
  thread: ThreadFacts,
  options: ConversationNotificationOptions,
): Promise<OrderNotificationDispatchResult> {
  const outcomes: OrderNotificationChannelOutcome[] = [];
  const subject: DeliveryReceiptSubject = { subjectType: "conversation", subjectId: thread.id, orderId: null };

  let channels = ["push"];
  try {
    const { getAdminNotificationChannels } = await import("../settings/settings.service");
    channels = (await getAdminNotificationChannels(db)).conversation_message ?? channels;
  } catch (error: unknown) {
    console.warn("[Notifications] Failed to read staff message channels, defaulting to push:", compactProviderLogDetail(error));
  }
  if (channels.length === 0) return buildDispatchResult(outcomes);

  const [party, store] = await Promise.all([readThreadParty(db, thread), readStoreIdentity(db)]);
  const copy = MESSAGE_COPY[store.language].conversation;
  const order = party?.orderNumber ?? null;
  const link = dashboardInboxLink(options.env, thread.id);

  if (channels.includes("push")) {
    const push = await sendAdminPush(db, options.env, {
      outboxId: claim.outboxId,
      receipt: { ...subject, notificationType: claim.notificationType },
      setupRecipient: `firebase-setup:${thread.id}:${claim.notificationType}`,
      logLabel: `conversation ${thread.id}`,
      // No message text in a push (§10).
      title: copy.staffTitle(order),
      body: copy.staffBody,
      link,
      data: { conversationId: thread.id, notificationType: claim.notificationType },
    });
    outcomes.push(...push.outcomes);
  }

  if (channels.includes("email")) {
    const recipients = (await notificationsDocument.read(db)).staffEmailRecipients;
    const customer = party?.name ?? "Customer";
    const emailContext: EmailRuntimeContext = { db, env: options.env as unknown as Record<string, unknown>, encryptionKey: options.encryptionKey };
    for (const recipient of recipients) {
      const target = {
        db,
        outboxId: claim.outboxId,
        notificationType: claim.notificationType,
        ...subject,
        channel: "email" as const,
        provider: "email",
        recipient: `staff:${recipient}`,
        recipientMasked: `staff ${maskEmail(recipient)}`,
      };
      const blocked = await recordProviderBlockedDeliveryIfNeeded(target);
      outcomes.push(blocked ?? await dispatchWithReceipt({
        ...target,
        send: async (delivery) => emailResultToDeliveryResult(await sendEmail({
          ...renderConversationEmail({
            language: store.language,
            store,
            subject: copy.staffEmailSubject(store.name, order, customer),
            intro: copy.staffEmailBody(customer, order),
            message: null,
            action: link ? { label: copy.staffAction, href: link } : null,
            footer: null,
          }),
          to: recipient,
          fromName: store.name ?? undefined,
          idempotencyKey: delivery.receiptKey,
        }, emailContext)),
      }));
    }
  }

  return buildDispatchResult(outcomes);
}
