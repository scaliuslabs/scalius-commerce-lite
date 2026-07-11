import { getDb } from "@scalius/database/client";
import { releaseExpiredReservations } from "@scalius/core/modules/inventory";
import { cleanupStaleAbandonedCheckouts } from "@scalius/core/modules/orders/abandoned-checkout-cleanup";
import { cleanupExpiredOrderPaymentRecoveryChallenges } from "@scalius/core/modules/orders";
import { archiveStaleIncompleteOrders } from "@scalius/core/modules/orders/stale-incomplete-orders";
import { flushPendingOrderNotificationOutbox } from "@scalius/core/modules/notifications";
import { flushPendingMetaPurchaseOutbox } from "@scalius/core/integrations/meta/purchase-outbox";
import {
  cleanupExpiredCustomerAuthOtpChallenges,
  cleanupExpiredCustomerAuthOtpRateLimits,
  cleanupExpiredCustomerSessions,
} from "@scalius/core/modules/customers/customer-auth.service";
import { cleanupExpiredScannerTokenClaims } from "@scalius/core/auth";
import { reconcileDueRefundAttempts, reconcileStripeExternalRefundWebhooks } from "@scalius/core/modules/payments";
import { getCredentialEncryptionKey } from "./utils/encryption-key";
import { invalidateProductAvailabilityCaches } from "./utils/cache-invalidation";
import { failStaleQueuedPaymentWebhookEvents } from "./utils/webhook-idempotency";
import { enqueueOrderRefundNotificationForOrder } from "./utils/order-notification-queue";

export const INVENTORY_EXPIRY_SWEEP_LIMIT = 50;
export const STALE_INCOMPLETE_ORDER_SWEEP_LIMIT = 25;
export const STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES = 60;
export const ABANDONED_CHECKOUT_SWEEP_LIMIT = 100;
export const ABANDONED_CHECKOUT_RETENTION_DAYS = 30;
export const EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES = 60;
export const ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT = 10;
export const META_PURCHASE_OUTBOX_SWEEP_LIMIT = 10;
export const CUSTOMER_AUTH_OTP_SWEEP_LIMIT = 200;
export const ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT = 200;
export const CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT = 200;
export const CUSTOMER_SESSION_SWEEP_LIMIT = 200;
export const SCANNER_TOKEN_CLAIM_SWEEP_LIMIT = 200;
export const REFUND_ATTEMPT_RECONCILIATION_LIMIT = 5;
export const STRIPE_EXTERNAL_REFUND_RECONCILIATION_LIMIT = 5;
export const STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT = 25;
export const STALE_QUEUED_PAYMENT_WEBHOOK_MAX_AGE_MINUTES = 6 * 60;

type ScheduledMaintenanceMetadata = {
  cron?: string;
  scheduledTime?: number;
};

type ScheduledRunContext = {
  runId: string;
  startedAt: number;
  cron: string;
  scheduledTime: string;
};

function createScheduledRunContext(metadata: ScheduledMaintenanceMetadata): ScheduledRunContext {
  const startedAt = Date.now();
  const scheduledDate = typeof metadata.scheduledTime === "number"
    ? new Date(metadata.scheduledTime)
    : null;
  const scheduledTime = scheduledDate && !Number.isNaN(scheduledDate.getTime())
    ? scheduledDate.toISOString()
    : "unknown";

  return {
    runId: `sched_${startedAt.toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
    startedAt,
    cron: metadata.cron ?? "unknown",
    scheduledTime,
  };
}

async function timedScheduledOperation<T>(
  runContext: ScheduledRunContext,
  operation: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    console.log(
      `[scheduled] event=scheduled_operation_completed, runId=${runContext.runId}, operation=${operation}, ` +
        `durationMs=${Date.now() - startedAt}`,
    );
    return result;
  } catch (error) {
    console.error(
      `[scheduled] event=scheduled_operation_failed, runId=${runContext.runId}, operation=${operation}, ` +
        `durationMs=${Date.now() - startedAt}`,
      error,
    );
    throw error;
  }
}

async function enqueueReconciledRefundNotifications(
  db: ReturnType<typeof getDb>,
  env: Env,
  notifications: Array<{
    orderId: string;
    notificationType: "refund_processing" | "refund_failed" | "order_refunded" | "order_partially_refunded";
    dedupeKey: string;
    amount: number;
    refundId?: string;
  }>,
): Promise<void> {
  for (const notification of notifications) {
    const result = await enqueueOrderRefundNotificationForOrder({
      db,
      queue: env.ORDER_NOTIFICATIONS_QUEUE,
      orderId: notification.orderId,
      notificationType: notification.notificationType,
      dedupeKey: notification.dedupeKey,
      source: "refund-reconciliation",
      data: {
        amount: notification.amount,
        ...(notification.refundId ? { refundId: notification.refundId } : {}),
      },
    });

    if (!result.enqueued) {
      console.log(
        `[scheduled] Reconciled refund notification for order ${notification.orderId} ` +
          `recorded but not enqueued: ${result.skippedReason}`,
      );
    }
  }
}

export async function runScheduledMaintenance(
  env: Env,
  executionCtx: ExecutionContext,
  metadata: ScheduledMaintenanceMetadata = {},
): Promise<void> {
  const runContext = createScheduledRunContext(metadata);
  console.log(
    `[scheduled] event=scheduled_run_started, runId=${runContext.runId}, cron=${runContext.cron}, ` +
      `scheduledTime=${runContext.scheduledTime}`,
  );

  try {
    await runScheduledMaintenanceInner(env, executionCtx, runContext);
    console.log(
      `[scheduled] event=scheduled_run_completed, runId=${runContext.runId}, durationMs=${Date.now() - runContext.startedAt}`,
    );
  } catch (error) {
    console.error(
      `[scheduled] event=scheduled_run_failed, runId=${runContext.runId}, durationMs=${Date.now() - runContext.startedAt}`,
      error,
    );
    throw error;
  }
}

async function runScheduledMaintenanceInner(
  env: Env,
  executionCtx: ExecutionContext,
  runContext: ScheduledRunContext,
): Promise<void> {
  const db = getDb(env);
  const timed = <T>(operation: string, fn: () => Promise<T>) =>
    timedScheduledOperation(runContext, operation, fn);

  const result = await timed("inventory_expiry_sweep", () =>
    releaseExpiredReservations(db, 30, {
      limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
    }),
  );
  if (result.releasedVariantIds.length > 0) {
    await timed("inventory_expiry_availability_invalidation", () =>
      invalidateProductAvailabilityCaches(
        db,
        { variantIds: result.releasedVariantIds },
        { env, executionCtx },
      ),
    );
  }

  const staleIncompleteCutoff = Math.floor(Date.now() / 1000) - STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES * 60;
  const staleIncompleteOrders = await timed("stale_incomplete_order_cleanup", () =>
    archiveStaleIncompleteOrders(db, staleIncompleteCutoff, {
      limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
    }),
  );
  if (staleIncompleteOrders.archivedOrderIds.length > 0) {
    await timed("stale_incomplete_order_availability_invalidation", () =>
      invalidateProductAvailabilityCaches(
        db,
        { orderIds: staleIncompleteOrders.archivedOrderIds },
        { env, executionCtx },
      ),
    );
  }
  if (
    staleIncompleteOrders.found > 0 ||
    staleIncompleteOrders.failed > 0 ||
    staleIncompleteOrders.hasMore
  ) {
    console.log(
      `[scheduled] Stale incomplete order cleanup: found=${staleIncompleteOrders.found}, ` +
        `archived=${staleIncompleteOrders.archived}, failed=${staleIncompleteOrders.failed}, ` +
        `limit=${staleIncompleteOrders.limit}, hasMore=${staleIncompleteOrders.hasMore}`,
    );
  }

  console.log(
    `[scheduled] Inventory expiry sweep: found=${result.found}, released=${result.released}` +
      `, limit=${result.limit}, hasMore=${result.hasMore}` +
      (result.errors.length > 0 ? `, errors=${result.errors.length}` : ""),
  );

  const abandonedCheckoutCleanup = await timed("abandoned_checkout_cleanup", () =>
    cleanupStaleAbandonedCheckouts(db, Math.floor(Date.now() / 1000), {
      retentionDays: ABANDONED_CHECKOUT_RETENTION_DAYS,
      emptyMaxAgeMinutes: EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES,
      limit: ABANDONED_CHECKOUT_SWEEP_LIMIT,
    }),
  );
  if (
    abandonedCheckoutCleanup.scannedExpired > 0 ||
    abandonedCheckoutCleanup.deletedExpired > 0 ||
    abandonedCheckoutCleanup.scannedEmpty > 0 ||
    abandonedCheckoutCleanup.deletedEmpty > 0 ||
    abandonedCheckoutCleanup.hasMore
  ) {
    console.log(
      `[scheduled] Abandoned checkout cleanup: scannedExpired=${abandonedCheckoutCleanup.scannedExpired}, ` +
        `deletedExpired=${abandonedCheckoutCleanup.deletedExpired}, ` +
        `scannedEmpty=${abandonedCheckoutCleanup.scannedEmpty}, ` +
        `deletedEmpty=${abandonedCheckoutCleanup.deletedEmpty}, ` +
        `limit=${abandonedCheckoutCleanup.limit}, hasMore=${abandonedCheckoutCleanup.hasMore}`,
    );
  }

  const notificationOutbox = await timed("notification_outbox_flush", () =>
    flushPendingOrderNotificationOutbox({
      db,
      queue: env.ORDER_NOTIFICATIONS_QUEUE,
      limit: ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT,
    }),
  );
  if (
    notificationOutbox.scanned > 0 ||
    notificationOutbox.failed > 0 ||
    notificationOutbox.staleQueued > 0
  ) {
    console.log(
      `[scheduled] Notification outbox flush: scanned=${notificationOutbox.scanned}, ` +
        `enqueued=${notificationOutbox.enqueued}, failed=${notificationOutbox.failed}, ` +
        `skipped=${notificationOutbox.skipped}, staleQueued=${notificationOutbox.staleQueued}`,
    );
  }

  const metaPurchaseOutbox = await timed("meta_purchase_outbox_flush", () =>
    flushPendingMetaPurchaseOutbox({
      db,
      storefrontUrl: env.STOREFRONT_URL,
      encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
      limit: META_PURCHASE_OUTBOX_SWEEP_LIMIT,
    }),
  );
  if (
    metaPurchaseOutbox.scanned > 0 ||
    metaPurchaseOutbox.failed > 0 ||
    metaPurchaseOutbox.skipped > 0 ||
    metaPurchaseOutbox.busy > 0
  ) {
    console.log(
      `[scheduled] Meta Purchase outbox flush: scanned=${metaPurchaseOutbox.scanned}, ` +
        `sent=${metaPurchaseOutbox.sent}, failed=${metaPurchaseOutbox.failed}, ` +
        `skipped=${metaPurchaseOutbox.skipped}, busy=${metaPurchaseOutbox.busy}`,
    );
  }

  const refundReconciliation = await timed("refund_attempt_reconciliation", () =>
    reconcileDueRefundAttempts(db, env.CACHE, {
      encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
      limit: REFUND_ATTEMPT_RECONCILIATION_LIMIT,
    }),
  );
  if (refundReconciliation.finalizedOrderIds.length > 0) {
    await timed("refund_reconciliation_availability_invalidation", () =>
      invalidateProductAvailabilityCaches(
        db,
        { orderIds: refundReconciliation.finalizedOrderIds },
        { env, executionCtx },
      ),
    );
  }
  if (refundReconciliation.refundNotifications.length > 0) {
    await timed("refund_reconciliation_notification_enqueue", () =>
      enqueueReconciledRefundNotifications(db, env, refundReconciliation.refundNotifications),
    );
  }
  if (
    refundReconciliation.scanned > 0 ||
    refundReconciliation.failed > 0 ||
    refundReconciliation.deferred > 0 ||
    refundReconciliation.errors.length > 0 ||
    refundReconciliation.hasMore
  ) {
    console.log(
      `[scheduled] Refund reconciliation: scanned=${refundReconciliation.scanned}, ` +
        `claimed=${refundReconciliation.claimed}, finalized=${refundReconciliation.finalized}, ` +
        `failed=${refundReconciliation.failed}, deferred=${refundReconciliation.deferred}, ` +
        `errors=${refundReconciliation.errors.length}, limit=${refundReconciliation.limit}, ` +
        `hasMore=${refundReconciliation.hasMore}`,
    );
  }

  const stripeExternalRefunds = await timed("stripe_external_refund_reconciliation", () =>
    reconcileStripeExternalRefundWebhooks(db, env.CACHE, {
      encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
      limit: STRIPE_EXTERNAL_REFUND_RECONCILIATION_LIMIT,
    }),
  );
  if (stripeExternalRefunds.finalizedOrderIds.length > 0) {
    await timed("stripe_external_refund_availability_invalidation", () =>
      invalidateProductAvailabilityCaches(
        db,
        { orderIds: stripeExternalRefunds.finalizedOrderIds },
        { env, executionCtx },
      ),
    );
  }
  if (stripeExternalRefunds.refundNotifications.length > 0) {
    await timed("stripe_external_refund_notification_enqueue", () =>
      enqueueReconciledRefundNotifications(db, env, stripeExternalRefunds.refundNotifications),
    );
  }
  if (
    stripeExternalRefunds.scanned > 0 ||
    stripeExternalRefunds.imported > 0 ||
    stripeExternalRefunds.deferred > 0 ||
    stripeExternalRefunds.errors.length > 0 ||
    stripeExternalRefunds.hasMore
  ) {
    console.log(
      `[scheduled] Stripe external refund reconciliation: scanned=${stripeExternalRefunds.scanned}, ` +
        `imported=${stripeExternalRefunds.imported}, finalized=${stripeExternalRefunds.finalized}, ` +
        `skipped=${stripeExternalRefunds.skipped}, deferred=${stripeExternalRefunds.deferred}, ` +
        `errors=${stripeExternalRefunds.errors.length}, limit=${stripeExternalRefunds.limit}, ` +
        `hasMore=${stripeExternalRefunds.hasMore}`,
    );
  }

  const staleQueuedPaymentWebhookCutoff =
    Math.floor(Date.now() / 1000) - STALE_QUEUED_PAYMENT_WEBHOOK_MAX_AGE_MINUTES * 60;
  const staleQueuedPaymentWebhooks = await timed("stale_queued_payment_webhook_sweep", () =>
    failStaleQueuedPaymentWebhookEvents(
      db,
      staleQueuedPaymentWebhookCutoff,
      { limit: STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT },
    ),
  );
  if (
    staleQueuedPaymentWebhooks.scanned > 0 ||
    staleQueuedPaymentWebhooks.failed > 0 ||
    staleQueuedPaymentWebhooks.hasMore
  ) {
    console.log(
      `[scheduled] Stale queued payment webhook sweep: scanned=${staleQueuedPaymentWebhooks.scanned}, ` +
        `failed=${staleQueuedPaymentWebhooks.failed}, limit=${staleQueuedPaymentWebhooks.limit}, ` +
        `hasMore=${staleQueuedPaymentWebhooks.hasMore}`,
    );
  }

  const customerAuthOtpCleanup = await timed("customer_auth_otp_challenge_cleanup", () =>
    cleanupExpiredCustomerAuthOtpChallenges(db, Math.floor(Date.now() / 1000), {
      limit: CUSTOMER_AUTH_OTP_SWEEP_LIMIT,
    }),
  );
  if (customerAuthOtpCleanup.scanned > 0 || customerAuthOtpCleanup.hasMore) {
    console.log(
      `[scheduled] Customer auth OTP cleanup: scanned=${customerAuthOtpCleanup.scanned}, ` +
        `deleted=${customerAuthOtpCleanup.deleted}, limit=${customerAuthOtpCleanup.limit}, ` +
        `hasMore=${customerAuthOtpCleanup.hasMore}`,
    );
  }

  const paymentRecoveryOtpCleanup = await timed("order_payment_recovery_otp_cleanup", () =>
    cleanupExpiredOrderPaymentRecoveryChallenges(db, Math.floor(Date.now() / 1000), {
      limit: ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT,
    }),
  );
  if (paymentRecoveryOtpCleanup.scanned > 0 || paymentRecoveryOtpCleanup.hasMore) {
    console.log(
      `[scheduled] Order payment recovery OTP cleanup: scanned=${paymentRecoveryOtpCleanup.scanned}, ` +
        `deleted=${paymentRecoveryOtpCleanup.deleted}, limit=${paymentRecoveryOtpCleanup.limit}, ` +
        `hasMore=${paymentRecoveryOtpCleanup.hasMore}`,
    );
  }

  const customerAuthOtpRateLimitCleanup = await timed("customer_auth_otp_rate_limit_cleanup", () =>
    cleanupExpiredCustomerAuthOtpRateLimits(db, Math.floor(Date.now() / 1000), {
      limit: CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT,
    }),
  );
  if (customerAuthOtpRateLimitCleanup.scanned > 0 || customerAuthOtpRateLimitCleanup.hasMore) {
    console.log(
      `[scheduled] Customer auth OTP rate-limit cleanup: scanned=${customerAuthOtpRateLimitCleanup.scanned}, ` +
        `deleted=${customerAuthOtpRateLimitCleanup.deleted}, limit=${customerAuthOtpRateLimitCleanup.limit}, ` +
        `hasMore=${customerAuthOtpRateLimitCleanup.hasMore}`,
    );
  }

  const customerSessionCleanup = await timed("customer_session_cleanup", () =>
    cleanupExpiredCustomerSessions(db, Math.floor(Date.now() / 1000), {
      limit: CUSTOMER_SESSION_SWEEP_LIMIT,
    }),
  );
  if (customerSessionCleanup.scanned > 0 || customerSessionCleanup.hasMore) {
    console.log(
      `[scheduled] Customer session cleanup: scanned=${customerSessionCleanup.scanned}, ` +
        `deleted=${customerSessionCleanup.deleted}, limit=${customerSessionCleanup.limit}, ` +
        `hasMore=${customerSessionCleanup.hasMore}`,
    );
  }

  const scannerTokenClaimsCleanup = await timed("scanner_token_claim_cleanup", () =>
    cleanupExpiredScannerTokenClaims(db, {
      nowSeconds: Math.floor(Date.now() / 1000),
      limit: SCANNER_TOKEN_CLAIM_SWEEP_LIMIT,
    }),
  );
  if (scannerTokenClaimsCleanup.scanned > 0 || scannerTokenClaimsCleanup.hasMore) {
    console.log(
      `[scheduled] Scanner token claim cleanup: scanned=${scannerTokenClaimsCleanup.scanned}, ` +
        `deleted=${scannerTokenClaimsCleanup.deleted}, limit=${scannerTokenClaimsCleanup.limit}, ` +
        `hasMore=${scannerTokenClaimsCleanup.hasMore}`,
    );
  }
}
