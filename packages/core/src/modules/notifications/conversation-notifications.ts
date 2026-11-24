import { recordStaffAlert } from "./staff-alerts";
// Thread notifications at send time (Wave A §10). The outbox row carries only
// the thread id and the message seq; this reads the line and resolves the
// recipients now:
//   conversation_reply (staff → buyer): the order's own contact for every
//     thread about an order (order, warranty claim and review threads),
//     verified account contacts for store threads. The merchant's
//     `conversation_reply` template, never the message text (a staff line
//     can hold a sign-in, which stays behind the buyer's own read, as a
//     delivery message does): a link to where the buyer reads it. While the
//     buyer has not read the thread, a burst of replies is one email per
//     15-minute window and one SMS (off by default) per hour, per recipient:
//     the delivery is keyed by thread, the buyer's read position and the
//     window (`replyReceiptScope`), so the unique receipt key lets one send
//     through even when two replies are sent at once.
//   conversation_message (buyer → staff): push ("New message about #1234", no
//     text) and, when enabled, the staff email recipients.
//   A chat-channel thread (0202) replies on its channel only: the line's
//     outbound row (`pending`, committed with the post) is sent as text
//     through the thread's messaging app provider, keyed by the message id,
//     and moves to `sent` or `failed`; never email or SMS.
// Reads the conversation tables directly (no conversations-domain import):
// notifications sits below conversations in the domain graph.

import type { Database } from "@scalius/database/client";
import {
  conversationChannelContacts,
  conversationChannelMessages,
  conversationMessages,
  conversations,
  customers,
  orders,
} from "@scalius/database/schema";
import { escapeHtml } from "@scalius/shared/html-escape";
import { conversationProductSnapshots } from "@scalius/shared/conversation";
import { formatOrderNumber, orderNumberTextIn } from "@scalius/shared/order-utils";
import { numberLocale } from "@scalius/shared/locale-format";
import { isReady } from "@scalius/shared/readiness";
import { and, eq } from "drizzle-orm";
import { sendEmail, type EmailRuntimeContext } from "../../integrations/email";
import { resolveAppProvider, type AppProviders } from "../../integrations/provider-port";
import { messagingSendSchema, providerErrorOf, type MessagingChannel } from "@scalius/shared/plugins/providers";
import { notificationsDocument } from "./documents";
import { getAdminNotificationChannels, getNotificationChannels } from "./channel-settings";
import { MESSAGE_COPY, type MessageLanguage } from "./message-copy";
import { renderEmailTemplate, renderMessageEmail, renderSmsTemplate, storeHeaderHtml, type EmailStore, type NotificationVariableValues } from "./notification-templates";
import { getNotificationTemplates } from "./notification-templates.service";
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
import { createProviderClientReference } from "./order-notification-delivery-receipts";
import { buyerMessageScope, buyerStorefrontLink, readStoreIdentity } from "./store-messages";

/** An unread burst of replies is one SMS per hour (§15 q8). */
export const CONVERSATION_SMS_COALESCE_SECONDS = 60 * 60;
/** A burst of staff replies the buyer has not read is one email per 15-minute window. */
export const CONVERSATION_EMAIL_COALESCE_SECONDS = 15 * 60;

export interface ConversationNotificationClaim {
  outboxId: string;
  conversationId: string;
  notificationType: "conversation_reply" | "conversation_message";
  seq: number;
}

export interface ConversationNotificationOptions {
  encryptionKey?: string;
  env: Env;
  /** The app providers a saved SMS or email choice may name. */
  appProviders?: AppProviders;
}

export type ConversationNotificationResult =
  | { kind: "dispatched"; result: OrderNotificationDispatchResult }
  | { kind: "nothing_to_send"; reason: string };

interface ThreadFacts {
  id: string;
  messageId: string;
  channel: string | null;
  subjectType: string;
  orderId: string | null;
  customerId: string | null;
  /** The last line the buyer read (`conversations.customer_read_seq`): reading or answering moves it. */
  customerReadSeq: number;
  seq: number;
  kind: string;
  visibility: string;
  authorType: string;
  body: string | null;
  eventKind: string | null;
  eventData: string | null;
}

async function readThreadLine(db: Database, conversationId: string, seq: number): Promise<ThreadFacts | undefined> {
  return await db
    .select({
      id: conversations.id,
      messageId: conversationMessages.id,
      channel: conversations.channel,
      subjectType: conversations.subjectType,
      orderId: conversations.orderId,
      customerId: conversations.customerId,
      customerReadSeq: conversations.customerReadSeq,
      seq: conversationMessages.seq,
      kind: conversationMessages.kind,
      visibility: conversationMessages.visibility,
      authorType: conversationMessages.authorType,
      body: conversationMessages.body,
      eventKind: conversationMessages.eventKind,
      eventData: conversationMessages.eventData,
    })
    .from(conversationMessages)
    .innerJoin(conversations, eq(conversations.id, conversationMessages.conversationId))
    .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.seq, seq)))
    .get();
}

function replyProducts(thread: ThreadFacts) {
  if (thread.kind !== "event" || thread.eventKind !== "product_reply" || thread.visibility !== "public" || thread.authorType !== "staff") return [];
  try { return conversationProductSnapshots(JSON.parse(thread.eventData ?? "null")); }
  catch { return []; }
}

/** Notification display only; a card-only message keeps its stored body null. */
function displayBody(thread: ThreadFacts, language: MessageLanguage): string | null {
  const cards = replyProducts(thread);
  if (!cards.length) return thread.body;
  const titles = cards.map((card) => `${card.title}${card.variantLabel ? ` (${card.variantLabel})` : ""}`).join("\n");
  return [thread.body?.trim(), `${MESSAGE_COPY[language].conversation.sharedProducts(cards.length)}\n${titles}`].filter(Boolean).join("\n\n");
}

interface ThreadParty {
  /** The buyer's name, or null when none is known. */
  name: string | null;
  email: string | null;
  phone: string | null;
  orderNumber: string | null;
  /** The buyer reads this thread in their account (verified owner or store thread). */
  inAccount: boolean;
  orderNumberRaw: number | null;
  /** The storefront presence of the thread's order (`bn`): the buyer's language and links. Null otherwise. */
  presence: string | null;
}

/**
 * The buyer side of a thread: the order's own contact for every thread about
 * an order (its order thread, a warranty claim, a review), else the account's
 * verified contacts (a store thread).
 */
async function readThreadParty(db: Database, thread: ThreadFacts): Promise<ThreadParty | null> {
  if (thread.orderId) {
    const order = await db
      .select({
        id: orders.id,
        name: orders.customerName,
        email: orders.customerEmail,
        phone: orders.customerPhone,
        orderNumber: orders.orderNumber,
        owner: orders.accountOwnerCustomerId,
        presence: orders.presence,
      })
      .from(orders)
      .where(eq(orders.id, thread.orderId))
      .get();
    if (!order) return null;
    return {
      name: order.name?.trim() || null,
      email: order.email?.trim() || null,
      phone: order.phone?.trim() || null,
      orderNumber: formatOrderNumber(order.orderNumber, order.id),
      orderNumberRaw: order.orderNumber,
      inAccount: Boolean(order.owner),
      presence: order.presence ?? null,
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
      name: customer.name?.trim() || null,
      email: customer.emailVerifiedAt ? customer.email?.trim() || null : null,
      phone: customer.phoneVerifiedAt ? customer.phone?.trim() || null : null,
      orderNumber: null,
      orderNumberRaw: null,
      inAccount: true,
      presence: null,
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
  const url = typeof storefrontUrl === "string" ? storefrontUrl : undefined;
  // In the presence the thread's order was placed on (`/bn/...`), as the message's language.
  if (party.inAccount) return buyerStorefrontLink(url, party.presence, `/account/inbox/${encodeURIComponent(thread.id)}`);
  return buyerStorefrontLink(url, party.presence, `/track-order?order=${encodeURIComponent(String(party.orderNumberRaw ?? thread.orderId ?? ""))}`);
}

const BUTTON = "display:inline-block;padding:12px 20px;background:#202124;color:#ffffff;text-decoration:none;border-radius:4px;";

/** The short branded staff email about a buyer's message (never its text). Every value is escaped. */
export function renderConversationEmail(input: {
  language: MessageLanguage;
  store: EmailStore;
  subject: string;
  intro: string;
  action: { label: string; href: string } | null;
  footer: string | null;
}): { subject: string; html: string; text: string } {
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
  const action = input.action
    ? `<p style="margin:0 0 24px;"><a href="${escapeHtml(input.action.href)}" style="${BUTTON}">${escapeHtml(input.action.label)}</a></p>`
    : "";
  const footer = input.footer ? `<p style="margin:0;color:#5f6368;font-size:14px;">${escapeHtml(input.footer)}</p>` : "";
  const html = `<!doctype html><html lang="${input.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#ffffff;">
<div role="main" style="max-width:560px;margin:0 auto;padding:24px 20px;overflow-wrap:anywhere;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
${storeHeaderHtml(input.store)}
<p style="margin:0 0 16px;">${escapeHtml(input.intro)}</p>
${action}${footer}
</div></body></html>`;
  const text = [
    input.store.name,
    input.intro,
    input.action ? `${input.action.label}: ${input.action.href}` : null,
    input.footer,
  ].filter(Boolean).join("\n\n");
  return { subject, html, text };
}

/**
 * The receipt scope of a reply alert: one per thread, channel, buyer read
 * position and window, so replies the buyer has not read yet share one
 * delivery (the first sends, the rest find it taken) and the next reply after
 * they read or answer, or in a later window, sends again. The recipient is in
 * the receipt key, so a corrected address is never held back by the old one.
 */
function replyReceiptScope(thread: ThreadFacts, channel: "email" | "sms", windowSeconds: number): string {
  return `conversation_reply:${thread.id}:r${thread.customerReadSeq}:w${Math.floor(Date.now() / 1000 / windowSeconds)}:${channel}`;
}

export async function sendConversationNotification(
  db: Database,
  claim: ConversationNotificationClaim,
  options: ConversationNotificationOptions,
): Promise<ConversationNotificationResult> {
  if (!Number.isInteger(claim.seq) || claim.seq < 1) return { kind: "nothing_to_send", reason: "missing_seq" };
  const thread = await readThreadLine(db, claim.conversationId, claim.seq);
  if (!thread) return { kind: "nothing_to_send", reason: "message_missing" };
  if (thread.visibility !== "public" || (thread.kind !== "message" && !replyProducts(thread).length)) {
    return { kind: "nothing_to_send", reason: "not_a_public_message" };
  }
  const buyerLine = thread.authorType === "customer" || thread.authorType === "guest_receipt";
  if (claim.notificationType === "conversation_reply") {
    if (thread.authorType !== "staff") return { kind: "nothing_to_send", reason: "not_a_staff_reply" };
    if (thread.channel) return { kind: "dispatched", result: await sendReplyOnChannel(db, thread, options) };
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
  // The buyer's language: the presence of the thread's order, else the store's.
  const { language, locale } = buyerMessageScope(store, party?.presence);
  const { templates } = await getNotificationTemplates(db, language, { locale });
  // No message text: only who replied, the order and where to read it.
  const variables: NotificationVariableValues = {
    customer_name: party?.name ?? "",
    store_name: store.name ?? "",
    // The order number in the buyer's digits, as the storefront writes it.
    order_number: party?.orderNumber ? orderNumberTextIn(party.orderNumber, numberLocale(language)) : "",
    conversation_link: (party ? buyerThreadLink(options.env.STOREFRONT_URL, thread, party) : null) ?? "",
  };
  const emailContext: EmailRuntimeContext = { db, env: options.env as unknown as Record<string, unknown>, encryptionKey: options.encryptionKey, appProviders: options.appProviders };

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
      const target = { ...base, channel: "email" as const, provider: "email", recipient: email, recipientMasked: maskEmail(email), receiptScope: replyReceiptScope(thread, "email", CONVERSATION_EMAIL_COALESCE_SECONDS) };
      const blocked = await recordProviderBlockedDeliveryIfNeeded(target);
      outcomes.push(blocked ?? await dispatchWithReceipt({
        ...target,
        send: async (delivery) => {
          const rendered = renderMessageEmail({
            language,
            store,
            ...renderEmailTemplate("conversation_reply", language, templates.email.conversation_reply, variables),
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
    outcomes.push(await sendReplySms(db, base, thread, party, renderSmsTemplate("conversation_reply", language, templates.sms.conversation_reply.body, variables), options));
  }

  return buildDispatchResult(outcomes);
}

/** How long one channel send may take before its outcome counts as unknown. */
const CHANNEL_SEND_TIMEOUT_MS = 15_000;

/**
 * A staff reply in a chat-channel thread, as text through the thread's
 * messaging provider. Sent once: only a `pending` outbound row is sent, the
 * message id is the provider's idempotency key, and a send that may have
 * gone (an uncertain failure) is repeated only by a provider that dedupes on
 * that key; otherwise the line ends `failed` for staff to resend.
 */
async function sendReplyOnChannel(db: Database, thread: ThreadFacts, options: ConversationNotificationOptions): Promise<OrderNotificationDispatchResult> {
  const row = await db
    .select({ status: conversationChannelMessages.status, providerId: conversationChannelMessages.providerId, to: conversationChannelContacts.contactKey })
    .from(conversationChannelMessages)
    .innerJoin(conversationChannelContacts, eq(conversationChannelContacts.conversationId, conversationChannelMessages.conversationId))
    .where(and(eq(conversationChannelMessages.messageId, thread.messageId), eq(conversationChannelMessages.direction, "outbound")))
    .get();
  if (!row || row.status !== "pending") return buildDispatchResult([]);
  const pending = and(eq(conversationChannelMessages.messageId, thread.messageId), eq(conversationChannelMessages.status, "pending"));
  const outcome = (status: OrderNotificationChannelOutcome["status"], retryable: boolean, error?: string): OrderNotificationChannelOutcome => ({
    channel: "whatsapp",
    provider: `${thread.channel}:${row.providerId}`,
    recipientMasked: maskPhone(row.to),
    status,
    retryable,
    ...(error ? { error } : {}),
  });
  const fail = async (failure: string) => {
    await db.update(conversationChannelMessages).set({ status: "failed", failure, updatedAt: Math.floor(Date.now() / 1000) }).where(pending);
    return buildDispatchResult([outcome("skipped", false, failure)]);
  };

  const choice = await resolveAppProvider(options.appProviders, "messaging", row.providerId);
  if (!choice.provider) return fail("The messaging app that carries this chat is not available. Set it up, then send the reply again.");
  const provider = choice.provider;
  const language = (await readStoreIdentity(db)).language;
  const text = (displayBody(thread, language) ?? "").slice(0, 4096);
  if (!text) return fail("The reply has no text to send.");
  try {
    const answer = messagingSendSchema.safeParse(await provider.send({
      channel: thread.channel as MessagingChannel,
      to: row.to,
      text,
      idempotencyKey: thread.messageId,
    }, { signal: AbortSignal.timeout(CHANNEL_SEND_TIMEOUT_MS) }));
    if (!answer.success) throw new Error("The messaging app answered outside the port.");
    if (answer.data.success) {
      const now = Math.floor(Date.now() / 1000);
      try {
        await db.update(conversationChannelMessages)
          .set({ status: "sent", providerMessageId: answer.data.providerRef ?? null, updatedAt: now }).where(pending);
      } catch {
        // A reference another line already holds: the reply went, its receipts cannot be matched.
        await db.update(conversationChannelMessages).set({ status: "sent", updatedAt: now }).where(pending);
      }
      return buildDispatchResult([outcome("accepted", false)]);
    }
    if (answer.data.retryable === false) return fail("The channel refused the reply.");
    return buildDispatchResult([outcome("failed", true, "channel_send_failed")]);
  } catch (error: unknown) {
    const failure = providerErrorOf(error);
    const mayHaveGone = !failure || failure.uncertain === true;
    if (failure?.category === "retryable" && (!mayHaveGone || provider.dedupesOnIdempotencyKey === true)) {
      return buildDispatchResult([outcome("failed", true, failure.code ?? "channel_send_failed")]);
    }
    console.warn(JSON.stringify({ event: "conversation_channel_reply_failed", conversationId: thread.id, messageId: thread.messageId, code: failure?.code ?? "provider_call_failed" }));
    return fail(failure?.category === "retryable"
      ? "The channel may not have delivered this reply. Check with the buyer before sending it again."
      : "The channel refused the reply.");
  }
}

async function sendReplySms(
  db: Database,
  base: DeliveryReceiptSubject & { db: Database; outboxId: string; notificationType: ConversationNotificationClaim["notificationType"] },
  thread: ThreadFacts,
  party: ThreadParty | null,
  /** The rendered `conversation_reply` SMS template (no message text). */
  text: string,
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
  try {
    const { getActiveSmsProvider, getSmsProviderReadiness } = await import("../../integrations/sms");
    const readiness = await getSmsProviderReadiness(db, options.encryptionKey, options.appProviders);
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
    const provider = await getActiveSmsProvider(db, options.encryptionKey, options.appProviders);
    const target = { ...base, channel: "sms" as const, provider: provider?.id ?? providerName, recipient: phone, recipientMasked: maskPhone(phone), receiptScope: replyReceiptScope(thread, "sms", CONVERSATION_SMS_COALESCE_SECONDS) };
    const blocked = await recordProviderBlockedDeliveryIfNeeded(target);
    if (blocked) return blocked;
    return await dispatchWithReceipt({
      ...target,
      send: async (delivery) => {
        if (!provider) {
          return { success: false, provider: "sms", providerStatus: "missing_sms_provider", rawResponse: "No active SMS provider configured", retryable: false };
        }
        // The receipt's reference keys the provider's idempotency, as for every other SMS.
        const result = await provider.send({
          to: phone,
          text,
          idempotencyKey: createProviderClientReference(delivery),
        }, {});
        return {
          success: result.success,
          provider: provider.id,
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
    channels = (await getAdminNotificationChannels(db)).conversation_message ?? channels;
  } catch (error: unknown) {
    console.warn("[Notifications] Failed to read staff message channels, defaulting to push:", compactProviderLogDetail(error));
  }
  if (channels.length === 0) return buildDispatchResult(outcomes);
  await recordStaffAlert(db, { outboxId: claim.outboxId, kind: claim.notificationType }, true);

  const [party, store] = await Promise.all([readThreadParty(db, thread), readStoreIdentity(db)]);
  const copy = MESSAGE_COPY[store.language].conversation;
  const order = party?.orderNumber ? orderNumberTextIn(party.orderNumber, numberLocale(store.language)) : null;
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
    const emailContext: EmailRuntimeContext = { db, env: options.env as unknown as Record<string, unknown>, encryptionKey: options.encryptionKey, appProviders: options.appProviders };
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
