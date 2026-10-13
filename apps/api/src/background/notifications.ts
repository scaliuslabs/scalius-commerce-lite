// Notification delivery (Wave A §10): claims one `notification_outbox` row
// and resolves recipients and message text at send time, so no contact or
// body is ever stored with the row. A committed row is sent right after the
// write that recorded it (`notificationSender`); the scheduled drain sends
// every row still due (failed rows back off in `next_attempt_at`; after 8
// attempts a row is `dead_lettered`, which the order page shows).

import type { getDb } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import {
  claimNotificationOutboxForProcessing,
  listDueNotificationOutbox,
  markNotificationOutboxDeadLettered,
  markNotificationOutboxProcessingFailed,
  markNotificationOutboxSent,
  recordNothingToSend,
  sendConversationNotification,
  sendOrderNotification,
  sendOrderNotificationEmail,
  sendResolvedNotification,
  sendStaffAlertNotification,
  sendStaffOrderEmails,
  type ClaimedNotificationOutbox,
} from "@scalius/core/modules/notifications";
import {
  isOrderNotificationType,
  isStaffAlertNotificationType,
  type OrderNotificationType,
  type ResolvedNotificationType,
} from "@scalius/core/modules/notifications/browser";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { planLimits } from "@scalius/shared/plan-limits";
import { resolveDigitalDeliveryContent } from "../notification-content/digital";
import { resolveGiftCardIssuedContent, resolveGiftCardSentContent } from "../notification-content/gift-card";
import { resolveReviewRequestContent } from "../notification-content/review-request";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { detachedAppProviders } from "../plugins/providers/app-providers";
import { sendMarketingOptInEmail } from "@scalius/core/modules/customer-marketing";
import { logOpsEvent } from "../utils/ops-log";

type Db = ReturnType<typeof getDb>;

type DispatchOutcome = { channel: string; provider: string; error?: string; providerStatus?: string | null; retryable: boolean };

/**
 * What a notification send needs besides its content: the env, the
 * credential key, and the app providers a saved SMS or email choice may name
 * (on a detached context: background work has no request). Nothing is read until
 * a send needs it.
 */
function messagingRuntime(db: Db, env: Env) {
  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  return { env, encryptionKey, appProviders: detachedAppProviders(env, db, encryptionKey) };
}

/** Dispatches one order notification to buyer channels, staff push and staff email. Returns retryable failures. */
async function dispatchOrderNotification(
  db: Db,
  env: Env,
  input: {
    outboxId?: string;
    orderId: string;
    customerEmail?: string | null;
    customerName: string;
    notificationType: OrderNotificationType;
    data?: Record<string, unknown>;
  },
): Promise<string[]> {
  const { encryptionKey, appProviders } = messagingRuntime(db, env);
  const customerNotificationResult = await sendOrderNotificationEmail(
    input.customerEmail,
    input.customerName,
    input.orderId,
    input.notificationType,
    input.data,
    db,
    {
      encryptionKey,
      env: env as unknown as Record<string, unknown>,
      outboxId: input.outboxId,
      appProviders,
    },
  );
  const retryableFailures: string[] = customerNotificationResult?.hasRetryableFailure
    ? [`customer channels: ${summarizeNotificationFailures(customerNotificationResult.outcomes)}`]
    : [];

  // Admin push notification — check admin channel settings before sending
  try {
    const { getAdminNotificationChannels } = await import("@scalius/core/modules/notifications");
    const adminChannels = await getAdminNotificationChannels(db);
    const enabledAdminChannels = adminChannels[input.notificationType] || [];

    if (enabledAdminChannels.includes("push")) {
      // Push payloads deep-link into the dashboard through the public
      // API origin. Background work has no request URL, so the origin
      // must come from Platform settings; never invent a domain.
      const requestUrl = env.PUBLIC_API_BASE_URL;
      if (!requestUrl) {
        logOpsEvent("warn", "notification.order.admin_push_skipped", {
          orderId: input.orderId,
          notificationType: input.notificationType,
          outboxId: input.outboxId,
          reason: "platform apiUrl is not configured (Settings -> System -> Platform)",
        });
      } else {
        const adminPushResult = await sendOrderNotification(db, {
          id: input.orderId,
          customerName: input.customerName,
          notificationType: input.notificationType,
        }, env, requestUrl, {
          outboxId: input.outboxId,
        });
        if (adminPushResult?.hasRetryableFailure) {
          retryableFailures.push(`admin push: ${summarizeNotificationFailures(adminPushResult.outcomes)}`);
        }
      }
    }
  } catch (fcmError) {
    console.error(`[notifications] Admin notification check/send failed for ${input.orderId}:`, fcmError);
    retryableFailures.push(`admin push: ${fcmError instanceof Error ? fcmError.message : String(fcmError)}`);
  }

  // Staff order emails (new orders only); receipts keep retries from resending.
  try {
    const staffEmailResult = await sendStaffOrderEmails(db, {
      id: input.orderId,
      customerName: input.customerName,
      notificationType: input.notificationType,
    }, {
      encryptionKey,
      env: env as unknown as Record<string, unknown>,
      outboxId: input.outboxId,
      appProviders,
    });
    if (staffEmailResult.hasRetryableFailure) {
      retryableFailures.push(`staff email: ${summarizeNotificationFailures(staffEmailResult.outcomes)}`);
    }
  } catch (staffEmailError) {
    console.error(`[notifications] Staff order email failed for ${input.orderId}:`, staffEmailError instanceof Error ? staffEmailError.message : "unknown error");
    retryableFailures.push("staff email: settings or order read failed");
  }

  return retryableFailures;
}

/**
 * Sends one outbox row. A delivery failure marks the row failed with backoff:
 * the row is the retry authority, and the scheduled drain sends it again.
 */
export async function deliverNotification(
  outboxId: string,
  db: Db,
  env: Env,
): Promise<void> {
  const claim = await claimNotificationOutboxForProcessing(db, outboxId);
  if (!claim.claimed) {
    console.log(`[notifications] Skipped outbox ${outboxId}: ${claim.reason}`);
    return;
  }

  try {
    const outcome = await dispatchClaimedNotification(claim, db, env);
    if (outcome.kind === "retry") {
      throw new Error(`Notification delivery failed for outbox ${claim.outboxId}: ${outcome.failures.join("; ")}`);
    }
    if (outcome.kind === "unsupported") {
      await markNotificationOutboxDeadLettered({ db, outboxId: claim.outboxId, error: outcome.reason });
      return;
    }
    await markNotificationOutboxSent(db, claim.outboxId, claim.claimId);
  } catch (error) {
    await markNotificationOutboxProcessingFailed(db, claim.outboxId, claim.claimId, claim.attempts, error)
      .catch((markError: unknown) => {
        console.error(`[notifications] Failed to mark notification outbox ${claim.outboxId} failure:`, markError instanceof Error ? markError.message : "unknown error");
      });
  }
}

type DispatchResult =
  | { kind: "done" }
  | { kind: "retry"; failures: string[] }
  | { kind: "unsupported"; reason: string };

function fromDispatch(result: { outcomes: DispatchOutcome[]; hasRetryableFailure: boolean }): DispatchResult {
  return result.hasRetryableFailure
    ? { kind: "retry", failures: [summarizeNotificationFailures(result.outcomes)] }
    : { kind: "done" };
}

/**
 * A resolver found nothing to send (Wave B §10): one skipped
 * `nothing_to_send` receipt, then the row is marked sent. Terminal: never
 * retried, never dead-lettered. Ids only in the log.
 */
async function nothingToSend(
  db: Db,
  claim: ClaimedNotificationOutbox & { notificationType: ResolvedNotificationType },
  orderId: string | null,
): Promise<DispatchResult> {
  await recordNothingToSend(db, {
    outboxId: claim.outboxId,
    notificationType: claim.notificationType,
    subjectType: claim.subjectType === "gift_card" ? "gift_card" : "order",
    subjectId: claim.subjectId,
    orderId,
  });
  console.log(`[notifications] Notification ${claim.outboxId} (${claim.notificationType}) had nothing to send`);
  return { kind: "done" };
}

/** Digital delivery and review requests: the domain's content, to the order's own contact. */
async function dispatchResolvedOrderNotification(
  claim: ClaimedNotificationOutbox & { notificationType: "order_digital_delivered" | "review_request" },
  db: Db,
  env: Env,
): Promise<DispatchResult> {
  const order = await db
    .select({
      customerName: orders.customerName,
      customerEmail: orders.customerEmail,
      customerPhone: orders.customerPhone,
      orderNumber: orders.orderNumber,
    })
    .from(orders)
    .where(eq(orders.id, claim.subjectId))
    .get();
  if (!order) return { kind: "unsupported", reason: "order_missing" };

  const input = { orderId: claim.subjectId, data: claim.data };
  const extraTemplateData = claim.notificationType === "order_digital_delivered"
    ? await resolveDigitalDeliveryContent(db, env, input)
    : await resolveReviewRequestContent(db, env, input);
  if (!extraTemplateData) return nothingToSend(db, claim, claim.subjectId);

  return fromDispatch(await sendResolvedNotification(db, {
    outboxId: claim.outboxId,
    notificationType: claim.notificationType,
    subjectType: "order",
    subjectId: claim.subjectId,
    orderId: claim.subjectId,
    orderNumber: formatOrderNumber(order.orderNumber, claim.subjectId),
    recipient: { name: order.customerName, email: order.customerEmail, phone: order.customerPhone },
    extraTemplateData,
  }, messagingRuntime(db, env)));
}

/** An issued gift card: the domain's content, to the card's delivery contact. */
async function dispatchGiftCardNotification(
  claim: ClaimedNotificationOutbox,
  db: Db,
  env: Env,
): Promise<DispatchResult> {
  const type = claim.notificationType;
  if (type !== "gift_card_issued" && type !== "gift_card_sent") {
    return { kind: "unsupported", reason: `unsupported_notification_type: ${type}` };
  }
  const resolvedClaim = { ...claim, notificationType: type };
  const input = { giftCardId: claim.subjectId, data: claim.data };
  const content = type === "gift_card_issued"
    ? await resolveGiftCardIssuedContent(db, env, input)
    : await resolveGiftCardSentContent(db, env, input);
  if (!content) return nothingToSend(db, resolvedClaim, null);

  return fromDispatch(await sendResolvedNotification(db, {
    outboxId: claim.outboxId,
    notificationType: type,
    subjectType: "gift_card",
    subjectId: claim.subjectId,
    orderId: content.orderId,
    orderNumber: content.orderNumber,
    recipient: content.recipient,
    extraTemplateData: content.extraTemplateData,
  }, messagingRuntime(db, env)));
}

async function dispatchClaimedNotification(
  claim: ClaimedNotificationOutbox,
  db: Db,
  env: Env,
): Promise<DispatchResult> {
  if (claim.subjectType === "gift_card") {
    return dispatchGiftCardNotification(claim, db, env);
  }

  if (claim.subjectType === "order") {
    const type = claim.notificationType;
    if (type === "order_digital_delivered" || type === "review_request") {
      return dispatchResolvedOrderNotification({ ...claim, notificationType: type }, db, env);
    }
    if (isStaffAlertNotificationType(type)) {
      return fromDispatch(await sendStaffAlertNotification(db, {
        outboxId: claim.outboxId,
        orderId: claim.subjectId,
        notificationType: type,
      }, messagingRuntime(db, env)));
    }
    if (!isOrderNotificationType(claim.notificationType)) {
      return { kind: "unsupported", reason: `unsupported_notification_type: ${claim.notificationType}` };
    }
    const order = await db
      .select({ customerEmail: orders.customerEmail, customerName: orders.customerName })
      .from(orders)
      .where(eq(orders.id, claim.subjectId))
      .get();
    if (!order) return { kind: "unsupported", reason: "order_missing" };
    const failures = await dispatchOrderNotification(db, env, {
      outboxId: claim.outboxId,
      orderId: claim.subjectId,
      customerEmail: order.customerEmail,
      customerName: order.customerName || "Customer",
      notificationType: claim.notificationType,
      data: claim.data,
    });
    return failures.length > 0 ? { kind: "retry", failures } : { kind: "done" };
  }

  if (claim.subjectType === "customer") {
    if (claim.notificationType !== "marketing_opt_in") {
      return { kind: "unsupported", reason: `unsupported_notification_type: ${claim.notificationType}` };
    }
    // The double opt-in confirmation: the token is derived here from the
    // row's nonce and SCALIUS_SECRET; it never sits in the outbox or a log.
    return fromDispatch(await sendMarketingOptInEmail(db, {
      outboxId: claim.outboxId,
      customerId: claim.subjectId,
      data: claim.data,
    }, {
      ...messagingRuntime(db, env),
      env: env as never,
      storefrontUrl: env.STOREFRONT_URL,
    }));
  }

  if (claim.subjectType === "conversation") {
    if (claim.notificationType !== "conversation_reply" && claim.notificationType !== "conversation_message") {
      return { kind: "unsupported", reason: `unsupported_notification_type: ${claim.notificationType}` };
    }
    const outcome = await sendConversationNotification(db, {
      outboxId: claim.outboxId,
      conversationId: claim.subjectId,
      notificationType: claim.notificationType,
      seq: Number(claim.data.seq),
    }, messagingRuntime(db, env));
    if (outcome.kind === "nothing_to_send") {
      // Ids only: the line's text never reaches a log.
      console.log(`[notifications] Conversation notification ${claim.outboxId} had nothing to send: ${outcome.reason}`);
      return { kind: "done" };
    }
    return outcome.result.hasRetryableFailure
      ? { kind: "retry", failures: [summarizeNotificationFailures(outcome.result.outcomes)] }
      : { kind: "done" };
  }

  return { kind: "unsupported", reason: `unsupported_notification_subject: ${claim.subjectType}` };
}

/** Sends rows one at a time, at most this plan's `notificationsPerDrain`; the rest stay due. */
export async function sendNotifications(db: Db, env: Env, outboxIds: readonly string[]): Promise<number> {
  const ids = [...new Set(outboxIds)].slice(0, planLimits().background.notificationsPerDrain);
  for (const outboxId of ids) await deliverNotification(outboxId, db, env);
  return ids.length;
}

/** The scheduled drain: every due row, within this plan's limit. */
export async function drainNotificationOutbox(db: Db, env: Env): Promise<{ scanned: number }> {
  const due = await listDueNotificationOutbox(db, planLimits().background.notificationsPerDrain);
  await sendNotifications(db, env, due);
  return { scanned: due.length };
}

export function summarizeNotificationFailures(outcomes: DispatchOutcome[]): string {
  const failures = outcomes
    .filter((outcome) => outcome.retryable)
    .map((outcome) => `${outcome.channel}/${outcome.provider}:${outcome.error ?? outcome.providerStatus ?? "retryable"}`);

  return failures.length > 0 ? failures.join(", ") : "retryable failure";
}
