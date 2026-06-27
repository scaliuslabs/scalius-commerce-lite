import { getDb } from "@scalius/database/client";
import { releaseExpiredReservations } from "@scalius/core/modules/inventory";
import { cleanupStaleAbandonedCheckouts } from "@scalius/core/modules/orders/abandoned-checkout-cleanup";
import { archiveStaleIncompleteOrders } from "@scalius/core/modules/orders/stale-incomplete-orders";
import { flushPendingOrderNotificationOutbox } from "@scalius/core/modules/notifications";
import {
  cleanupExpiredCustomerAuthOtpChallenges,
  cleanupExpiredCustomerAuthOtpRateLimits,
  cleanupExpiredCustomerSessions,
} from "@scalius/core/modules/customers/customer-auth.service";
import { cleanupExpiredScannerTokenClaims } from "@scalius/core/auth";
import { reconcileDueRefundAttempts } from "@scalius/core/modules/payments";
import { getCredentialEncryptionKey } from "./utils/encryption-key";
import { invalidateProductAvailabilityCaches } from "./utils/cache-invalidation";
import { failStaleQueuedPaymentWebhookEvents } from "./utils/webhook-idempotency";

export const INVENTORY_EXPIRY_SWEEP_LIMIT = 50;
export const STALE_INCOMPLETE_ORDER_SWEEP_LIMIT = 25;
export const STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES = 60;
export const ABANDONED_CHECKOUT_SWEEP_LIMIT = 100;
export const ABANDONED_CHECKOUT_RETENTION_DAYS = 30;
export const EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES = 60;
export const ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT = 10;
export const CUSTOMER_AUTH_OTP_SWEEP_LIMIT = 200;
export const CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT = 200;
export const CUSTOMER_SESSION_SWEEP_LIMIT = 200;
export const SCANNER_TOKEN_CLAIM_SWEEP_LIMIT = 200;
export const REFUND_ATTEMPT_RECONCILIATION_LIMIT = 5;
export const STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT = 25;
export const STALE_QUEUED_PAYMENT_WEBHOOK_MAX_AGE_MINUTES = 6 * 60;

export async function runScheduledMaintenance(env: Env, executionCtx: ExecutionContext): Promise<void> {
  const db = getDb(env);
  const result = await releaseExpiredReservations(db, 30, {
    limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
  });
  if (result.releasedVariantIds.length > 0) {
    await invalidateProductAvailabilityCaches(
      db,
      { variantIds: result.releasedVariantIds },
      { env, executionCtx },
    );
  }

  const staleIncompleteCutoff = Math.floor(Date.now() / 1000) - STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES * 60;
  const staleIncompleteOrders = await archiveStaleIncompleteOrders(db, staleIncompleteCutoff, {
    limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
  });
  if (staleIncompleteOrders.archivedOrderIds.length > 0) {
    await invalidateProductAvailabilityCaches(
      db,
      { orderIds: staleIncompleteOrders.archivedOrderIds },
      { env, executionCtx },
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

  const abandonedCheckoutCleanup = await cleanupStaleAbandonedCheckouts(db, Math.floor(Date.now() / 1000), {
    retentionDays: ABANDONED_CHECKOUT_RETENTION_DAYS,
    emptyMaxAgeMinutes: EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES,
    limit: ABANDONED_CHECKOUT_SWEEP_LIMIT,
  });
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

  const notificationOutbox = await flushPendingOrderNotificationOutbox({
    db,
    queue: env.ORDER_NOTIFICATIONS_QUEUE,
    limit: ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT,
  });
  if (notificationOutbox.scanned > 0 || notificationOutbox.failed > 0) {
    console.log(
      `[scheduled] Notification outbox flush: scanned=${notificationOutbox.scanned}, ` +
        `enqueued=${notificationOutbox.enqueued}, failed=${notificationOutbox.failed}, skipped=${notificationOutbox.skipped}`,
    );
  }

  const refundReconciliation = await reconcileDueRefundAttempts(db, env.CACHE, {
    encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
    limit: REFUND_ATTEMPT_RECONCILIATION_LIMIT,
  });
  if (refundReconciliation.finalizedOrderIds.length > 0) {
    await invalidateProductAvailabilityCaches(
      db,
      { orderIds: refundReconciliation.finalizedOrderIds },
      { env, executionCtx },
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

  const staleQueuedPaymentWebhookCutoff =
    Math.floor(Date.now() / 1000) - STALE_QUEUED_PAYMENT_WEBHOOK_MAX_AGE_MINUTES * 60;
  const staleQueuedPaymentWebhooks = await failStaleQueuedPaymentWebhookEvents(
    db,
    staleQueuedPaymentWebhookCutoff,
    { limit: STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT },
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

  const customerAuthOtpCleanup = await cleanupExpiredCustomerAuthOtpChallenges(db, Math.floor(Date.now() / 1000), {
    limit: CUSTOMER_AUTH_OTP_SWEEP_LIMIT,
  });
  if (customerAuthOtpCleanup.scanned > 0 || customerAuthOtpCleanup.hasMore) {
    console.log(
      `[scheduled] Customer auth OTP cleanup: scanned=${customerAuthOtpCleanup.scanned}, ` +
        `deleted=${customerAuthOtpCleanup.deleted}, limit=${customerAuthOtpCleanup.limit}, ` +
        `hasMore=${customerAuthOtpCleanup.hasMore}`,
    );
  }

  const customerAuthOtpRateLimitCleanup = await cleanupExpiredCustomerAuthOtpRateLimits(db, Math.floor(Date.now() / 1000), {
    limit: CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT,
  });
  if (customerAuthOtpRateLimitCleanup.scanned > 0 || customerAuthOtpRateLimitCleanup.hasMore) {
    console.log(
      `[scheduled] Customer auth OTP rate-limit cleanup: scanned=${customerAuthOtpRateLimitCleanup.scanned}, ` +
        `deleted=${customerAuthOtpRateLimitCleanup.deleted}, limit=${customerAuthOtpRateLimitCleanup.limit}, ` +
        `hasMore=${customerAuthOtpRateLimitCleanup.hasMore}`,
    );
  }

  const customerSessionCleanup = await cleanupExpiredCustomerSessions(db, Math.floor(Date.now() / 1000), {
    limit: CUSTOMER_SESSION_SWEEP_LIMIT,
  });
  if (customerSessionCleanup.scanned > 0 || customerSessionCleanup.hasMore) {
    console.log(
      `[scheduled] Customer session cleanup: scanned=${customerSessionCleanup.scanned}, ` +
        `deleted=${customerSessionCleanup.deleted}, limit=${customerSessionCleanup.limit}, ` +
        `hasMore=${customerSessionCleanup.hasMore}`,
    );
  }

  const scannerTokenClaimsCleanup = await cleanupExpiredScannerTokenClaims(db, {
    nowSeconds: Math.floor(Date.now() / 1000),
    limit: SCANNER_TOKEN_CLAIM_SWEEP_LIMIT,
  });
  if (scannerTokenClaimsCleanup.scanned > 0 || scannerTokenClaimsCleanup.hasMore) {
    console.log(
      `[scheduled] Scanner token claim cleanup: scanned=${scannerTokenClaimsCleanup.scanned}, ` +
        `deleted=${scannerTokenClaimsCleanup.deleted}, limit=${scannerTokenClaimsCleanup.limit}, ` +
        `hasMore=${scannerTokenClaimsCleanup.hasMore}`,
    );
  }
}
