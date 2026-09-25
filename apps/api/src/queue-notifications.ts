// Notification queue handlers (Wave A §10). The queue message is
// `{ type: "notification", outboxId }`: the consumer claims the outbox row and
// resolves recipients and message text at send time, so no contact or body
// ever travels through the queue. `order.notification` is the pre-Wave-A
// shape, still accepted for messages in flight at deploy.

import type { getDb } from "@scalius/database/client";
import { orders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import {
  claimNotificationOutboxForProcessing,
  claimOrderNotificationOutboxForProcessing,
  markNotificationOutboxDeadLettered,
  markNotificationOutboxProcessingFailed,
  markNotificationOutboxSent,
  markOrderNotificationOutboxDeadLettered,
  markOrderNotificationOutboxProcessingFailed,
  markOrderNotificationOutboxSent,
  sendOrderNotification,
  sendOrderNotificationEmail,
  sendStaffOrderEmails,
  type ClaimedNotificationOutbox,
  type NotificationQueueMessage,
  type OrderNotificationQueueMessage,
} from "@scalius/core/modules/notifications";
import {
  isOrderNotificationType,
  type OrderNotificationType,
} from "@scalius/core/modules/notifications/browser";
import { getCredentialEncryptionKey } from "./utils/encryption-key";
import { logOpsEvent } from "./utils/ops-log";

type Db = ReturnType<typeof getDb>;

type DispatchOutcome = { channel: string; provider: string; error?: string; providerStatus?: string | null; retryable: boolean };

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
  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
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
    },
  );
  const retryableFailures: string[] = customerNotificationResult?.hasRetryableFailure
    ? [`customer channels: ${summarizeNotificationFailures(customerNotificationResult.outcomes)}`]
    : [];

  // Admin push notification — check admin channel settings before sending
  try {
    const { getAdminNotificationChannels } = await import("@scalius/core/modules/settings");
    const adminChannels = await getAdminNotificationChannels(db);
    const enabledAdminChannels = adminChannels[input.notificationType] || [];

    if (enabledAdminChannels.includes("push")) {
      // Push payloads deep-link into the dashboard through the public
      // API origin. Queue invocations have no request URL, so the origin
      // must come from Platform settings; never invent a domain.
      const requestUrl = env.PUBLIC_API_BASE_URL;
      if (!requestUrl) {
        logOpsEvent("warn", "queue.order_notification.admin_push_skipped", {
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
    console.error(`[Queue] Admin notification check/send failed for ${input.orderId}:`, fcmError);
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
    });
    if (staffEmailResult.hasRetryableFailure) {
      retryableFailures.push(`staff email: ${summarizeNotificationFailures(staffEmailResult.outcomes)}`);
    }
  } catch (staffEmailError) {
    console.error(`[Queue] Staff order email failed for ${input.orderId}:`, staffEmailError instanceof Error ? staffEmailError.message : "unknown error");
    retryableFailures.push("staff email: settings or order read failed");
  }

  return retryableFailures;
}

/** Pre-Wave-A `order.notification` messages (in flight at deploy). */
export async function processLegacyOrderNotificationMessage(
  payload: OrderNotificationQueueMessage,
  db: Db,
  env: Env,
): Promise<void> {
  const outboxClaim = payload.outboxId
    ? await claimOrderNotificationOutboxForProcessing(db, payload.outboxId)
    : undefined;

  if (outboxClaim && !outboxClaim.claimed) {
    console.log(`[Queue] Skipped order notification outbox ${payload.outboxId}: ${outboxClaim.reason}`);
    return;
  }

  try {
    const retryableFailures = await dispatchOrderNotification(db, env, {
      outboxId: payload.outboxId,
      orderId: payload.orderId,
      customerEmail: payload.customerEmail,
      customerName: payload.customerName,
      notificationType: payload.notificationType,
      data: payload.data,
    });
    if (retryableFailures.length > 0) {
      throw new Error(`Order notification delivery failed for ${payload.orderId}: ${retryableFailures.join("; ")}`);
    }
    if (outboxClaim?.claimed) {
      await markOrderNotificationOutboxSent(db, outboxClaim.outboxId, outboxClaim.claimId);
    }
  } catch (error) {
    if (outboxClaim?.claimed) {
      await markOrderNotificationOutboxProcessingFailed(
        db,
        outboxClaim.outboxId,
        outboxClaim.claimId,
        outboxClaim.attempts,
        error,
      ).catch((markError: unknown) => {
        console.error("[Queue] Failed to mark order notification outbox failure:", markError);
      });
      return;
    }
    throw error;
  }
}

/**
 * `{ type: "notification", outboxId }`. A delivery failure marks the row
 * failed with backoff and acks the message: the scheduled outbox flush is the
 * durable retry authority.
 */
export async function processNotificationMessage(
  payload: NotificationQueueMessage,
  db: Db,
  env: Env,
): Promise<void> {
  if (typeof payload.outboxId !== "string" || !payload.outboxId) {
    console.warn("[Queue] Ignoring notification message without an outbox id");
    return;
  }
  const claim = await claimNotificationOutboxForProcessing(db, payload.outboxId);
  if (!claim.claimed) {
    console.log(`[Queue] Skipped notification outbox ${payload.outboxId}: ${claim.reason}`);
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
        console.error(`[Queue] Failed to mark notification outbox ${claim.outboxId} failure:`, markError instanceof Error ? markError.message : "unknown error");
      });
  }
}

type DispatchResult =
  | { kind: "done" }
  | { kind: "retry"; failures: string[] }
  | { kind: "unsupported"; reason: string };

async function dispatchClaimedNotification(
  claim: ClaimedNotificationOutbox,
  db: Db,
  env: Env,
): Promise<DispatchResult> {
  if (claim.subjectType === "order") {
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

  return { kind: "unsupported", reason: `unsupported_notification_subject: ${claim.subjectType}` };
}

/** `jobs-dlq`: an exhausted notification message dead-letters its outbox row, never resends. */
export async function archiveNotificationDlqMessage(
  msg: Message<NotificationQueueMessage | OrderNotificationQueueMessage>,
  db: Db,
): Promise<{ status: "outbox_failed" | "outbox_missing" | "legacy_ignored"; outboxId?: string }> {
  const payload = msg.body;
  if (!payload.outboxId) {
    console.warn(`[Queue] Ignoring legacy notification DLQ message ${msg.id}; no durable outbox id was present.`);
    return { status: "legacy_ignored" };
  }

  const mark = payload.type === "notification" ? markNotificationOutboxDeadLettered : markOrderNotificationOutboxDeadLettered;
  const result = await mark({
    db,
    outboxId: payload.outboxId,
    error: `${payload.type === "notification" ? "notification" : "order_notification"}_dlq_terminal: Cloudflare queue message ${msg.id} exhausted after ${msg.attempts} attempts`,
  });

  if (!result.marked) {
    console.warn(`[Queue] Notification DLQ message ${msg.id} referenced missing outbox ${payload.outboxId}`);
    return { status: "outbox_missing", outboxId: payload.outboxId };
  }

  return { status: "outbox_failed", outboxId: payload.outboxId };
}

export function summarizeNotificationFailures(outcomes: DispatchOutcome[]): string {
  const failures = outcomes
    .filter((outcome) => outcome.retryable)
    .map((outcome) => `${outcome.channel}/${outcome.provider}:${outcome.error ?? outcome.providerStatus ?? "retryable"}`);

  return failures.length > 0 ? failures.join(", ") : "retryable failure";
}
