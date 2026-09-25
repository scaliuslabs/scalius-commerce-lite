// src/queue-consumer.ts
// Cloudflare Queue consumer — thin dispatcher for the single `jobs` queue.
// Every producer sends to JOBS_QUEUE; each message is routed by `payload.type`.
//
// Architecture:
//   Webhook handler  →  enqueue message  →  return 200 immediately
//   Queue consumer   →  process message  →  update DB, send notifications
//
// This makes webhooks resilient: Cloudflare retries failed queue messages
// automatically (up to max_retries = 5), then moves them to `jobs-dlq`, whose
// consumer archives each one into its durable D1 row.
//
// Handler locations:
//   payment.event    → core payments process-payment.ts (one type for every gateway)
//   notification     → ./queue-notifications.ts (outbox id only; order.notification is the legacy shape)
//   auth.send_otp    → inline below (WhatsApp + email; SMS providers TBD)
//   media.render_variants → core media renderMissingMediaVariants (delayed after upload)
//   catalog.recommendations.refresh / catalog.projections.rebuild → ./utils/catalog-jobs.ts
//
// TODO: When 5-6 SMS providers are implemented, extract auth.send_otp to
//       src/modules/notifications/otp.handler.ts

import { getDb } from "@scalius/database/client";
import type { CatalogQueueMessage } from "./utils/catalog-jobs";
import {
  customerAuthOtpChallenges,
  orderPaymentRecoveryChallenges,
  orders,
} from "@scalius/database/schema";
import { and, eq } from "drizzle-orm";
import {
  processPaymentConfirmed,
  processPaymentFailed,
  releaseOrderInventory,
} from "@scalius/core/modules/payments";
import {
  processExistingMetaPurchaseOutboxForOrder,
} from "@scalius/core/integrations/meta/purchase-outbox";
import {
  type NotificationQueueMessage,
  type OrderNotificationQueueMessage,
  composeAuthOtpMessage,
  flushPendingNotificationOutbox,
  readStoreIdentity,
  getNotificationProviderBlock,
  isNotificationProviderBreakerFailure,
  markNotificationProviderBlocked,
} from "@scalius/core/modules/notifications";
import type { OrderNotificationType } from "@scalius/core/modules/notifications/browser";
import { sendEmail } from "@scalius/core/integrations/email";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { getActiveSmsProvider } from "@scalius/core/integrations/sms";
import { getWhatsAppCloudApiSettings, sendWhatsAppTemplateMessage } from "@scalius/core/integrations/whatsapp";
import {
  deriveCustomerAuthOtpDeliveryCode,
  claimAuthOtpDeliveryReceipt,
  createAuthOtpDeliveryTarget,
  createAuthOtpProviderClientReference,
  getAuthOtpDeliveryRetryDelaySeconds,
  markAuthOtpDeliveryReceiptAccepted,
  markAuthOtpDeliveryReceiptAcceptedByDeliveryKey,
  markAuthOtpDeliveryReceiptFailed,
  markAuthOtpDeliveryReceiptSkipped,
  markAuthOtpDeliveryReceiptSkippedByDeliveryKey,
  type AuthOtpDeliveryChannel,
  type AuthOtpDeliveryReceiptResult,
} from "@scalius/core/modules/customers";
import {
  archiveNotificationDlqMessage,
  processLegacyOrderNotificationMessage,
  processNotificationMessage,
} from "./queue-notifications";
import {
  enqueueOrderBalancePaidNotificationForOrder,
  enqueueOrderCreatedNotificationForOrder,
} from "./utils/order-notification-queue";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import {
  renderMissingMediaVariants,
  type MediaVariantsQueueMessage,
} from "@scalius/core/modules/media";
import { getCredentialEncryptionKey } from "./utils/encryption-key";
import { bumpCacheGeneration } from "./utils/cache-generation";
import { enqueueOrderAutoFulfil } from "./utils/auto-fulfil-queue";
import { autoFulfilOrder, type OrderAutoFulfilQueueMessage } from "@scalius/core/modules/fulfilment";
import { logOpsEvent } from "./utils/ops-log";
import {
  markWebhookEventFailed,
  markWebhookEventManualReconciliation,
  markWebhookEventProcessed,
  recordPaymentWebhookDlqEvidence,
  buildWebhookEventId,
  type PaymentWebhookDlqEvidence,
} from "./utils/webhook-idempotency";
import type { PaymentEventQueueMessage } from "./routes/payment/payment-events";

type PaymentConfirmationResult = Awaited<ReturnType<typeof processPaymentConfirmed>>;
type PaymentWebhookCompletionStatus = "processed" | "manual_reconciliation";
type ConfirmedPaymentType = "full" | "deposit" | "balance";

class QueueRetryAfterError extends Error {
  readonly delaySeconds: number;

  constructor(message: string, delaySeconds: number) {
    super(message);
    this.name = "QueueRetryAfterError";
    this.delaySeconds = Math.max(5, Math.min(60 * 60, Math.ceil(delaySeconds)));
  }
}

type AuthOtpAcceptedHint = {
  deliveryKey: string;
  channel: AuthOtpDeliveryChannel;
  provider: string;
  providerMessageId?: string | null;
  providerStatus?: string | null;
  rawResponse?: string | null;
  createdAt: number;
};

// Mirrors apps/api/wrangler*.jsonc for the `jobs` queue. Cloudflare delivers
// the first attempt plus max_retries additional attempts before the DLQ.
const JOBS_MAX_RETRIES = 5;
const JOBS_TERMINAL_DELIVERY_ATTEMPT = JOBS_MAX_RETRIES + 1;
const QUEUE_BATCH_CONCURRENCY_LIMIT = 3;
const DLQ_BATCH_CONCURRENCY_LIMIT = 2;
const AUTH_OTP_ACCEPTED_HINT_TTL_SECONDS = 24 * 60 * 60;
const AUTH_OTP_ACCEPTED_HINT_PREFIX = "auth_otp:accepted:";

function assertPaymentConfirmed(
  result: PaymentConfirmationResult,
  gateway: string,
  orderId: string,
): PaymentWebhookCompletionStatus {
  if (!result.success) {
    if (result.retryable === false) {
      console.warn(
        `[Queue] ${gateway} payment confirmation for order ${orderId} requires manual reconciliation: ${result.error ?? "unknown error"}`,
      );
      return "manual_reconciliation";
    }
    throw new Error(`${gateway} payment confirmation failed for order ${orderId}: ${result.error ?? "unknown error"}`);
  }

  return "processed";
}

async function enqueueOrderCreatedAfterPaymentConfirmed(
  db: ReturnType<typeof getDb>,
  env: Env,
  orderId: string,
  gateway: string,
): Promise<void> {
  const result = await enqueueOrderCreatedNotificationForOrder({
    db,
    queue: env.JOBS_QUEUE,
    orderId,
    source: `payment-${gateway}-confirmed`,
    retryOnQueueFailure: true,
  });

  if (!result.enqueued) {
    console.warn(
      `[Queue] order_created notification for confirmed ${gateway} order ${orderId} recorded but not enqueued: ${result.skippedReason}`,
    );
  }
}

async function enqueueOrderNotificationAfterPaymentConfirmed(
  db: ReturnType<typeof getDb>,
  env: Env,
  options: {
    orderId: string;
    gateway: string;
    paymentType: ConfirmedPaymentType;
    amount: number;
  },
): Promise<void> {
  if (options.paymentType !== "balance") {
    await enqueueOrderCreatedAfterPaymentConfirmed(db, env, options.orderId, options.gateway);
    return;
  }

  const result = await enqueueOrderBalancePaidNotificationForOrder({
    db,
    queue: env.JOBS_QUEUE,
    orderId: options.orderId,
    source: `payment-${options.gateway}-balance-paid`,
    amount: options.amount,
    gateway: options.gateway,
    retryOnQueueFailure: true,
  });

  if (!result.enqueued) {
    console.warn(
      `[Queue] payment_balance_paid notification for confirmed ${options.gateway} order ${options.orderId} recorded but not enqueued: ${result.skippedReason}`,
    );
  }
}

function scheduleMetaPurchaseAfterPaymentConfirmed(
  db: ReturnType<typeof getDb>,
  env: Env,
  executionCtx: ExecutionContext | undefined,
  options: {
    orderId: string;
    gateway: string;
  },
): void {
  const task = processExistingMetaPurchaseOutboxForOrder({
    db,
    orderId: options.orderId,
    source: `payment-${options.gateway}-confirmed`,
    storefrontUrl: env.STOREFRONT_URL,
    encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
  }).catch((error: unknown) => {
    console.error(`[Queue] Meta Purchase CAPI side effect failed for confirmed ${options.gateway} order ${options.orderId}:`, error);
  });

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(task);
  }
}

export type PaymentQueueMessage =
  | PaymentEventQueueMessage
  | {
    type: "order.notification";
    outboxId?: string;
    orderId: string;
    customerEmail?: string;
    customerName: string;
    notificationType: OrderNotificationType;
    data?: Record<string, unknown>;
  };

export type AuthOtpQueueMessage =
  | {
    type: "auth.send_otp";
    challengeKey?: string;
    deliveryKey?: string;
    purpose?: string;
    otpExpiresAt?: number;
    method: "email" | "phone";
    allowedMethod: string;
    channel?: "email" | "sms" | "whatsapp";
    /** Legacy pre-reference payloads only. New messages resolve the target from D1. */
    identifier?: string;
    /** Legacy pre-reference payloads only. New messages derive the code from challengeKey + deliveryKey. */
    code?: string;
    /** Legacy pre-reference payloads only. New messages resolve the display name from D1. */
    name?: string;
  };

// ── Queue batch handler ────────────────────────────────────────────────────

/**
 * Handle a batch of queue messages.
 * Each message is processed independently; failures are retried by Cloudflare.
 */
export async function handleQueueBatch(
  batch: MessageBatch<QueueBody>,
  env: Env,
  executionCtx?: ExecutionContext,
): Promise<void> {
  const db = getDb(env);

  if (batch.queue === "jobs-dlq") {
    await handleJobsDlqBatch(batch as unknown as MessageBatch<QueueBody>, db, env);
    return;
  }

  const batchContext = createQueueBatchLogContext(batch, QUEUE_BATCH_CONCURRENCY_LIMIT);
  logQueueBatchStarted(batchContext);
  logQueueBatchConcurrency(batchContext);

  const results = await runSettledWithConcurrency(
    batch.messages,
    QUEUE_BATCH_CONCURRENCY_LIMIT,
    (msg) => processQueueMessage(
      msg as unknown as Message<QueueBody>,
      db,
      env,
      executionCtx,
    ),
  );

  let acked = 0;
  let retried = 0;

  // Ack successful, retry failed with backoff
  for (let i = 0; i < batch.messages.length; i++) {
    const result = results[i];
    const msg = batch.messages[i];
    if (!result || !msg) continue;
    if (result.status === "fulfilled") {
      msg.ack();
      acked += 1;
    } else {
      console.error(`[Queue] Failed to process message ${msg.id}:`, result.status === "rejected" ? result.reason : "unknown");
      await markPaymentWebhookEventFailedOnTerminalAttempt(
        db,
        msg as unknown as Message<QueueBody>,
        result.reason,
      );
      msg.retry({ delaySeconds: getQueueRetryDelaySeconds(result.reason) });
      retried += 1;
    }
  }

  logQueueBatchCompleted(batchContext, acked, retried);
}

/**
 * `jobs-dlq` consumer: a message that exhausted its retries is archived into
 * its durable D1 row by type, never reprocessed. Unknown types are acked.
 */
async function handleJobsDlqBatch(
  batch: MessageBatch<QueueBody>,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<void> {
  const batchContext = createQueueBatchLogContext(batch, DLQ_BATCH_CONCURRENCY_LIMIT);
  logQueueBatchStarted(batchContext);
  logQueueBatchConcurrency(batchContext);

  const results = await runSettledWithConcurrency(
    batch.messages,
    DLQ_BATCH_CONCURRENCY_LIMIT,
    (msg) => archiveJobsDlqMessage(msg, db, env),
  );

  let acked = 0;
  let retried = 0;

  for (let i = 0; i < batch.messages.length; i++) {
    const result = results[i];
    const msg = batch.messages[i];
    if (!result || !msg) continue;
    if (result.status === "fulfilled") {
      console.warn(`[Queue] Archived DLQ message ${msg.id} type=${msg.body.type} as ${result.value}`);
      msg.ack();
      acked += 1;
    } else {
      console.error(`[Queue] Failed to archive DLQ message ${msg.id}:`, result.reason);
      msg.retry({ delaySeconds: 300 });
      retried += 1;
    }
  }

  logQueueBatchCompleted(batchContext, acked, retried);
}

async function archiveJobsDlqMessage(
  msg: Message<QueueBody>,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<string> {
  const payload = msg.body;
  if (isPaymentQueuePayload(payload)) {
    return archivePaymentEventsDlqMessage(msg as Message<PaymentOnlyQueueMessage>, db);
  }
  if (isOrderNotificationQueuePayload(payload) || payload.type === "notification") {
    return (await archiveNotificationDlqMessage(msg as Message<OrderNotificationQueueMessage | NotificationQueueMessage>, db)).status;
  }
  if (payload.type === "auth.send_otp") {
    return (await archiveAuthOtpDlqMessage(msg as Message<AuthOtpQueueMessage>, db, env)).status;
  }
  return "ignored";
}

type QueueBatchLogContext = {
  batchId: string;
  queue: string;
  messageCount: number;
  concurrencyLimit: number;
  startedAt: number;
  backlogCount: number | null;
  backlogBytes: number | null;
  oldestMessageAgeMs: number | null;
  firstMessageId: string | null;
  lastMessageId: string | null;
  maxAttempts: number;
};

async function runSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrencyLimit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrencyLimit, items.length));
  const results: Array<PromiseSettledResult<R> | undefined> = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      try {
        results[index] = { status: "fulfilled", value: await fn(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results as Array<PromiseSettledResult<R>>;
}

function createQueueBatchLogContext<T>(
  batch: MessageBatch<T>,
  concurrencyLimit: number,
): QueueBatchLogContext {
  const startedAt = Date.now();
  const metrics = batch.metadata?.metrics;
  const oldestMessageTimestampMs = toTimestampMs(metrics?.oldestMessageTimestamp);
  const attempts = batch.messages.map((message) => message.attempts);

  return {
    batchId: `qbatch_${startedAt.toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    queue: batch.queue,
    messageCount: batch.messages.length,
    concurrencyLimit,
    startedAt,
    backlogCount: typeof metrics?.backlogCount === "number" ? metrics.backlogCount : null,
    backlogBytes: typeof metrics?.backlogBytes === "number" ? metrics.backlogBytes : null,
    oldestMessageAgeMs: oldestMessageTimestampMs === null ? null : Math.max(0, startedAt - oldestMessageTimestampMs),
    firstMessageId: batch.messages[0]?.id ?? null,
    lastMessageId: batch.messages[batch.messages.length - 1]?.id ?? null,
    maxAttempts: attempts.length > 0 ? Math.max(...attempts) : 0,
  };
}

function logQueueBatchStarted(context: QueueBatchLogContext): void {
  console.log(
    `[Queue] event=queue_batch_started, batchId=${context.batchId}, queue=${context.queue}, ` +
      `messages=${context.messageCount}, concurrencyLimit=${context.concurrencyLimit}, ` +
      `backlogCount=${context.backlogCount ?? "unknown"}, backlogBytes=${context.backlogBytes ?? "unknown"}, ` +
      `oldestMessageAgeMs=${context.oldestMessageAgeMs ?? "unknown"}, firstMessageId=${context.firstMessageId ?? "none"}, ` +
      `lastMessageId=${context.lastMessageId ?? "none"}, maxAttempts=${context.maxAttempts}`,
  );
}

function logQueueBatchConcurrency(context: QueueBatchLogContext): void {
  if (context.messageCount <= context.concurrencyLimit) return;

  console.log(
    `[Queue] event=queue_batch_throttled, batchId=${context.batchId}, queue=${context.queue}, ` +
      `messages=${context.messageCount}, concurrencyLimit=${context.concurrencyLimit}`,
  );
}

function logQueueBatchCompleted(
  context: QueueBatchLogContext,
  acked: number,
  retried: number,
): void {
  console.log(
    `[Queue] event=queue_batch_completed, batchId=${context.batchId}, queue=${context.queue}, ` +
      `messages=${context.messageCount}, acked=${acked}, retried=${retried}, ` +
      `concurrencyLimit=${context.concurrencyLimit}, durationMs=${Date.now() - context.startedAt}`,
  );
}

function toTimestampMs(value: Date | number | string | undefined): number | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getQueueRetryDelaySeconds(error: unknown): number {
  if (error instanceof QueueRetryAfterError) return error.delaySeconds;
  return 30;
}

async function markAuthOtpDeliveryReceiptAcceptedWithRetries(
  db: ReturnType<typeof getDb>,
  receipt: Parameters<typeof markAuthOtpDeliveryReceiptAccepted>[1],
  result: AuthOtpDeliveryReceiptResult,
): Promise<void> {
  await retryAuthOtpReceiptWrite(() => markAuthOtpDeliveryReceiptAccepted(db, receipt, result));
}

async function markAuthOtpDeliveryReceiptSkippedWithRetries(
  db: ReturnType<typeof getDb>,
  receipt: Parameters<typeof markAuthOtpDeliveryReceiptSkipped>[1],
  reason: string,
  result: AuthOtpDeliveryReceiptResult,
): Promise<void> {
  await retryAuthOtpReceiptWrite(() => markAuthOtpDeliveryReceiptSkipped(db, receipt, reason, result));
}

async function markAuthOtpDeliveryReceiptAcceptedByKeyWithRetries(
  db: ReturnType<typeof getDb>,
  target: Parameters<typeof markAuthOtpDeliveryReceiptAcceptedByDeliveryKey>[1],
  result: AuthOtpDeliveryReceiptResult,
): Promise<"accepted" | "already_terminal"> {
  return await retryAuthOtpReceiptWrite(() => markAuthOtpDeliveryReceiptAcceptedByDeliveryKey(db, target, result));
}

async function retryAuthOtpReceiptWrite<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(50 * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function storeAuthOtpAcceptedHint(
  env: Env,
  target: { deliveryKey: string; channel: AuthOtpDeliveryChannel },
  result: AuthOtpDeliveryReceiptResult,
): Promise<void> {
  if (!env.CACHE) {
    throw new Error("CACHE binding is required to preserve accepted OTP delivery recovery hints");
  }

  const hint: AuthOtpAcceptedHint = {
    deliveryKey: target.deliveryKey,
    channel: target.channel,
    provider: result.provider ?? target.channel,
    providerMessageId: result.providerMessageId ?? null,
    providerStatus: result.providerStatus ?? "accepted",
    rawResponse: result.rawResponse ?? null,
    createdAt: Math.floor(Date.now() / 1000),
  };

  await env.CACHE.put(
    authOtpAcceptedHintKey(target.deliveryKey),
    JSON.stringify(hint),
    { expirationTtl: AUTH_OTP_ACCEPTED_HINT_TTL_SECONDS },
  );
}

async function recoverAuthOtpAcceptedDeliveryFromHint(
  db: ReturnType<typeof getDb>,
  env: Env,
  target: Awaited<ReturnType<typeof createAuthOtpDeliveryTarget>>,
): Promise<boolean> {
  const hint = await readAuthOtpAcceptedHint(env, target.deliveryKey);
  if (!hint) return false;

  try {
    const result = await markAuthOtpDeliveryReceiptAcceptedByKeyWithRetries(db, target, hint);
    await deleteAuthOtpAcceptedHint(env, target.deliveryKey);
    console.warn(
      `[Queue] Recovered accepted OTP delivery=${target.deliveryKey} channel=${target.channel} ` +
        `recipientHashPrefix=${getAuthOtpRecipientHashPrefix(target.identifierHash)} status=${result}`,
    );
    return true;
  } catch (error) {
    throw new QueueRetryAfterError(
      error instanceof Error ? error.message : String(error),
      30,
    );
  }
}

async function readAuthOtpAcceptedHint(
  env: Env,
  deliveryKey: string,
): Promise<AuthOtpAcceptedHint | null> {
  if (!env.CACHE) return null;
  const value = await env.CACHE.get(authOtpAcceptedHintKey(deliveryKey), "json");
  if (!isAuthOtpAcceptedHint(value, deliveryKey)) return null;
  return value;
}

async function deleteAuthOtpAcceptedHint(env: Env, deliveryKey: string): Promise<void> {
  if (!env.CACHE) return;
  await env.CACHE.delete(authOtpAcceptedHintKey(deliveryKey)).catch((error: unknown) => {
    console.warn(
      `[Queue] Failed to delete accepted OTP recovery hint delivery=${deliveryKey}:`,
      error instanceof Error ? error.message : error,
    );
  });
}

function authOtpAcceptedHintKey(deliveryKey: string): string {
  return `${AUTH_OTP_ACCEPTED_HINT_PREFIX}${deliveryKey}`;
}

function isAuthOtpAcceptedHint(value: unknown, deliveryKey: string): value is AuthOtpAcceptedHint {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AuthOtpAcceptedHint>;
  if (record.deliveryKey !== deliveryKey) return false;
  if (record.channel !== "email" && record.channel !== "sms" && record.channel !== "whatsapp") return false;
  if (!record.provider || typeof record.provider !== "string") return false;
  return true;
}

async function archivePaymentEventsDlqMessage(
  msg: Message<PaymentOnlyQueueMessage>,
  db: ReturnType<typeof getDb>,
): Promise<string> {
  const result = await recordPaymentWebhookDlqEvidence(db, createPaymentWebhookDlqEvidence(msg));
  return `webhook ${result.id} status=${result.status}`;
}

async function archiveAuthOtpDlqMessage(
  msg: Message<AuthOtpQueueMessage>,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<{ status: "accepted" | "skipped" | "already_terminal" }> {
  const payload = msg.body;
  const resolution = await resolveAuthOtpQueueDeliveryPayload(payload, msg.id, db, env);
  const resolvedPayload = resolution.payload;
  const channel = resolveAuthOtpDeliveryChannel(resolvedPayload);
  const target = await createAuthOtpDeliveryTarget({
    deliveryKey: resolvedPayload.deliveryKey,
    purpose: resolvedPayload.purpose ?? "customer_login",
    method: resolvedPayload.method,
    channel,
    provider: channel,
    identifier: resolvedPayload.identifier,
    otpExpiresAt: resolvedPayload.otpExpiresAt ?? null,
  });
  const acceptedHint = await readAuthOtpAcceptedHint(env, target.deliveryKey);
  if (acceptedHint) {
    const acceptedStatus = await markAuthOtpDeliveryReceiptAcceptedByKeyWithRetries(
      db,
      target,
      acceptedHint,
    );
    await deleteAuthOtpAcceptedHint(env, target.deliveryKey);
    console.warn(
      `[Queue] Archived accepted auth OTP DLQ delivery=${target.deliveryKey} channel=${target.channel} ` +
        `recipientHashPrefix=${getAuthOtpRecipientHashPrefix(target.identifierHash)} status=${acceptedStatus}`,
    );
    return { status: acceptedStatus };
  }

  const status = await markAuthOtpDeliveryReceiptSkippedByDeliveryKey(
    db,
    target,
    "auth_otp_dlq_terminal",
    {
      provider: target.provider,
      providerStatus: "auth_otp_dlq_terminal",
      rawResponse: `queue=${msg.id}; attempts=${msg.attempts}`,
    },
  );

  console.warn(
    `[Queue] Archived auth OTP DLQ delivery=${target.deliveryKey} channel=${target.channel} ` +
      `recipientHashPrefix=${getAuthOtpRecipientHashPrefix(target.identifierHash)} status=${status}`,
  );
  return { status };
}

// ── Single message processor ───────────────────────────────────────────────

/**
 * Process a single payment, notification, or OTP queue message.
 */
async function processQueueMessage(
  msg: Message<QueueBody>,
  db: ReturnType<typeof getDb>,
  env: Env,
  executionCtx?: ExecutionContext,
): Promise<void> {
  const payload = msg.body;
  console.log(`[Queue] Processing message type=${payload.type} id=${msg.id}`);
  let paymentWebhookStatus: PaymentWebhookCompletionStatus | undefined;
  let paymentWebhookResult: Record<string, unknown> | undefined;

  switch (payload.type) {
    // ── Auth / OTP ─────────────────────────────────────────────────────────
    // TODO: When SMS providers (Twilio, etc.) are finalized, extract this block
    //       to src/modules/notifications/otp.handler.ts
    case "auth.send_otp": {
      await processAuthOtpQueueMessage(payload, msg.id, db, env);
      break;
    }

    // ── Payments (every gateway) ─────────────────────────────────────────────

    case "payment.event": {
      const outcome = await applyPaymentEvent(db, env, executionCtx, payload);
      paymentWebhookStatus = outcome.status;
      paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, outcome.result);
      break;
    }

    // ── Order notifications ────────────────────────────────────────────────

    case "order.notification": {
      await processLegacyOrderNotificationMessage(payload, db, env);
      break;
    }

    case "notification": {
      await processNotificationMessage(payload, db, env);
      break;
    }

    // ── Automatic fulfilment (Wave A §2.6) ─────────────────────────────────
    // Idempotent: the ledger's unique request keys make redeliveries safe.

    case "order.auto_fulfil": {
      // Hand the messages it wrote (gift-card codes, downloads, or the staff
      // key-exhausted alert of a failed run) to the queue now instead of
      // waiting for the 15-minute outbox flush.
      const flushOutbox = () =>
        flushPendingNotificationOutbox({ db, queue: env.JOBS_QUEUE, limit: 50 }).catch((error: unknown) => {
          console.warn(`[Queue] auto-fulfil outbox flush for ${payload.orderId.slice(0, 12)} failed:`, error instanceof Error ? error.message : "unknown error");
        });
      let outcome: Awaited<ReturnType<typeof autoFulfilOrder>>;
      try {
        outcome = await autoFulfilOrder(db, payload.orderId, undefined, {
          credentialEncryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
        });
      } catch (error) {
        await flushOutbox();
        throw error;
      }
      if (outcome.delivered) await bumpCacheGeneration({ env, executionCtx });
      if (outcome.fulfilledTypes.length > 0) await flushOutbox();
      break;
    }

    // ── Media renditions ───────────────────────────────────────────────────
    // Delayed after an upload; skips media whose renditions already exist.
    // A render failure is acked: the scheduled backfill retries it.

    case "media.render_variants": {
      const images = env.IMAGES;
      if (!images) break;
      const outcome = await renderMissingMediaVariants(db, payload.mediaId, env.BUCKET, images);
      // Rendition URLs replace the published image URLs.
      if (outcome === "generated") await bumpCacheGeneration({ env, executionCtx });
      break;
    }

    // ── Catalogue projections and recommendations ─────────────────────────
    // Idempotent recomputations from their sources; a retry is harmless.

    case "catalog.recommendations.refresh":
    case "catalog.projections.rebuild": {
      const { processCatalogQueueMessage } = await import("./utils/catalog-jobs");
      await processCatalogQueueMessage(payload, db, env, executionCtx);
      break;
    }

    default: {
      const messageType = (payload as Record<string, unknown>).type;
      console.warn("[Queue] Unsupported message type:", messageType);
      throw new Error("Unsupported queue message type");
    }
  }

  if (paymentWebhookStatus && paymentWebhookResult) {
    await markPaymentWebhookEventCompleted(db, msg, paymentWebhookStatus, paymentWebhookResult);
  }
}

export type QueueBody =
  | PaymentQueueMessage
  | AuthOtpQueueMessage
  | OrderNotificationQueueMessage
  | NotificationQueueMessage
  | MediaVariantsQueueMessage
  | CatalogQueueMessage
  | OrderAutoFulfilQueueMessage;
type PaymentOnlyQueueMessage = Extract<PaymentQueueMessage, { type: `payment.${string}` }>;

function isPaymentQueuePayload(payload: QueueBody): payload is PaymentOnlyQueueMessage {
  return typeof payload.type === "string" && payload.type.startsWith("payment.");
}

function isOrderNotificationQueuePayload(payload: QueueBody): payload is OrderNotificationQueueMessage {
  return payload.type === "order.notification";
}

function getPaymentWebhookEventId(payload: QueueBody): string | undefined {
  if (!isPaymentQueuePayload(payload)) return undefined;
  return payload.webhookEventId;
}

/** Apply one provider-authenticated payment event through the gateway-agnostic kernel. */
async function applyPaymentEvent(
  db: ReturnType<typeof getDb>,
  env: Env,
  executionCtx: ExecutionContext | undefined,
  message: PaymentEventQueueMessage,
): Promise<{ status: PaymentWebhookCompletionStatus; result: Record<string, unknown> }> {
  const { provider, event } = message;
  const refs = { gateway: provider, providerRef: event.providerRef, secondaryRef: event.secondaryRef ?? null };

  switch (event.kind) {
    case "confirmed": {
      const currency = event.currency ?? "";
      const result = await processPaymentConfirmed(db, {
        orderId: event.orderId,
        provider,
        amountMinor: event.amountMinor ?? 0,
        currency,
        paymentType: event.paymentType,
        providerRef: event.providerRef,
        secondaryRef: event.secondaryRef,
        metadata: { currency, ...event.details },
      });
      const status = assertPaymentConfirmed(result, provider, event.orderId);
      if (result.success && !result.alreadyProcessed) {
        await enqueueOrderNotificationAfterPaymentConfirmed(db, env, {
          orderId: event.orderId,
          gateway: provider,
          paymentType: result.paymentType ?? event.paymentType ?? "full",
          amount: fromMinor(event.amountMinor ?? 0, getDecimalPlaces(currency)),
        });
        scheduleMetaPurchaseAfterPaymentConfirmed(db, env, executionCtx, { orderId: event.orderId, gateway: provider });
        await enqueueOrderAutoFulfil(env.JOBS_QUEUE, event.orderId, "payment-confirmed");
      }
      console.log(`[Queue] ${provider} payment confirmed for order ${event.orderId}`);
      return {
        status,
        result: {
          ...refs,
          outcome: result.success ? "confirmed" : "manual_reconciliation",
          error: result.success ? null : result.error ?? null,
        },
      };
    }
    case "failed":
      await processPaymentFailed(db, event.orderId, provider, event.providerRef);
      console.log(`[Queue] ${provider} payment failed for order ${event.orderId}`);
      return { status: "processed", result: { ...refs, outcome: "failed", ...event.details } };
    case "cancelled":
      await releaseOrderInventory(db, event.orderId);
      console.log(`[Queue] ${provider} payment cancelled, inventory released for order ${event.orderId}`);
      return { status: "processed", result: { ...refs, outcome: "canceled" } };
    case "refund_observed":
      // Refunds made in the provider dashboard stay audit-only here; scheduled
      // reconciliation imports provider-confirmed refunds into the ledger.
      return { status: "manual_reconciliation", result: { ...refs, outcome: "external_refund_observed", ...event.details } };
  }
}

function createPaymentWebhookDlqEvidence(
  msg: Message<PaymentOnlyQueueMessage>,
): PaymentWebhookDlqEvidence {
  const payload = msg.body;
  const { event } = payload;
  return {
    webhookEventId: payload.webhookEventId,
    fallbackEventId: buildWebhookEventId(payload.provider, `${payload.type}.dlq`, msg.id),
    provider: payload.provider,
    eventType: `${payload.type}.${event.kind}`,
    orderId: event.orderId,
    queueMessageId: msg.id,
    queueType: payload.type,
    attempts: msg.attempts,
    observedAtSeconds: Math.floor(Date.now() / 1000),
    messageTimestampSeconds: toUnixSeconds(msg.timestamp),
    payment: {
      kind: event.kind,
      providerRef: event.providerRef,
      secondaryRef: event.secondaryRef ?? null,
      amountMinor: event.amountMinor ?? null,
      currency: event.currency ?? null,
      paymentType: event.paymentType ?? null,
    },
  };
}

function toUnixSeconds(value: Date | number | string | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}

function createPaymentWebhookQueueResult(
  payload: PaymentOnlyQueueMessage,
  queueMessageId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    queueMessageId,
    queueType: payload.type,
    orderId: payload.event.orderId,
    ...extra,
  };
}

async function markPaymentWebhookEventCompleted(
  db: ReturnType<typeof getDb>,
  msg: Message<QueueBody>,
  status: PaymentWebhookCompletionStatus,
  result: Record<string, unknown>,
): Promise<void> {
  const webhookEventId = getPaymentWebhookEventId(msg.body);
  if (!webhookEventId) return;

  if (status === "manual_reconciliation") {
    await markWebhookEventManualReconciliation(db, webhookEventId, result);
    return;
  }

  await markWebhookEventProcessed(db, webhookEventId, result);
}

async function markPaymentWebhookEventFailedOnTerminalAttempt(
  db: ReturnType<typeof getDb>,
  msg: Message<QueueBody>,
  error: unknown,
): Promise<void> {
  const webhookEventId = getPaymentWebhookEventId(msg.body);
  if (!webhookEventId) return;
  if (msg.attempts < JOBS_TERMINAL_DELIVERY_ATTEMPT) return;

  try {
    await markWebhookEventFailed(db, webhookEventId, {
      queueMessageId: msg.id,
      queueType: msg.body.type,
      orderId: isPaymentQueuePayload(msg.body) ? msg.body.event.orderId : null,
      terminalDeliveryAttempt: msg.attempts,
      maxRetries: JOBS_MAX_RETRIES,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch (markError) {
    console.error("[Queue] Failed to mark payment webhook event terminal failure:", markError);
  }
}

type ResolvedAuthOtpQueueMessage = AuthOtpQueueMessage & {
  deliveryKey: string;
  identifier: string;
  name: string;
  /** Order codes name their order ("view order #1057"). */
  orderNumber?: number | null;
};

type AuthOtpDeliveryChallengeRow = {
  deliveryTargetEncrypted: string | null;
  deliveryNameEncrypted: string | null;
  method: "email" | "phone";
  channel: AuthOtpDeliveryChannel;
  expiresAt: number;
  orderNumber?: number | null;
};

async function resolveAuthOtpQueueDeliveryPayload(
  payload: AuthOtpQueueMessage,
  messageId: string,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<{ payload: ResolvedAuthOtpQueueMessage; resolutionError?: AuthOtpDeliveryError }> {
  const legacyIdentifier = payload.identifier?.trim();
  const deliveryKey = payload.deliveryKey?.trim() || `legacy:${messageId}`;
  const legacyName = payload.name?.trim() ?? "";
  if (legacyIdentifier) {
    return {
      payload: {
        ...payload,
        deliveryKey,
        identifier: legacyIdentifier,
        name: legacyName,
      },
    };
  }

  const channel = resolveAuthOtpDeliveryChannel(payload);
  const challengeKey = payload.challengeKey?.trim();
  const unresolvedPayload: ResolvedAuthOtpQueueMessage = {
    ...payload,
    deliveryKey,
    identifier: `unresolved:${deliveryKey}`,
    name: "",
  };

  if (!payload.deliveryKey?.trim() || !challengeKey) {
    return {
      payload: unresolvedPayload,
      resolutionError: createAuthOtpDeliveryError(
        "OTP delivery target reference is missing",
        {
          provider: channel,
          providerStatus: "missing_delivery_target_reference",
        },
        { terminal: true },
      ),
    };
  }

  const row = await selectAuthOtpDeliveryChallengeRow(db, {
    purpose: payload.purpose ?? "customer_login",
    challengeKey,
    deliveryKey,
  });
  if (!row) {
    return {
      payload: unresolvedPayload,
      resolutionError: createAuthOtpDeliveryError(
        "OTP delivery target could not be found",
        {
          provider: channel,
          providerStatus: "missing_delivery_target",
        },
        { terminal: true },
      ),
    };
  }

  const rowChannel = row.channel;
  const credentialKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const target = await readStoredCredentialStrict(
    row.deliveryTargetEncrypted,
    credentialKey,
    "OTP delivery target",
  );
  if (target.error || !target.value.trim()) {
    return {
      payload: {
        ...unresolvedPayload,
        method: row.method,
        channel: rowChannel,
        allowedMethod: authOtpAllowedMethodForChannel(rowChannel),
        otpExpiresAt: row.expiresAt,
      },
      resolutionError: createAuthOtpDeliveryError(
        target.error ?? "OTP delivery target is missing",
        {
          provider: rowChannel,
          providerStatus: target.error ? "delivery_target_decrypt_failed" : "missing_delivery_target",
        },
        { terminal: true },
      ),
    };
  }

  const name = await readStoredCredentialStrict(
    row.deliveryNameEncrypted,
    credentialKey,
    "OTP delivery name",
  );

  return {
    payload: {
      ...payload,
      challengeKey,
      deliveryKey,
      purpose: payload.purpose ?? "customer_login",
      otpExpiresAt: row.expiresAt,
      method: row.method,
      channel: rowChannel,
      allowedMethod: authOtpAllowedMethodForChannel(rowChannel),
      identifier: target.value.trim(),
      // A missing or unreadable name only drops the name from the greeting.
      name: name.error ? "" : name.value.trim(),
      orderNumber: row.orderNumber ?? null,
    },
  };
}

async function selectAuthOtpDeliveryChallengeRow(
  db: ReturnType<typeof getDb>,
  input: { purpose: string; challengeKey: string; deliveryKey: string },
): Promise<AuthOtpDeliveryChallengeRow | null> {
  // Track-order lookups share the payment-recovery challenge table.
  if (input.purpose === "order_payment_recovery" || input.purpose === "order_lookup") {
    const row = await db.select({
      deliveryTargetEncrypted: orderPaymentRecoveryChallenges.deliveryTargetEncrypted,
      deliveryNameEncrypted: orderPaymentRecoveryChallenges.deliveryNameEncrypted,
      method: orderPaymentRecoveryChallenges.method,
      channel: orderPaymentRecoveryChallenges.channel,
      expiresAt: orderPaymentRecoveryChallenges.expiresAt,
      orderNumber: orders.orderNumber,
    })
      .from(orderPaymentRecoveryChallenges)
      .leftJoin(orders, eq(orders.id, orderPaymentRecoveryChallenges.orderId))
      .where(and(
        eq(orderPaymentRecoveryChallenges.challengeKey, input.challengeKey),
        eq(orderPaymentRecoveryChallenges.deliveryKey, input.deliveryKey),
      ))
      .get();
    return row ?? null;
  }

  const row = await db.select({
    deliveryTargetEncrypted: customerAuthOtpChallenges.deliveryTargetEncrypted,
    deliveryNameEncrypted: customerAuthOtpChallenges.deliveryNameEncrypted,
    method: customerAuthOtpChallenges.method,
    channel: customerAuthOtpChallenges.channel,
    expiresAt: customerAuthOtpChallenges.expiresAt,
  })
    .from(customerAuthOtpChallenges)
    .where(and(
      eq(customerAuthOtpChallenges.otpKey, input.challengeKey),
      eq(customerAuthOtpChallenges.deliveryKey, input.deliveryKey),
    ))
    .get();
  return row ?? null;
}

function authOtpAllowedMethodForChannel(channel: AuthOtpDeliveryChannel): string {
  if (channel === "whatsapp") return "whatsapp_otp";
  if (channel === "sms") return "sms_otp";
  return "email";
}

async function processAuthOtpQueueMessage(
  payload: AuthOtpQueueMessage,
  messageId: string,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<void> {
  const resolution = await resolveAuthOtpQueueDeliveryPayload(payload, messageId, db, env);
  const resolvedPayload = resolution.payload;
  const channel = resolveAuthOtpDeliveryChannel(resolvedPayload);
  const target = await createAuthOtpDeliveryTarget({
    deliveryKey: resolvedPayload.deliveryKey,
    purpose: resolvedPayload.purpose ?? "customer_login",
    method: resolvedPayload.method,
    channel,
    provider: channel,
    identifier: resolvedPayload.identifier,
    otpExpiresAt: resolvedPayload.otpExpiresAt ?? null,
  });
  const claim = await claimAuthOtpDeliveryReceipt(db, target);

  if (!claim.claimed) {
    if (claim.reason === "accepted" || claim.reason === "delivered" || claim.reason === "skipped") {
      console.log(`[Queue] Skipped OTP delivery ${target.deliveryKey}: already ${claim.reason}`);
      return;
    }
    if (await recoverAuthOtpAcceptedDeliveryFromHint(db, env, target)) {
      return;
    }
    throw new QueueRetryAfterError(
      `OTP delivery receipt ${target.deliveryKey} is ${claim.reason}`,
      claim.retryAfterSeconds ?? 30,
    );
  }

  try {
    if (resolution.resolutionError) {
      throw resolution.resolutionError;
    }

    if (target.otpExpiresAt && target.otpExpiresAt <= Math.floor(Date.now() / 1000)) {
      await markAuthOtpDeliveryReceiptSkipped(db, claim.receipt, "otp_expired", {
        provider: target.provider,
        providerStatus: "otp_expired",
      });
      console.log(`[Queue] Skipped expired OTP delivery ${target.deliveryKey}`);
      return;
    }

    const code = await resolveAuthOtpDeliveryCode(resolvedPayload, target, env);
    const result = await sendAuthOtpByChannel(resolvedPayload, code, target, db, env);
    try {
      await markAuthOtpDeliveryReceiptAcceptedWithRetries(db, claim.receipt, result);
      await deleteAuthOtpAcceptedHint(env, target.deliveryKey);
    } catch (acceptedMarkError) {
      await storeAuthOtpAcceptedHint(env, target, result).catch((hintError: unknown) => {
        console.error(
          `[Queue] Failed to store accepted OTP recovery hint delivery=${target.deliveryKey}:`,
          hintError instanceof Error ? hintError.message : hintError,
        );
      });
      throw new QueueRetryAfterError(
        acceptedMarkError instanceof Error ? acceptedMarkError.message : String(acceptedMarkError),
        getAuthOtpDeliveryRetryDelaySeconds(claim.receipt.attempts),
      );
    }
  } catch (error) {
    if (error instanceof QueueRetryAfterError) {
      throw error;
    }

    const failureResult = getAuthOtpDeliveryFailureResult(error);
    if (isAuthOtpTerminalDeliveryFailure(error, failureResult)) {
      const reason = getAuthOtpTerminalDeliveryReason(error, failureResult);
      await blockAuthOtpProviderForMerchantActionableFailure(db, target, error, failureResult);
      await markAuthOtpDeliveryReceiptSkippedWithRetries(
        db,
        claim.receipt,
        reason,
        {
          provider: failureResult.provider ?? target.provider,
          providerMessageId: failureResult.providerMessageId,
          providerStatus: failureResult.providerStatus ?? reason,
          rawResponse: failureResult.rawResponse,
        },
      );
      console.warn(`[Queue] Skipped OTP delivery ${target.deliveryKey}: ${redactAuthOtpLogText(reason)}`);
      return;
    }

    await markAuthOtpDeliveryReceiptFailed(
      db,
      claim.receipt,
      error,
      failureResult,
    ).catch((markError: unknown) => {
      console.error("[Queue] Failed to mark OTP delivery receipt failure:", markError);
    });
    throw new QueueRetryAfterError(
      error instanceof Error ? error.message : String(error),
      getAuthOtpDeliveryRetryDelaySeconds(claim.receipt.attempts),
    );
  }
}

async function sendAuthOtpByChannel(
  payload: ResolvedAuthOtpQueueMessage,
  code: string,
  target: { deliveryKey: string; channel: AuthOtpDeliveryChannel; identifierHash: string },
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  if (payload.method !== "email" && (payload.channel === "whatsapp" || payload.allowedMethod === "whatsapp_otp")) {
    return sendAuthOtpWhatsApp(payload, code, target, db, env);
  }

  const message = composeAuthOtpMessage(await readOtpStoreIdentity(db), {
    purpose: payload.purpose,
    code,
    name: payload.name,
    orderNumber: payload.orderNumber,
  });
  return payload.method === "email"
    ? sendAuthOtpEmail(payload, message, target, db, env)
    : sendAuthOtpSms(payload, message, target, db, env);
}

/**
 * The store name and language the code is sent in. A code expires in minutes,
 * so a failed settings read sends it unbranded in English instead of waiting.
 */
async function readOtpStoreIdentity(db: ReturnType<typeof getDb>) {
  try {
    return await readStoreIdentity(db);
  } catch (error) {
    console.warn(
      "[Queue] Store identity unavailable for OTP delivery; sending unbranded:",
      error instanceof Error ? error.message : error,
    );
    return { name: null, logoUrl: null, language: "en" as const };
  }
}

type AuthOtpMessage = ReturnType<typeof composeAuthOtpMessage>;

async function resolveAuthOtpDeliveryCode(
  payload: AuthOtpQueueMessage,
  target: { deliveryKey: string; channel: AuthOtpDeliveryChannel },
  env: Env,
): Promise<string> {
  const challengeKey = payload.challengeKey?.trim();
  if (challengeKey && payload.deliveryKey) {
    return deriveCustomerAuthOtpDeliveryCode({
      otpKey: challengeKey,
      deliveryKey: payload.deliveryKey,
      encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
    });
  }

  const legacyCode = payload.code?.trim();
  if (legacyCode) return legacyCode;

  throw createAuthOtpDeliveryError(
    "OTP delivery challenge reference is missing",
    {
      provider: target.channel,
      providerStatus: "missing_challenge_reference",
    },
    { terminal: true },
  );
}

async function sendAuthOtpEmail(
  payload: ResolvedAuthOtpQueueMessage,
  message: AuthOtpMessage,
  target: { deliveryKey: string; identifierHash: string },
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  const block = await getNotificationProviderBlock(db, {
    channel: "email",
    provider: "email",
  });
  if (block) {
    throw createAuthOtpDeliveryError(
      buildAuthOtpProviderBlockedReason(block.reason),
      {
        provider: "email",
        providerStatus: "provider_blocked_until_settings_save",
        rawResponse: block.reason,
      },
      { terminal: true },
    );
  }

  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const result = await sendEmail({
    to: payload.identifier,
    subject: message.subject,
    html: message.html,
    text: message.text,
    fromName: message.fromName,
    idempotencyKey: target.deliveryKey,
  }, {
    db,
    env: env as unknown as Record<string, unknown>,
    encryptionKey,
  });

  const receiptResult: AuthOtpDeliveryReceiptResult = {
    provider: result.provider,
    providerMessageId: result.providerRef,
    providerStatus: result.rawStatus ?? (result.success ? "accepted" : "failed"),
  };

  if (!result.success) {
    throw createAuthOtpDeliveryError(
      `OTP email delivery unavailable: ${result.rawStatus ?? result.provider}`,
      receiptResult,
      {
        terminal: isAuthOtpNonRetryableStatus(result.rawStatus) || result.provider === "log",
        blockProvider: {
          channel: "email",
          provider: "email",
          reason: result.rawStatus ?? "email_provider_not_configured",
        },
      },
    );
  }

  console.log(
    `[Queue] Sent OTP email delivery=${target.deliveryKey} recipientHashPrefix=${getAuthOtpRecipientHashPrefix(target.identifierHash)}`,
  );
  return receiptResult;
}

async function sendAuthOtpWhatsApp(
  payload: ResolvedAuthOtpQueueMessage,
  code: string,
  target: { deliveryKey: string; identifierHash: string },
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  const block = await getNotificationProviderBlock(db, {
    channel: "whatsapp",
    provider: "whatsapp",
  });
  if (block) {
    throw createAuthOtpDeliveryError(
      buildAuthOtpProviderBlockedReason(block.reason),
      {
        provider: "whatsapp",
        providerStatus: "provider_blocked_until_settings_save",
        rawResponse: block.reason,
      },
      { terminal: true },
    );
  }

  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const config = await getWhatsAppCloudApiSettings(db, encryptionKey);
  if (!config.accessToken || !config.phoneNumberId) {
    throw createAuthOtpDeliveryError("WhatsApp credentials are not configured", {
      provider: "whatsapp",
      providerStatus: "missing_credentials",
    }, {
      terminal: true,
      blockProvider: {
        channel: "whatsapp",
        provider: "whatsapp",
        reason: "missing_credentials",
      },
    });
  }

  const result = await sendWhatsAppTemplateMessage({
    accessToken: config.accessToken,
    phoneNumberId: config.phoneNumberId,
    to: payload.identifier,
    templateName: config.authTemplateName,
    languageCode: "en_US",
    bodyParameters: [code],
  });

  const receiptResult: AuthOtpDeliveryReceiptResult = {
    provider: "whatsapp",
    providerMessageId: result.providerRef,
    providerStatus: result.rawStatus,
    rawResponse: result.rawResponse,
  };

  if (!result.success) {
    throw createAuthOtpDeliveryError(`WhatsApp OTP delivery failed: ${result.rawStatus}`, {
      provider: "whatsapp",
      providerMessageId: result.providerRef,
      providerStatus: result.rawStatus,
      rawResponse: result.rawResponse,
    }, {
      terminal: result.retryable === false || isAuthOtpNonRetryableStatus(`${result.rawStatus} ${result.rawResponse ?? ""}`),
      blockProvider: {
        channel: "whatsapp",
        provider: "whatsapp",
        reason: `${result.rawStatus} ${result.rawResponse ?? ""}`.trim(),
      },
    });
  }

  console.log(
    `[Queue] Sent WhatsApp OTP delivery=${target.deliveryKey} recipientHashPrefix=${getAuthOtpRecipientHashPrefix(target.identifierHash)}`,
  );
  return receiptResult;
}

async function sendAuthOtpSms(
  payload: ResolvedAuthOtpQueueMessage,
  message: AuthOtpMessage,
  target: { deliveryKey: string; channel: AuthOtpDeliveryChannel; identifierHash: string },
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const smsProvider = await getActiveSmsProvider(db, encryptionKey);
  if (!smsProvider) {
    throw createAuthOtpDeliveryError(
      "SMS OTP requested but no SMS provider is configured. Configure an SMS provider in Auth & Access settings.",
      { provider: "sms", providerStatus: "not_configured" },
      {
        terminal: true,
        blockProvider: {
          channel: "sms",
          provider: "sms",
          reason: "not_configured",
        },
      },
    );
  }

  const block = await getNotificationProviderBlock(db, {
    channel: "sms",
    provider: smsProvider.name,
  }) ?? await getNotificationProviderBlock(db, {
    channel: "sms",
    provider: "sms",
  });
  if (block) {
    throw createAuthOtpDeliveryError(
      buildAuthOtpProviderBlockedReason(block.reason),
      {
        provider: smsProvider.name,
        providerStatus: "provider_blocked_until_settings_save",
        rawResponse: block.reason,
      },
      { terminal: true },
    );
  }

  const result = await smsProvider.sendSms({
    to: payload.identifier,  // Already E.164 from customers.phone
    message: message.sms,
    clientReference: createAuthOtpProviderClientReference(target),
  });

  const receiptResult: AuthOtpDeliveryReceiptResult = {
    provider: smsProvider.name,
    providerMessageId: result.providerRef,
    providerStatus: result.rawStatus ?? (result.success ? "accepted" : "failed"),
  };

  if (!result.success) {
    throw createAuthOtpDeliveryError(
      `SMS OTP delivery failed via ${smsProvider.name}: ${result.rawStatus ?? "unknown provider status"}`,
      receiptResult,
      {
        terminal: result.retryable === false || isAuthOtpNonRetryableStatus(result.rawStatus),
        blockProvider: {
          channel: "sms",
          provider: smsProvider.name,
          reason: result.rawStatus ?? "sms_provider_non_retryable_failure",
        },
      },
    );
  }

  console.log(
    `[Queue] SMS OTP sent via ${smsProvider.name} delivery=${target.deliveryKey} recipientHashPrefix=${getAuthOtpRecipientHashPrefix(target.identifierHash)}, ref=${result.providerRef}`,
  );
  return receiptResult;
}

function resolveAuthOtpDeliveryChannel(payload: AuthOtpQueueMessage): AuthOtpDeliveryChannel {
  if (payload.method === "email") return "email";
  if (payload.channel === "whatsapp" || payload.allowedMethod === "whatsapp_otp") return "whatsapp";
  return "sms";
}

type AuthOtpDeliveryError = Error & {
  deliveryResult?: AuthOtpDeliveryReceiptResult;
  terminal?: boolean;
  blockProvider?: {
    channel: AuthOtpDeliveryChannel;
    provider: string;
    reason: string;
  };
};

function createAuthOtpDeliveryError(
  message: string,
  deliveryResult?: AuthOtpDeliveryReceiptResult,
  options: {
    terminal?: boolean;
    blockProvider?: AuthOtpDeliveryError["blockProvider"];
  } = {},
): AuthOtpDeliveryError {
  const error = new Error(message) as AuthOtpDeliveryError;
  error.deliveryResult = deliveryResult;
  error.terminal = options.terminal;
  error.blockProvider = options.blockProvider;
  return error;
}

function getAuthOtpDeliveryFailureResult(error: unknown): AuthOtpDeliveryReceiptResult {
  if (error instanceof Error && "deliveryResult" in error) {
    return (error as AuthOtpDeliveryError).deliveryResult ?? {};
  }
  return {};
}

function isAuthOtpTerminalDeliveryFailure(
  error: unknown,
  result: AuthOtpDeliveryReceiptResult,
): boolean {
  if (error instanceof Error && "terminal" in error && (error as AuthOtpDeliveryError).terminal) {
    return true;
  }

  const status = [result.providerStatus, result.rawResponse, error instanceof Error ? error.message : String(error)]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return isAuthOtpNonRetryableStatus(status);
}

function getAuthOtpTerminalDeliveryReason(
  error: unknown,
  result: AuthOtpDeliveryReceiptResult,
): string {
  if (result.providerStatus === "provider_blocked_until_settings_save") {
    return error instanceof Error
      ? error.message
      : buildAuthOtpProviderBlockedReason(result.rawResponse ?? "provider_setup_failure");
  }

  return result.providerStatus
    ?? result.rawResponse
    ?? (error instanceof Error ? error.message : String(error))
    ?? "provider_non_retryable_failure";
}

function isAuthOtpNonRetryableStatus(value: string | null | undefined): boolean {
  const status = value?.trim();
  if (!status) return false;

  return AUTH_OTP_NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(status));
}

async function blockAuthOtpProviderForMerchantActionableFailure(
  db: ReturnType<typeof getDb>,
  target: { channel: AuthOtpDeliveryChannel; provider: string },
  error: unknown,
  result: AuthOtpDeliveryReceiptResult,
): Promise<void> {
  if (result.providerStatus === "provider_blocked_until_settings_save") return;

  const typedError = error instanceof Error ? error as AuthOtpDeliveryError : undefined;
  const candidate = typedError?.blockProvider ?? {
    channel: target.channel,
    provider: result.provider ?? target.provider,
    reason: getAuthOtpTerminalDeliveryReason(error, result),
  };

  if (!isAuthOtpProviderSetupFailure(candidate.reason)) return;

  await markNotificationProviderBlocked(db, candidate).catch((blockError: unknown) => {
    console.error(
      `[Queue] Failed to block OTP ${candidate.channel}/${candidate.provider} provider after setup failure:`,
      blockError instanceof Error ? blockError.message : blockError,
    );
  });
}

function isAuthOtpProviderSetupFailure(value: string | null | undefined): boolean {
  const status = value?.trim();
  if (!status) return false;
  return isNotificationProviderBreakerFailure(status)
    || AUTH_OTP_PROVIDER_SETUP_PATTERNS.some((pattern) => pattern.test(status));
}

function buildAuthOtpProviderBlockedReason(reason: string): string {
  return `provider_blocked_until_settings_save: ${reason}`;
}

function redactAuthOtpLogText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
    .replace(/\b\d{6}\b/g, "[code]");
}

function getAuthOtpRecipientHashPrefix(identifierHash: string): string {
  return identifierHash.slice(0, 12);
}

const AUTH_OTP_NON_RETRYABLE_PATTERNS = [
  /no configured .*provider/i,
  /no active .*provider/i,
  /provider .*not ready/i,
  /not configured/i,
  /missing[_\s-]?credentials/i,
  /could not be decrypted/i,
  /credential/i,
  /auth(?:orization|entication)?\s+(?:required|failed|error)/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid\s+(?:api\s*)?(?:key|token|credential)/i,
  /api\s*(?:key|token)\s+(?:invalid|expired|missing|not configured)/i,
  /\b(?:http|status|code|error)?\s*(?:400|401|402|403|404|405|422)\b/i,
  /permission/i,
  /sender/i,
  /invalid[_\s-]?grant/i,
  /private key/i,
  /service account/i,
  /insufficient\s+(?:balance|credit)/i,
  /\bbalance\b/i,
  /account\s+(?:expired|suspended|inactive|disabled)/i,
  /invalid\s+(?:number|mobile|recipient|msisdn)/i,
  /blacklist/i,
  /message\s+(?:empty|too\s+long|length)/i,
  /\bpaused\b/i,
];

const AUTH_OTP_PROVIDER_SETUP_PATTERNS = [
  /no configured .*provider/i,
  /no active .*provider/i,
  /provider .*not ready/i,
  /not configured/i,
  /missing[_\s-]?credentials/i,
  /could not be decrypted/i,
  /credential/i,
  /auth(?:orization|entication)?\s+(?:required|failed|error)/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid\s+(?:api\s*)?(?:key|token|credential)/i,
  /api\s*(?:key|token)\s+(?:invalid|expired|missing|not configured)/i,
  /\b(?:http|status|code|error)?\s*(?:401|402|403|405)\b/i,
  /permission/i,
  /sender/i,
  /invalid[_\s-]?grant/i,
  /private key/i,
  /service account/i,
  /insufficient\s+(?:balance|credit)/i,
  /\bbalance\b/i,
  /account\s+(?:expired|suspended|inactive|disabled)/i,
  /\bpaused\b/i,
];
