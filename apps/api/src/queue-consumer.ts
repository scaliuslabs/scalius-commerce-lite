// src/queue-consumer.ts
// Cloudflare Queue consumer — thin dispatcher.
// Receives batches from Cloudflare and routes each message to the right handler.
//
// Architecture:
//   Webhook handler  →  enqueue message  →  return 200 immediately
//   Queue consumer   →  process message  →  update DB, send notifications
//
// This makes webhooks resilient: Cloudflare retries failed queue messages
// automatically (up to max_retries = 3).
//
// Handler locations:
//   payment.*        → src/modules/payments/process-payment.ts   (via switch below)
//   order.notif      → src/modules/notifications/notifications.service.ts
//   auth.send_otp    → inline below (WhatsApp + email; SMS providers TBD)
//   storefront.cache → src/utils/cache-invalidation.ts
//
// TODO: When 5-6 SMS providers are implemented, extract auth.send_otp to
//       src/modules/notifications/otp.handler.ts

import { getDb } from "@scalius/database/client";
import { processPaymentConfirmed, processPaymentFailed, releaseOrderInventory } from "@scalius/core/modules/payments/process-payment";
import { processPolarWebhookRefund } from "@scalius/core/modules/payments/polar";
import { sendOrderNotificationEmail, sendOrderNotification } from "@scalius/core/modules/notifications/notifications.service";
import type { OrderNotificationType } from "@scalius/core/modules/notifications";
import {
  claimOrderNotificationOutboxForProcessing,
  markOrderNotificationOutboxProcessingFailed,
  markOrderNotificationOutboxSent,
} from "@scalius/core/modules/notifications";
import { sendEmail } from "@scalius/core/integrations/email";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { getActiveSmsProvider } from "@scalius/core/integrations/sms";
import { getWhatsAppCloudApiSettings, sendWhatsAppTemplateMessage } from "@scalius/core/integrations/whatsapp";
import {
  enqueueOrderBalancePaidNotificationForOrder,
  enqueueOrderCreatedNotificationForOrder,
  enqueueOrderRefundNotificationForOrder,
} from "./utils/order-notification-queue";
import {
  claimAuthOtpDeliveryReceipt,
  createAuthOtpDeliveryTarget,
  createAuthOtpProviderClientReference,
  markAuthOtpDeliveryReceiptAccepted,
  markAuthOtpDeliveryReceiptFailed,
  markAuthOtpDeliveryReceiptSkipped,
  type AuthOtpDeliveryChannel,
  type AuthOtpDeliveryReceiptResult,
} from "@scalius/core/modules/customers/otp-delivery-receipts";
import { escapeHtml } from "@scalius/shared/html-escape";
import { getCredentialEncryptionKey } from "./utils/encryption-key";
import {
  createStorefrontCacheWarmMessageForPurge,
  enqueueStorefrontCacheWarm,
  invalidateProductAvailabilityCaches,
  purgeStorefrontForPrefixes,
  warmStorefrontHtmlPaths,
  type StorefrontCachePurgeQueueMessage,
  type StorefrontCacheQueueMessage as CacheQueueMessage,
  type StorefrontCacheWarmQueueMessage,
} from "./utils/cache-invalidation";
import { archiveStorefrontCacheQueueFailure } from "./utils/storefront-cache-queue-failures";
import {
  markWebhookEventFailed,
  markWebhookEventManualReconciliation,
  markWebhookEventProcessed,
  recordPaymentWebhookDlqEvidence,
  buildWebhookEventId,
  type PaymentWebhookDlqEvidence,
} from "./utils/webhook-idempotency";

type PaymentConfirmationResult = Awaited<ReturnType<typeof processPaymentConfirmed>>;
type PaymentWebhookCompletionStatus = "processed" | "manual_reconciliation";
type ConfirmedPaymentType = "full" | "deposit" | "balance";

// Mirrors apps/api/wrangler*.jsonc for PAYMENT_EVENTS_QUEUE. Cloudflare delivers
// the first attempt plus max_retries additional attempts before DLQ/deletion.
const PAYMENT_EVENTS_MAX_RETRIES = 3;
const PAYMENT_EVENTS_TERMINAL_DELIVERY_ATTEMPT = PAYMENT_EVENTS_MAX_RETRIES + 1;
const QUEUE_BATCH_CONCURRENCY_LIMIT = 3;
const DLQ_BATCH_CONCURRENCY_LIMIT = 2;

function assertPaymentConfirmed(
  result: PaymentConfirmationResult,
  gateway: "stripe" | "sslcommerz" | "polar",
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

function normalizeConfirmedPaymentType(value: unknown): ConfirmedPaymentType {
  return value === "deposit" || value === "balance" || value === "full" ? value : "full";
}

async function enqueueOrderCreatedAfterPaymentConfirmed(
  db: ReturnType<typeof getDb>,
  env: Env,
  orderId: string,
  gateway: "stripe" | "sslcommerz" | "polar",
): Promise<void> {
  const result = await enqueueOrderCreatedNotificationForOrder({
    db,
    queue: env.ORDER_NOTIFICATIONS_QUEUE,
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
    gateway: "stripe" | "sslcommerz" | "polar";
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
    queue: env.ORDER_NOTIFICATIONS_QUEUE,
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

async function enqueueOrderRefundNotificationAfterPolarWebhook(
  db: ReturnType<typeof getDb>,
  env: Env,
  options: {
    orderId: string;
    notification?: {
      notificationType: "order_refunded" | "order_partially_refunded";
      dedupeKey: string;
      data?: Record<string, unknown>;
    };
  },
): Promise<void> {
  if (!options.notification) return;

  const result = await enqueueOrderRefundNotificationForOrder({
    db,
    queue: env.ORDER_NOTIFICATIONS_QUEUE,
    orderId: options.orderId,
    notificationType: options.notification.notificationType,
    dedupeKey: options.notification.dedupeKey,
    source: "payment-polar-refunded",
    data: options.notification.data,
  });

  if (!result.enqueued) {
    console.warn(
      `[Queue] Polar refund notification for order ${options.orderId} recorded but not enqueued: ${result.skippedReason}`,
    );
  }
}

type PaymentWebhookEventLink = {
  webhookEventId?: string;
};

export type PaymentQueueMessage =
  | (PaymentWebhookEventLink & {
    type: "payment.stripe.confirmed";
    orderId: string;
    paymentIntentId: string;
    amount: number; // in smallest currency unit (cents, yen, fils — see ISO 4217)
    currency: string;
    chargeId?: string;
    metadata?: Record<string, string>;
  })
  | (PaymentWebhookEventLink & {
    type: "payment.stripe.failed";
    orderId: string;
    paymentIntentId: string;
    failureCode?: string;
    failureMessage?: string;
  })
  | (PaymentWebhookEventLink & {
    type: "payment.stripe.canceled";
    orderId: string;
    paymentIntentId: string;
  })
  | (PaymentWebhookEventLink & {
    type: "payment.stripe.refunded";
    orderId: string;
    paymentIntentId: string;
    amountRefunded: number; // in smallest currency unit (cents, yen, fils — see ISO 4217)
    currency: string;
    chargeId: string;
    refunds?: Array<{
      id: string;
      amount: number;
      currency: string;
      status?: string | null;
    }>;
  })
  | (PaymentWebhookEventLink & {
    type: "payment.sslcommerz.confirmed";
    orderId: string;
    tranId: string;
    valId: string;
    bankTranId: string;
    amount: number;
    currency: string;
    cardType?: string;
    cardBrand?: string;
    paymentType?: string;
  })
  | (PaymentWebhookEventLink & {
    type: "payment.sslcommerz.failed";
    orderId: string;
    tranId: string;
    status: string;
  })
  | (PaymentWebhookEventLink & {
    type: "payment.polar.confirmed";
    orderId: string;
    checkoutId: string;
    amount?: number; // in smallest currency unit (cents, yen, fils — see ISO 4217)
    currency?: string;
    paymentType?: string;
    metadata?: Record<string, string>;
  })
  | (PaymentWebhookEventLink & {
    type: "payment.polar.failed";
    orderId: string;
    checkoutId: string;
    reason?: string;
  })
  | (PaymentWebhookEventLink & {
    type: "payment.polar.refunded";
    orderId: string;
    polarCheckoutId: string;
    amountRefunded: number; // in smallest currency unit (cents) — cumulative refunded amount from Polar
    totalAmount: number; // in smallest currency unit (cents) — original total from Polar
    currency: string;
    polarStatus: string; // "refunded" (full) or "partially_refunded"
  })
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
    deliveryKey?: string;
    purpose?: string;
	    otpExpiresAt?: number;
	    method: "email" | "phone";
	    allowedMethod: string;
	    channel?: "email" | "sms" | "whatsapp";
	    identifier: string;
    code: string;
    name: string;
  };

export type StorefrontCacheQueueMessage = CacheQueueMessage;

// ── Queue batch handler ────────────────────────────────────────────────────

/**
 * Handle a batch of queue messages.
 * Each message is processed independently; failures are retried by Cloudflare.
 */
export async function handleQueueBatch(
  batch: MessageBatch<PaymentQueueMessage | AuthOtpQueueMessage | StorefrontCacheQueueMessage>,
  env: Env,
  executionCtx?: ExecutionContext,
): Promise<void> {
  const db = getDb(env);

  if (batch.queue === "payment-events-dlq") {
    await handlePaymentEventsDlqBatch(batch as unknown as MessageBatch<QueueBody>, db);
    return;
  }

  if (batch.queue === "storefront-cache-dlq") {
    await handleStorefrontCacheDlqBatch(
      batch as unknown as MessageBatch<StorefrontCacheQueueMessage>,
      db,
    );
    return;
  }

  logQueueBatchConcurrency(batch.queue, batch.messages.length, QUEUE_BATCH_CONCURRENCY_LIMIT);

  const results = await runSettledWithConcurrency(
    batch.messages,
    QUEUE_BATCH_CONCURRENCY_LIMIT,
    (msg) => processQueueMessage(
      msg as unknown as Message<PaymentQueueMessage | AuthOtpQueueMessage | StorefrontCacheQueueMessage>,
      db,
      env,
      executionCtx,
    ),
  );

  // Ack successful, retry failed with backoff
  for (let i = 0; i < batch.messages.length; i++) {
    const result = results[i];
    const msg = batch.messages[i];
    if (!result || !msg) continue;
    if (result.status === "fulfilled") {
      msg.ack();
    } else {
      console.error(`[Queue] Failed to process message ${msg.id}:`, result.status === "rejected" ? result.reason : "unknown");
      await markPaymentWebhookEventFailedOnTerminalAttempt(
        db,
        msg as unknown as Message<PaymentQueueMessage | AuthOtpQueueMessage | StorefrontCacheQueueMessage>,
        result.reason,
      );
      msg.retry({ delaySeconds: 30 });
    }
  }
}

async function handlePaymentEventsDlqBatch(
  batch: MessageBatch<QueueBody>,
  db: ReturnType<typeof getDb>,
): Promise<void> {
  logQueueBatchConcurrency(batch.queue, batch.messages.length, DLQ_BATCH_CONCURRENCY_LIMIT);

  const results = await runSettledWithConcurrency(
    batch.messages,
    DLQ_BATCH_CONCURRENCY_LIMIT,
    (msg) => archivePaymentEventsDlqMessage(msg, db),
  );

  for (let i = 0; i < batch.messages.length; i++) {
    const result = results[i];
    const msg = batch.messages[i];
    if (!result || !msg) continue;
    if (result.status === "fulfilled") {
      msg.ack();
    } else {
      console.error(`[Queue] Failed to archive payment DLQ message ${msg.id}:`, result.reason);
      msg.retry({ delaySeconds: 300 });
    }
  }
}

async function handleStorefrontCacheDlqBatch(
  batch: MessageBatch<StorefrontCacheQueueMessage>,
  db: ReturnType<typeof getDb>,
): Promise<void> {
  logQueueBatchConcurrency(batch.queue, batch.messages.length, DLQ_BATCH_CONCURRENCY_LIMIT);

  const results = await runSettledWithConcurrency(
    batch.messages,
    DLQ_BATCH_CONCURRENCY_LIMIT,
    (msg) => archiveStorefrontCacheQueueFailure(db, msg, batch.queue),
  );

  for (let i = 0; i < batch.messages.length; i++) {
    const result = results[i];
    const msg = batch.messages[i];
    if (!result || !msg) continue;
    if (result.status === "fulfilled") {
      console.warn(
        `[Queue] Archived storefront cache DLQ message ${msg.id} as ${result.value.id}`,
      );
      msg.ack();
    } else {
      console.error(`[Queue] Failed to archive storefront cache DLQ message ${msg.id}:`, result.reason);
      msg.retry({ delaySeconds: 300 });
    }
  }
}

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

function logQueueBatchConcurrency(queue: string, messageCount: number, concurrencyLimit: number): void {
  if (messageCount <= concurrencyLimit) return;

  console.log(
    `[Queue] Processing ${messageCount} message(s) from ${queue} with concurrency limit ${concurrencyLimit}`,
  );
}

async function archivePaymentEventsDlqMessage(
  msg: Message<QueueBody>,
  db: ReturnType<typeof getDb>,
): Promise<void> {
  const payload = msg.body;
  if (!isPaymentQueuePayload(payload)) {
    console.warn(`[Queue] Ignoring non-payment message in payment-events-dlq id=${msg.id}`);
    return;
  }

  const evidence = createPaymentWebhookDlqEvidence(msg as Message<PaymentOnlyQueueMessage>);
  const result = await recordPaymentWebhookDlqEvidence(db, evidence);
  console.warn(
    `[Queue] Archived payment DLQ message ${msg.id} for webhook ${result.id} with status=${result.status}`,
  );
}

// ── Single message processor ───────────────────────────────────────────────

/**
 * Process a single payment, notification, or OTP queue message.
 */
async function processQueueMessage(
  msg: Message<PaymentQueueMessage | AuthOtpQueueMessage | StorefrontCacheQueueMessage>,
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

    // ── Storefront cache purge/rewarm coordination ─────────────────────────

    case "storefront.cache_purge": {
      await processStorefrontCachePurgeQueueMessage(payload, env, executionCtx);
      break;
    }

    case "storefront.cache_warm": {
      await processStorefrontCacheWarmQueueMessage(payload, env);
      break;
    }

    // ── Stripe ─────────────────────────────────────────────────────────────

    case "payment.stripe.confirmed": {
      // Convert smallest currency unit → major unit using ISO 4217 decimals.
      // e.g. USD/BDT: ÷100, JPY: ÷1, BHD: ÷1000
      const stripeDecimals = getDecimalPlaces(payload.currency);
      const amountInMajor = payload.amount / Math.pow(10, stripeDecimals);
      const paymentType = normalizeConfirmedPaymentType(payload.metadata?.paymentType);
      const result = await processPaymentConfirmed(db, {
        orderId: payload.orderId,
        paymentGateway: "stripe",
        paymentType,
        stripePaymentIntentId: payload.paymentIntentId,
        stripeChargeId: payload.chargeId,
        amount: amountInMajor,
        metadata: { currency: payload.currency },
      });
      const completionStatus = assertPaymentConfirmed(result, "stripe", payload.orderId);
      if (result.success) {
        await invalidateProductAvailabilityCaches(db, { orderIds: [payload.orderId] }, { env, executionCtx });
        await enqueueOrderNotificationAfterPaymentConfirmed(db, env, {
          orderId: payload.orderId,
          gateway: "stripe",
          paymentType,
          amount: amountInMajor,
        });
      }
      paymentWebhookStatus = completionStatus;
      paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, {
        gateway: "stripe",
        outcome: result.success ? "confirmed" : "manual_reconciliation",
        error: result.success ? null : result.error ?? null,
      });
      console.log(`[Queue] Stripe payment confirmed for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.failed": {
      await processPaymentFailed(db, payload.orderId, "stripe", payload.paymentIntentId);
      paymentWebhookStatus = "processed";
      paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, {
        gateway: "stripe",
        outcome: "failed",
        failureCode: payload.failureCode ?? null,
        failureMessage: payload.failureMessage ?? null,
      });
      console.log(`[Queue] Stripe payment failed for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.canceled": {
      await releaseOrderInventory(db, payload.orderId);
      await invalidateProductAvailabilityCaches(db, { orderIds: [payload.orderId] }, { env, executionCtx });
      paymentWebhookStatus = "processed";
      paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, {
        gateway: "stripe",
        outcome: "canceled",
      });
      console.log(`[Queue] Stripe payment cancelled, inventory released for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.refunded": {
      // Stripe refunds may originate in the Stripe dashboard. Keep this queue
      // step audit-only; scheduled reconciliation imports provider-confirmed
      // refunds into the local refund ledger before notifying buyers.
      paymentWebhookStatus = "manual_reconciliation";
      paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, {
        gateway: "stripe",
        outcome: "external_refund_observed",
        amountRefunded: payload.amountRefunded,
        currency: payload.currency,
        paymentIntentId: payload.paymentIntentId,
        chargeId: payload.chargeId,
        refunds: payload.refunds ?? [],
      });
      console.log(`[Queue] Stripe refund observed for order ${payload.orderId}; awaiting scheduled reconciliation`);
      break;
    }

    // ── SSLCommerz ─────────────────────────────────────────────────────────

    case "payment.sslcommerz.confirmed": {
      const paymentType = normalizeConfirmedPaymentType(payload.paymentType);
      const result = await processPaymentConfirmed(db, {
        orderId: payload.orderId,
        paymentGateway: "sslcommerz",
        paymentType,
        sslcommerzTranId: payload.tranId,
        sslcommerzValId: payload.valId,
        sslcommerzBankTranId: payload.bankTranId,
        amount: payload.amount,
        metadata: { currency: payload.currency, cardType: payload.cardType, cardBrand: payload.cardBrand },
      });
      const completionStatus = assertPaymentConfirmed(result, "sslcommerz", payload.orderId);
      if (result.success) {
        await invalidateProductAvailabilityCaches(db, { orderIds: [payload.orderId] }, { env, executionCtx });
        await enqueueOrderNotificationAfterPaymentConfirmed(db, env, {
          orderId: payload.orderId,
          gateway: "sslcommerz",
          paymentType,
          amount: payload.amount,
        });
      }
      paymentWebhookStatus = completionStatus;
      paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, {
        gateway: "sslcommerz",
        outcome: result.success ? "confirmed" : "manual_reconciliation",
        error: result.success ? null : result.error ?? null,
      });
      console.log(`[Queue] SSLCommerz payment confirmed for order ${payload.orderId}`);
      break;
    }

    case "payment.sslcommerz.failed": {
      await processPaymentFailed(db, payload.orderId, "sslcommerz", payload.tranId);
      paymentWebhookStatus = "processed";
      paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, {
        gateway: "sslcommerz",
        outcome: "failed",
        status: payload.status,
      });
      console.log(`[Queue] SSLCommerz payment failed for order ${payload.orderId}`);
      break;
    }

    // ── Polar ──────────────────────────────────────────────────────────────

    case "payment.polar.confirmed": {
      // Convert smallest currency unit → major unit using ISO 4217 decimals.
      const polarCurrency = payload.currency ?? "usd";
      const polarDecimals = getDecimalPlaces(polarCurrency);
      const gatewayAmountMajor = (payload.amount ?? 0) / Math.pow(10, polarDecimals);

      // If currency was converted (e.g. BDT→USD), the checkout metadata contains
      // the original local-currency amount. Use it so paidAmount matches totalAmount's
      // currency. Without this, a $8.40 USD payment would be recorded as ৳8.40 against
      // a ৳1000 order, incorrectly marking it as partial.
      const originalAmount = payload.metadata?.originalAmount
        ? parseFloat(payload.metadata.originalAmount)
        : null;
      const recordAmount = originalAmount != null && !isNaN(originalAmount)
        ? originalAmount
        : gatewayAmountMajor;
      const paymentType = normalizeConfirmedPaymentType(payload.paymentType);

      const result = await processPaymentConfirmed(db, {
        orderId: payload.orderId,
        paymentGateway: "polar",
        paymentType,
        polarCheckoutId: payload.checkoutId,
        amount: recordAmount,
        metadata: {
          gatewayCurrency: polarCurrency,
          gatewayAmount: gatewayAmountMajor,
          exchangeRate: payload.metadata?.exchangeRate ?? "1",
          ...payload.metadata,
        },
      });
      const completionStatus = assertPaymentConfirmed(result, "polar", payload.orderId);
      if (result.success) {
        await invalidateProductAvailabilityCaches(db, { orderIds: [payload.orderId] }, { env, executionCtx });
        await enqueueOrderNotificationAfterPaymentConfirmed(db, env, {
          orderId: payload.orderId,
          gateway: "polar",
          paymentType,
          amount: recordAmount,
        });
      }
      paymentWebhookStatus = completionStatus;
      paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, {
        gateway: "polar",
        outcome: result.success ? "confirmed" : "manual_reconciliation",
        error: result.success ? null : result.error ?? null,
        recordAmount,
        gatewayAmount: gatewayAmountMajor,
        gatewayCurrency: polarCurrency,
      });
      console.log(`[Queue] Polar payment confirmed for order ${payload.orderId} (recorded: ${recordAmount}, gateway: ${gatewayAmountMajor} ${polarCurrency})`);
      break;
    }

    case "payment.polar.failed": {
      await processPaymentFailed(db, payload.orderId, "polar", payload.checkoutId);
      paymentWebhookStatus = "processed";
      paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, {
        gateway: "polar",
        outcome: "failed",
        reason: payload.reason ?? null,
      });
      console.log(`[Queue] Polar payment failed for order ${payload.orderId}`);
      break;
    }

    case "payment.polar.refunded": {
      // Unlike Stripe refunds (audit-only, since refunds are admin-initiated),
      // Polar refunds can originate from the Polar dashboard or Polar's own
      // dispute auto-refund system. We must update the DB to reflect the refund.
      const result = await processPolarWebhookRefund(db, {
        orderId: payload.orderId,
        amountRefunded: payload.amountRefunded,
        totalAmount: payload.totalAmount,
        currency: payload.currency,
        polarStatus: payload.polarStatus,
      });
      if (result.success) {
        await invalidateProductAvailabilityCaches(db, { orderIds: [payload.orderId] }, { env, executionCtx });
        await enqueueOrderRefundNotificationAfterPolarWebhook(db, env, {
          orderId: payload.orderId,
          notification: result.notification,
        });
        paymentWebhookStatus = "processed";
        paymentWebhookResult = createPaymentWebhookQueueResult(payload, msg.id, {
          gateway: "polar",
          outcome: "refunded",
          amountRefunded: payload.amountRefunded,
          totalAmount: payload.totalAmount,
          polarStatus: payload.polarStatus,
        });
        console.log(`[Queue] Polar refund processed for order ${payload.orderId} (status: ${payload.polarStatus})`);
      } else {
        throw new Error(`Polar refund failed for order ${payload.orderId}: ${result.error}`);
      }
      break;
    }

    // ── Order notifications ────────────────────────────────────────────────

    case "order.notification": {
      const outboxClaim = payload.outboxId
        ? await claimOrderNotificationOutboxForProcessing(db, payload.outboxId)
        : undefined;

      if (outboxClaim && !outboxClaim.claimed) {
        console.log(`[Queue] Skipped order notification outbox ${payload.outboxId}: ${outboxClaim.reason}`);
        break;
      }

      try {
        // Customer notifications (email, SMS, etc.)
        const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
        const customerNotificationResult = await sendOrderNotificationEmail(
          payload.customerEmail,
          payload.customerName,
          payload.orderId,
          payload.notificationType,
          payload.data,
          db,
          {
            encryptionKey,
            migrationEncryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
            env: env as unknown as Record<string, unknown>,
            outboxId: payload.outboxId,
          },
        );
        const retryableFailures: string[] = customerNotificationResult?.hasRetryableFailure
          ? [`customer channels: ${summarizeNotificationFailures(customerNotificationResult.outcomes)}`]
          : [];

        // Admin push notification — check admin channel settings before sending
        try {
          const { getAdminNotificationChannels } = await import("@scalius/core/modules/settings/settings.service");
          const adminChannels = await getAdminNotificationChannels(db);
          const enabledAdminChannels = adminChannels[payload.notificationType] || [];

          if (enabledAdminChannels.includes("push")) {
            const requestUrl = env.PUBLIC_API_BASE_URL || "https://api.scalius.com";
            const adminPushResult = await sendOrderNotification(db, {
              id: payload.orderId,
              customerName: payload.customerName,
              notificationType: payload.notificationType,
            }, env, requestUrl, {
              outboxId: payload.outboxId,
            });
            if (adminPushResult?.hasRetryableFailure) {
              retryableFailures.push(`admin push: ${summarizeNotificationFailures(adminPushResult.outcomes)}`);
            }
          }
        } catch (fcmError) {
          console.error(`[Queue] Admin notification check/send failed for ${payload.orderId}:`, fcmError);
          retryableFailures.push(`admin push: ${fcmError instanceof Error ? fcmError.message : String(fcmError)}`);
        }

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
        }
        throw error;
      }
      break;
    }

    default: {
      console.warn(`[Queue] Unknown message type:`, (payload as Record<string, unknown>).type);
    }
  }

  if (paymentWebhookStatus && paymentWebhookResult) {
    await markPaymentWebhookEventCompleted(db, msg, paymentWebhookStatus, paymentWebhookResult);
  }
}

type QueueBody = PaymentQueueMessage | AuthOtpQueueMessage | StorefrontCacheQueueMessage;
type PaymentOnlyQueueMessage = Extract<PaymentQueueMessage, { type: `payment.${string}` }>;

function isPaymentQueuePayload(payload: QueueBody): payload is PaymentOnlyQueueMessage {
  return typeof payload.type === "string" && payload.type.startsWith("payment.");
}

async function processStorefrontCachePurgeQueueMessage(
  payload: StorefrontCachePurgeQueueMessage,
  env: Env,
  executionCtx?: ExecutionContext,
): Promise<void> {
  const result = await purgeStorefrontForPrefixes(payload.prefixes, env, {
    groups: payload.groups,
    bumpVersion: payload.bumpVersion,
    exactKeys: payload.exactKeys,
    htmlPaths: payload.htmlPaths,
    operationId: payload.operationId,
    warm: false,
  });

  if (!result.attempted) {
    if (result.skippedReason === "no-prefixes" || result.skippedReason === "no-valid-groups") {
      console.warn(
        `[Queue] Ignoring empty storefront cache purge message from ${payload.source}`,
      );
      return;
    }
    throw new Error(`Storefront cache purge skipped: ${result.skippedReason ?? "unknown"}`);
  }

  if (!result.ok) {
    throw new Error(`Storefront cache purge failed with status ${result.status ?? "unknown"}`);
  }

  console.log(
    `[Queue] Storefront cache purge ${payload.operationId} completed from ${payload.source}`,
  );

  const warmMessage = createStorefrontCacheWarmMessageForPurge(payload);
  if (!warmMessage) return;

  try {
    const enqueueResult = await enqueueStorefrontCacheWarm(warmMessage, env);
    if (enqueueResult.enqueued) {
      console.log(
        `[Queue] Storefront cache warm ${warmMessage.operationId} enqueued for ${warmMessage.paths.length} path(s)`,
      );
      return;
    }

    console.warn(
      `[Queue] Storefront cache warm queue unavailable (${enqueueResult.skippedReason}); falling back to direct warm.`,
    );
  } catch (error: unknown) {
    console.error("[Queue] Failed to enqueue storefront cache warm:", error);
  }

  scheduleStorefrontWarmFallback(warmMessage, env, executionCtx);
}

function scheduleStorefrontWarmFallback(
  payload: StorefrontCacheWarmQueueMessage,
  env: Env,
  executionCtx?: ExecutionContext,
): void {
  const warmPromise = warmStorefrontHtmlPaths(payload.paths, env)
    .then((result) => {
      if (!result.ok) {
        console.warn(
          `[Queue] Storefront cache warm ${payload.operationId} fallback had retryable failures: ${result.retryableFailures.join(", ")}`,
        );
      }
    })
    .catch((error: unknown) => {
      console.error(`[Queue] Storefront cache warm ${payload.operationId} fallback failed:`, error);
    });

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(warmPromise);
  } else {
    void warmPromise;
  }
}

async function processStorefrontCacheWarmQueueMessage(
  payload: StorefrontCacheWarmQueueMessage,
  env: Env,
): Promise<void> {
  const result = await warmStorefrontHtmlPaths(payload.paths, env);

  if (!result.attempted) {
    if (result.skippedReason === "no-paths") {
      console.warn(
        `[Queue] Ignoring empty storefront cache warm message from ${payload.source}`,
      );
      return;
    }
    throw new Error(`Storefront cache warm skipped: ${result.skippedReason ?? "unknown"}`);
  }

  if (!result.ok) {
    throw new Error(
      `Storefront cache warm failed for ${result.retryableFailures.join(", ")}`,
    );
  }

  if (result.skippedFailures.length > 0) {
    console.warn(
      `[Queue] Storefront cache warm ${payload.operationId} skipped non-retryable path(s): ${result.skippedFailures.join(", ")}`,
    );
  }

  console.log(
    `[Queue] Storefront cache warm ${payload.operationId} completed from ${payload.source}: ${result.successful}/${result.paths.length} path(s) warmed`,
  );
}

function getPaymentWebhookEventId(payload: QueueBody): string | undefined {
  if (!isPaymentQueuePayload(payload)) return undefined;
  return payload.webhookEventId;
}

function createPaymentWebhookDlqEvidence(
  msg: Message<PaymentOnlyQueueMessage>,
): PaymentWebhookDlqEvidence {
  const payload = msg.body;
  const provider = getPaymentProviderFromQueueType(payload.type);
  return {
    webhookEventId: payload.webhookEventId,
    fallbackEventId: buildWebhookEventId(provider, `${payload.type}.dlq`, msg.id),
    provider,
    eventType: payload.type,
    orderId: payload.orderId,
    queueMessageId: msg.id,
    queueType: payload.type,
    attempts: msg.attempts,
    observedAtSeconds: Math.floor(Date.now() / 1000),
    messageTimestampSeconds: toUnixSeconds(msg.timestamp),
    payment: getPaymentDlqSnapshot(payload),
  };
}

function getPaymentProviderFromQueueType(type: PaymentOnlyQueueMessage["type"]): string {
  const provider = type.split(".")[1];
  return provider && PAYMENT_WEBHOOK_PROVIDER_SET.has(provider) ? provider : "unknown";
}

const PAYMENT_WEBHOOK_PROVIDER_SET = new Set(["stripe", "sslcommerz", "polar"]);

function toUnixSeconds(value: Date | number | string | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}

function getPaymentDlqSnapshot(payload: PaymentOnlyQueueMessage): Record<string, unknown> {
  switch (payload.type) {
    case "payment.stripe.confirmed":
      return {
        paymentIntentId: payload.paymentIntentId,
        amount: payload.amount,
        currency: payload.currency,
        chargeId: payload.chargeId ?? null,
        paymentType: payload.metadata?.paymentType ?? null,
      };
    case "payment.stripe.failed":
      return {
        paymentIntentId: payload.paymentIntentId,
        failureCode: payload.failureCode ?? null,
        failureMessage: payload.failureMessage ?? null,
      };
    case "payment.stripe.canceled":
      return { paymentIntentId: payload.paymentIntentId };
    case "payment.stripe.refunded":
      return {
        paymentIntentId: payload.paymentIntentId,
        amountRefunded: payload.amountRefunded,
        currency: payload.currency,
        chargeId: payload.chargeId,
        refunds: payload.refunds ?? [],
      };
    case "payment.sslcommerz.confirmed":
      return {
        tranId: payload.tranId,
        valId: payload.valId,
        bankTranId: payload.bankTranId,
        amount: payload.amount,
        currency: payload.currency,
        paymentType: payload.paymentType ?? null,
      };
    case "payment.sslcommerz.failed":
      return {
        tranId: payload.tranId,
        status: payload.status,
      };
    case "payment.polar.confirmed":
      return {
        checkoutId: payload.checkoutId,
        amount: payload.amount ?? null,
        currency: payload.currency ?? null,
        paymentType: payload.paymentType ?? null,
      };
    case "payment.polar.failed":
      return {
        checkoutId: payload.checkoutId,
        reason: payload.reason ?? null,
      };
    case "payment.polar.refunded":
      return {
        polarCheckoutId: payload.polarCheckoutId,
        amountRefunded: payload.amountRefunded,
        totalAmount: payload.totalAmount,
        currency: payload.currency,
        polarStatus: payload.polarStatus,
      };
  }
}

function createPaymentWebhookQueueResult(
  payload: PaymentOnlyQueueMessage,
  queueMessageId: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    queueMessageId,
    queueType: payload.type,
    orderId: payload.orderId,
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
  if (msg.attempts < PAYMENT_EVENTS_TERMINAL_DELIVERY_ATTEMPT) return;

  try {
    await markWebhookEventFailed(db, webhookEventId, {
      queueMessageId: msg.id,
      queueType: msg.body.type,
      orderId: isPaymentQueuePayload(msg.body) ? msg.body.orderId : null,
      terminalDeliveryAttempt: msg.attempts,
      maxRetries: PAYMENT_EVENTS_MAX_RETRIES,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch (markError) {
    console.error("[Queue] Failed to mark payment webhook event terminal failure:", markError);
  }
}

async function processAuthOtpQueueMessage(
  payload: AuthOtpQueueMessage,
  messageId: string,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<void> {
  const channel = resolveAuthOtpDeliveryChannel(payload);
  const target = await createAuthOtpDeliveryTarget({
    deliveryKey: payload.deliveryKey ?? `legacy:${messageId}`,
    purpose: payload.purpose ?? "customer_login",
    method: payload.method,
    channel,
    provider: channel,
    identifier: payload.identifier,
    otpExpiresAt: payload.otpExpiresAt ?? null,
  });
  const claim = await claimAuthOtpDeliveryReceipt(db, target);

  if (!claim.claimed) {
    if (claim.reason === "accepted" || claim.reason === "delivered" || claim.reason === "skipped") {
      console.log(`[Queue] Skipped OTP delivery ${target.deliveryKey}: already ${claim.reason}`);
      return;
    }
    throw new Error(`OTP delivery receipt ${target.deliveryKey} is ${claim.reason}`);
  }

  try {
    if (target.otpExpiresAt && target.otpExpiresAt <= Math.floor(Date.now() / 1000)) {
      await markAuthOtpDeliveryReceiptSkipped(db, claim.receipt, "otp_expired", {
        provider: target.provider,
        providerStatus: "otp_expired",
      });
      console.log(`[Queue] Skipped expired OTP delivery ${target.deliveryKey}`);
      return;
    }

    const result = await sendAuthOtpByChannel(payload, target, db, env);
    await markAuthOtpDeliveryReceiptAccepted(db, claim.receipt, result);
  } catch (error) {
    await markAuthOtpDeliveryReceiptFailed(
      db,
      claim.receipt,
      error,
      getAuthOtpDeliveryFailureResult(error),
    ).catch((markError: unknown) => {
      console.error("[Queue] Failed to mark OTP delivery receipt failure:", markError);
    });
    throw error;
  }
}

async function sendAuthOtpByChannel(
  payload: AuthOtpQueueMessage,
  target: { deliveryKey: string; channel: AuthOtpDeliveryChannel; identifierHash: string },
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  if (payload.method === "email") {
    return sendAuthOtpEmail(payload, target.deliveryKey, db, env);
  }

  if (payload.channel === "whatsapp" || payload.allowedMethod === "whatsapp_otp") {
    return sendAuthOtpWhatsApp(payload, db, env);
  }

  return sendAuthOtpSms(payload, target, db, env);
}

async function sendAuthOtpEmail(
  payload: AuthOtpQueueMessage,
  deliveryKey: string,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const safeName = escapeHtml(payload.name);
  const safeCode = escapeHtml(payload.code);
  const result = await sendEmail({
    to: payload.identifier,
    subject: "Your login code",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="font-size: 20px; margin-bottom: 8px;">Your login code</h2>
        <p style="color: #555; margin-bottom: 24px;">Hi ${safeName}, enter this code to sign in:</p>
        <div style="background: #f5f5f5; border-radius: 12px; padding: 28px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 40px; font-weight: 700; letter-spacing: 10px; font-family: monospace; color: #111;">${safeCode}</span>
        </div>
        <p style="color: #888; font-size: 13px;">This code expires in 5 minutes. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
    text: `Your login code is: ${payload.code}\n\nExpires in 5 minutes.`,
    idempotencyKey: deliveryKey,
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
    );
  }

  console.log(`[Queue] Sent OTP email to ${payload.identifier}`);
  return receiptResult;
}

async function sendAuthOtpWhatsApp(
  payload: AuthOtpQueueMessage,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const config = await getWhatsAppCloudApiSettings(db, encryptionKey, {
    migrateLegacy: true,
    migrationEncryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
  });
  if (!config.accessToken || !config.phoneNumberId) {
    throw createAuthOtpDeliveryError("WhatsApp credentials are not configured", {
      provider: "whatsapp",
      providerStatus: "missing_credentials",
    });
  }

  const result = await sendWhatsAppTemplateMessage({
    accessToken: config.accessToken,
    phoneNumberId: config.phoneNumberId,
    to: payload.identifier,
    templateName: config.authTemplateName,
    languageCode: "en_US",
    bodyParameters: [payload.code],
    buttonUrlParameter: payload.code,
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
    });
  }

  console.log(`[Queue] Sent WhatsApp OTP to ${payload.identifier}`);
  return receiptResult;
}

async function sendAuthOtpSms(
  payload: AuthOtpQueueMessage,
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
    );
  }

  const result = await smsProvider.sendSms({
    to: payload.identifier,  // Already E.164 from customers.phone
    message: `Your login code: ${payload.code}\n\nValid for 5 minutes. Do not share.`,
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
    );
  }

  console.log(`[Queue] SMS OTP sent via ${smsProvider.name} to ${payload.identifier}, ref=${result.providerRef}`);
  return receiptResult;
}

function resolveAuthOtpDeliveryChannel(payload: AuthOtpQueueMessage): AuthOtpDeliveryChannel {
  if (payload.method === "email") return "email";
  if (payload.channel === "whatsapp" || payload.allowedMethod === "whatsapp_otp") return "whatsapp";
  return "sms";
}

type AuthOtpDeliveryError = Error & {
  deliveryResult?: AuthOtpDeliveryReceiptResult;
};

function createAuthOtpDeliveryError(
  message: string,
  deliveryResult?: AuthOtpDeliveryReceiptResult,
): AuthOtpDeliveryError {
  const error = new Error(message) as AuthOtpDeliveryError;
  error.deliveryResult = deliveryResult;
  return error;
}

function getAuthOtpDeliveryFailureResult(error: unknown): AuthOtpDeliveryReceiptResult {
  if (error instanceof Error && "deliveryResult" in error) {
    return (error as AuthOtpDeliveryError).deliveryResult ?? {};
  }
  return {};
}

function summarizeNotificationFailures(
  outcomes: Array<{ channel: string; provider: string; error?: string; providerStatus?: string | null; retryable: boolean }>,
): string {
  const failures = outcomes
    .filter((outcome) => outcome.retryable)
    .map((outcome) => `${outcome.channel}/${outcome.provider}:${outcome.error ?? outcome.providerStatus ?? "retryable"}`);

  return failures.length > 0 ? failures.join(", ") : "retryable failure";
}
