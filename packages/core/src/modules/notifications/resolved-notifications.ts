// Messages a domain resolves at send time (Wave B §10). The outbox row carries
// ids only; the API layer's `notification-content/*` resolvers read the
// domain (digital, gift cards, reviews) when the message is sent and hand the
// variables in here as `extraTemplateData`. Nothing resolved is persisted:
// not in the outbox payload, not in a delivery receipt, not in a log. So this
// domain never imports digital, gift-cards or reviews.
//
//   order_digital_delivered / gift_card_issued / review_request: the buyer (or
//     the gift card's recipient), by email and SMS, from the merchant's
//     templates. Code-bearing messages scrub their resolved values from every
//     recorded provider status and keep no raw provider response.
//   review_pending / digital_keys_exhausted: staff push and staff email, with
//     no buyer content.
//   A resolver that finds nothing to send ends the row as sent with one
//   skipped "nothing_to_send" receipt: terminal, never retried or dead-lettered.

import type { Database } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { isReady } from "@scalius/shared/readiness";
import { eq } from "drizzle-orm";
import { sendEmail, type EmailRuntimeContext } from "../../integrations/email";
import {
  DEFAULT_ADMIN_NOTIFICATION_CHANNELS,
  DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS,
  notificationsDocument,
} from "../settings/documents";
import { MESSAGE_COPY } from "./message-copy";
import {
  renderEmailTemplate,
  renderMessageEmail,
  renderSmsTemplate,
  type NotificationVariableValues,
} from "./notification-templates";
import { getNotificationTemplates } from "./notification-templates.service";
import {
  isCodeBearingNotificationType,
  type ResolvedNotificationType,
  type StaffAlertNotificationType,
} from "./notification-types";
import {
  NOTIFICATION_TURNED_OFF,
  buildDispatchResult,
  compactProviderLogDetail,
  dispatchWithReceipt,
  emailResultToDeliveryResult,
  maskEmail,
  maskPhone,
  normalizeError,
  recordProviderBlockedDeliveryIfNeeded,
  recordSkippedDelivery,
  redactSecrets,
  resolveDashboardOrderLink,
  sendAdminPush,
  type DeliveryReceiptSubject,
  type OrderNotificationChannelOutcome,
  type OrderNotificationDispatchResult,
} from "./notifications.service";
import { createProviderClientReference } from "./order-notification-delivery-receipts";
import { readStoreIdentity } from "./store-messages";

/** The skipped-receipt reason when a resolver found nothing to send. */
export const NOTHING_TO_SEND = "nothing_to_send";

/** A delivery target only: a recipient contact never becomes identity. */
export interface ResolvedNotificationRecipient {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * String variables resolved at send time by the API layer (codes, keys, file
 * names, links). Never persisted into outbox payloads or delivery receipts.
 */
export type NotificationExtraTemplateData = NotificationVariableValues;

export interface ResolvedNotificationSend {
  outboxId: string;
  notificationType: ResolvedNotificationType;
  subjectType: "order" | "gift_card";
  subjectId: string;
  /** The order the message is about, when there is one. */
  orderId: string | null;
  /** The formatted order number ("#1057"), when there is an order. */
  orderNumber: string | null;
  recipient: ResolvedNotificationRecipient;
  extraTemplateData: NotificationExtraTemplateData;
}

export interface ResolvedNotificationOptions {
  env: Env;
  /** Must be the dedicated CREDENTIAL_ENCRYPTION_KEY. */
  encryptionKey?: string;
}

function receiptSubject(input: Pick<ResolvedNotificationSend, "subjectType" | "subjectId" | "orderId">): DeliveryReceiptSubject {
  return input.subjectType === "order"
    ? { subjectType: "order", subjectId: input.subjectId, orderId: input.subjectId }
    : { subjectType: input.subjectType, subjectId: input.subjectId, orderId: input.orderId };
}

/**
 * Records a resolver's "nothing to send" as one skipped receipt, so the order
 * log says "Not sent" instead of "Sent". The caller then marks the row sent.
 */
export async function recordNothingToSend(
  db: Database,
  input: {
    outboxId: string;
    notificationType: ResolvedNotificationType;
    subjectType: "order" | "gift_card";
    subjectId: string;
    orderId: string | null;
  },
): Promise<OrderNotificationChannelOutcome> {
  return await recordSkippedDelivery({
    db,
    outboxId: input.outboxId,
    ...receiptSubject(input),
    notificationType: input.notificationType,
    channel: "email",
    provider: "email",
    recipient: `nothing-to-send:${input.subjectId}`,
    recipientMasked: "nothing-to-send",
    reason: NOTHING_TO_SEND,
  });
}

/** The buyer message for one resolved notification, by the channels the merchant chose. */
export async function sendResolvedNotification(
  db: Database,
  input: ResolvedNotificationSend,
  options: ResolvedNotificationOptions,
): Promise<OrderNotificationDispatchResult> {
  const type = input.notificationType;
  const outcomes: OrderNotificationChannelOutcome[] = [];
  const base = { db, outboxId: input.outboxId, notificationType: type, ...receiptSubject(input) };

  let channels = DEFAULT_CUSTOMER_NOTIFICATION_CHANNELS[type] ?? ["email"];
  try {
    const { getNotificationChannels } = await import("../settings/settings.service");
    channels = (await getNotificationChannels(db))[type] ?? channels;
  } catch (error: unknown) {
    console.warn(`[Notifications] Failed to read ${type} channels, using the defaults:`, compactProviderLogDetail(error));
  }
  if (!channels.includes("email") && !channels.includes("sms")) {
    outcomes.push(await recordSkippedDelivery({
      ...base,
      channel: "email",
      provider: "email",
      recipient: `${input.subjectType}:${input.subjectId}:off`,
      recipientMasked: "turned-off",
      reason: NOTIFICATION_TURNED_OFF,
    }));
    return buildDispatchResult(outcomes);
  }

  const store = await readStoreIdentity(db);
  const { templates } = await getNotificationTemplates(db, store.language);
  const variables: NotificationVariableValues = {
    customer_name: input.recipient.name?.trim() ?? "",
    store_name: store.name ?? "",
    order_number: input.orderNumber ?? "",
    ...input.extraTemplateData,
  };
  const redact = isCodeBearingNotificationType(type)
    ? Object.values(input.extraTemplateData).filter((value): value is string => typeof value === "string" && value.length > 0)
    : undefined;
  const emailContext: EmailRuntimeContext = {
    db,
    env: options.env as unknown as Record<string, unknown>,
    encryptionKey: options.encryptionKey,
  };

  if (channels.includes("email")) {
    const email = input.recipient.email?.trim() || null;
    if (!email) {
      outcomes.push(await recordSkippedDelivery({
        ...base,
        channel: "email",
        provider: "email",
        recipient: `missing-email:${input.subjectId}`,
        recipientMasked: "missing-email",
        reason: "missing_email_recipient",
      }));
    } else {
      const target = { ...base, channel: "email" as const, provider: "email", recipient: email, recipientMasked: maskEmail(email) };
      const blocked = await recordProviderBlockedDeliveryIfNeeded(target);
      outcomes.push(blocked ?? await dispatchWithReceipt({
        ...target,
        redact,
        send: async (delivery) => {
          const rendered = renderMessageEmail({
            language: store.language,
            store,
            ...renderEmailTemplate(type, store.language, templates.email[type], variables),
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
    const body = renderSmsTemplate(type, store.language, templates.sms[type].body, variables);
    outcomes.push(await sendResolvedSms(db, base, input, body, redact, options));
  }

  return buildDispatchResult(outcomes);
}

async function sendResolvedSms(
  db: Database,
  base: DeliveryReceiptSubject & { db: Database; outboxId: string; notificationType: ResolvedNotificationType },
  input: ResolvedNotificationSend,
  message: string,
  redact: readonly string[] | undefined,
  options: ResolvedNotificationOptions,
): Promise<OrderNotificationChannelOutcome> {
  const phone = input.recipient.phone?.trim() || null;
  if (!phone) {
    return recordSkippedDelivery({
      ...base,
      channel: "sms",
      provider: "sms",
      recipient: `missing-phone:${input.subjectId}`,
      recipientMasked: "missing-phone",
      reason: "missing_sms_recipient",
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
        recipient: `sms-setup:${input.subjectId}:${input.notificationType}`,
        recipientMasked: "sms-setup",
        reason: readiness.issues[0]?.message ?? "SMS provider is not configured",
      });
    }
    const provider = await getActiveSmsProvider(db, options.encryptionKey);
    const target = {
      ...base,
      channel: "sms" as const,
      provider: provider?.name ?? providerName,
      recipient: phone,
      recipientMasked: maskPhone(phone),
    };
    const blocked = await recordProviderBlockedDeliveryIfNeeded(target);
    if (blocked) return blocked;
    return await dispatchWithReceipt({
      ...target,
      redact,
      send: async (delivery) => {
        if (!provider) {
          return { success: false, provider: "sms", providerStatus: "missing_sms_provider", rawResponse: "No active SMS provider configured", retryable: false };
        }
        const result = await provider.sendSms({
          to: phone,
          message,
          clientReference: createProviderClientReference(delivery),
        });
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
    const detail = redact ? redactSecrets(normalizeError(error), redact) : normalizeError(error);
    // Ids and a masked provider detail only.
    console.error(`[Notifications] ${input.notificationType} SMS failed for ${input.subjectType} ${input.subjectId}: ${compactProviderLogDetail(detail)}`);
    return {
      channel: "sms",
      provider: "sms",
      recipientMasked: maskPhone(phone),
      status: "failed",
      error: compactProviderLogDetail(detail),
      retryable: true,
    };
  }
}

/** A staff alert about an order: push to staff devices and email to the staff recipients. */
export async function sendStaffAlertNotification(
  db: Database,
  input: { outboxId: string; orderId: string; notificationType: StaffAlertNotificationType },
  options: ResolvedNotificationOptions,
): Promise<OrderNotificationDispatchResult> {
  const type = input.notificationType;
  const outcomes: OrderNotificationChannelOutcome[] = [];
  const subject: DeliveryReceiptSubject = { orderId: input.orderId };

  let channels = DEFAULT_ADMIN_NOTIFICATION_CHANNELS[type] ?? ["push"];
  try {
    const { getAdminNotificationChannels } = await import("../settings/settings.service");
    channels = (await getAdminNotificationChannels(db))[type] ?? channels;
  } catch (error: unknown) {
    console.warn(`[Notifications] Failed to read ${type} staff channels, using the defaults:`, compactProviderLogDetail(error));
  }
  if (channels.length === 0) return buildDispatchResult(outcomes);

  const [order, store] = await Promise.all([
    db.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, input.orderId)).get(),
    readStoreIdentity(db),
  ]);
  const orderNumber = formatOrderNumber(order?.orderNumber ?? null, input.orderId);
  const copy = MESSAGE_COPY[store.language].staffAlert;
  const alert = copy[type];
  const link = resolveDashboardOrderLink(options.env, input.orderId);

  if (channels.includes("push")) {
    const push = await sendAdminPush(db, options.env, {
      outboxId: input.outboxId,
      receipt: { ...subject, notificationType: type },
      setupRecipient: `firebase-setup:${input.orderId}:${type}`,
      logLabel: `order ${input.orderId}`,
      title: alert.title,
      body: alert.body(orderNumber),
      link,
      data: { orderId: input.orderId, notificationType: type },
    });
    outcomes.push(...push.outcomes);
  }

  if (channels.includes("email")) {
    const recipients = (await notificationsDocument.read(db)).staffEmailRecipients;
    const emailContext: EmailRuntimeContext = {
      db,
      env: options.env as unknown as Record<string, unknown>,
      encryptionKey: options.encryptionKey,
    };
    for (const recipient of recipients) {
      const target = {
        db,
        outboxId: input.outboxId,
        notificationType: type,
        ...subject,
        channel: "email" as const,
        provider: "email",
        // Distinct from a customer who uses the same address.
        recipient: `staff:${recipient}`,
        recipientMasked: `staff ${maskEmail(recipient)}`,
      };
      const blocked = await recordProviderBlockedDeliveryIfNeeded(target);
      outcomes.push(blocked ?? await dispatchWithReceipt({
        ...target,
        send: async (delivery) => emailResultToDeliveryResult(await sendEmail({
          ...renderMessageEmail({
            language: store.language,
            store,
            subject: copy.emailSubject(store.name, alert.title),
            body: alert.body(orderNumber),
            action: link ? { label: copy.action, href: link } : null,
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
