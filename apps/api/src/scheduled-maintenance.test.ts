import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = { id: "db" };
  return {
    db,
    getDb: vi.fn(() => db),
    releaseExpiredReservations: vi.fn(),
    cleanupStaleAbandonedCheckouts: vi.fn(),
    cleanupExpiredOrderPaymentRecoveryChallenges: vi.fn(),
    archiveStaleIncompleteOrders: vi.fn(),
    flushPendingNotificationOutbox: vi.fn(),
    flushPendingMetaPurchaseOutbox: vi.fn(),
    cleanupExpiredCustomerAuthOtpChallenges: vi.fn(),
    cleanupExpiredCustomerAuthOtpRateLimits: vi.fn(),
    cleanupExpiredCustomerSessions: vi.fn(),
    cleanupExpiredScannerTokenClaims: vi.fn(),
    pruneExpiredIdentityHandoffEvents: vi.fn(),
    reconcileDueRefundAttempts: vi.fn(),
    reconcileExternalRefundWebhooks: vi.fn(),
    bumpCacheGeneration: vi.fn(),
    syncCacheGenerationMirror: vi.fn(),
    enqueueOrderRefundNotificationForOrder: vi.fn(),
    failStaleQueuedPaymentWebhookEvents: vi.fn(),
    backfillMissingMediaVariants: vi.fn(),
  };
});

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@scalius/core/modules/inventory", () => ({
  releaseExpiredReservations: mocks.releaseExpiredReservations,
}));

vi.mock("@scalius/core/modules/checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/checkout")>()),
  cleanupStaleAbandonedCheckouts: mocks.cleanupStaleAbandonedCheckouts,
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/orders")>()),
  archiveStaleIncompleteOrders: mocks.archiveStaleIncompleteOrders,
  cleanupExpiredOrderPaymentRecoveryChallenges: mocks.cleanupExpiredOrderPaymentRecoveryChallenges,
}));

vi.mock("@scalius/core/modules/notifications", () => ({
  flushPendingNotificationOutbox: mocks.flushPendingNotificationOutbox,
}));

vi.mock("@scalius/core/integrations/meta/purchase-outbox", () => ({
  flushPendingMetaPurchaseOutbox: mocks.flushPendingMetaPurchaseOutbox,
}));

vi.mock("@scalius/core/modules/customers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/customers")>()),
  cleanupExpiredCustomerAuthOtpChallenges: mocks.cleanupExpiredCustomerAuthOtpChallenges,
  cleanupExpiredCustomerAuthOtpRateLimits: mocks.cleanupExpiredCustomerAuthOtpRateLimits,
  cleanupExpiredCustomerSessions: mocks.cleanupExpiredCustomerSessions,
}));

vi.mock("@scalius/core/auth", () => ({
  cleanupExpiredScannerTokenClaims: mocks.cleanupExpiredScannerTokenClaims,
  pruneExpiredIdentityHandoffEvents: mocks.pruneExpiredIdentityHandoffEvents,
}));

vi.mock("@scalius/core/modules/payments", () => ({
  reconcileDueRefundAttempts: mocks.reconcileDueRefundAttempts,
  reconcileExternalRefundWebhooks: mocks.reconcileExternalRefundWebhooks,
}));

vi.mock("@scalius/core/modules/media", () => ({
  backfillMissingMediaVariants: mocks.backfillMissingMediaVariants,
}));

vi.mock("./utils/cache-generation", () => ({
  bumpCacheGeneration: mocks.bumpCacheGeneration,
  syncCacheGenerationMirror: mocks.syncCacheGenerationMirror,
}));

vi.mock("./utils/order-notification-queue", () => ({
  enqueueOrderRefundNotificationForOrder: mocks.enqueueOrderRefundNotificationForOrder,
}));

vi.mock("./utils/webhook-idempotency", () => ({
  failStaleQueuedPaymentWebhookEvents: mocks.failStaleQueuedPaymentWebhookEvents,
}));

import {
  ABANDONED_CHECKOUT_RETENTION_DAYS,
  ABANDONED_CHECKOUT_SWEEP_LIMIT,
  EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES,
  INVENTORY_EXPIRY_SWEEP_LIMIT,
  MEDIA_RENDITION_BACKFILL_CONCURRENCY,
  MEDIA_RENDITION_BACKFILL_DEADLINE_MS,
  MEDIA_RENDITION_BACKFILL_MAX_PER_RUN,
  CUSTOMER_AUTH_OTP_SWEEP_LIMIT,
  CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT,
  CUSTOMER_SESSION_SWEEP_LIMIT,
  META_PURCHASE_OUTBOX_SWEEP_LIMIT,
  ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT,
  ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT,
  REFUND_ATTEMPT_RECONCILIATION_LIMIT,
  SCANNER_TOKEN_CLAIM_SWEEP_LIMIT,
  EXTERNAL_REFUND_RECONCILIATION_LIMIT,
  STALE_QUEUED_PAYMENT_WEBHOOK_MAX_AGE_MINUTES,
  STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT,
  STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES,
  STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
  runScheduledMaintenance,
} from "./scheduled-maintenance";

function createEnv() {
  return {
    BUCKET: { id: "generated-media-bucket" },
    JOBS_QUEUE: {
      send: vi.fn(),
    },
  } as unknown as Env;
}

function createExecutionContext() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe("runScheduledMaintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.releaseExpiredReservations.mockResolvedValue({
      found: 0,
      released: 0,
      limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
      hasMore: false,
      releasedVariantIds: [],
      availabilityTransitionVariantIds: [],
      errors: [],
    });
    mocks.archiveStaleIncompleteOrders.mockResolvedValue({
      found: 0,
      limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
      hasMore: false,
      archived: 0,
      failed: 0,
      archivedOrderIds: [],
      errors: [],
    });
    mocks.cleanupStaleAbandonedCheckouts.mockResolvedValue({
      scannedExpired: 0,
      deletedExpired: 0,
      scannedEmpty: 0,
      deletedEmpty: 0,
      limit: ABANDONED_CHECKOUT_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.flushPendingNotificationOutbox.mockResolvedValue({
      scanned: 0,
      enqueued: 0,
      failed: 0,
      skipped: 0,
      staleQueued: 0,
    });
    mocks.flushPendingMetaPurchaseOutbox.mockResolvedValue({
      scanned: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      busy: 0,
    });
    mocks.syncCacheGenerationMirror.mockResolvedValue(false);
    mocks.cleanupExpiredCustomerAuthOtpChallenges.mockResolvedValue({
      scanned: 0,
      deleted: 0,
      limit: CUSTOMER_AUTH_OTP_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.cleanupExpiredOrderPaymentRecoveryChallenges.mockResolvedValue({
      scanned: 0,
      deleted: 0,
      limit: ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.cleanupExpiredCustomerAuthOtpRateLimits.mockResolvedValue({
      scanned: 0,
      deleted: 0,
      limit: CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.cleanupExpiredCustomerSessions.mockResolvedValue({
      scanned: 0,
      deleted: 0,
      limit: CUSTOMER_SESSION_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.cleanupExpiredScannerTokenClaims.mockResolvedValue({
      scanned: 0,
      deleted: 0,
      limit: SCANNER_TOKEN_CLAIM_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.pruneExpiredIdentityHandoffEvents.mockResolvedValue(0);
    mocks.reconcileDueRefundAttempts.mockResolvedValue({
      scanned: 0,
      claimed: 0,
      finalized: 0,
      failed: 0,
      deferred: 0,
      errors: [],
      finalizedOrderIds: [],
      refundNotifications: [],
      limit: REFUND_ATTEMPT_RECONCILIATION_LIMIT,
      hasMore: false,
    });
    mocks.reconcileExternalRefundWebhooks.mockResolvedValue({
      scanned: 0,
      imported: 0,
      finalized: 0,
      skipped: 0,
      deferred: 0,
      errors: [],
      finalizedOrderIds: [],
      refundNotifications: [],
      limit: EXTERNAL_REFUND_RECONCILIATION_LIMIT,
      hasMore: false,
    });
    mocks.enqueueOrderRefundNotificationForOrder.mockResolvedValue({
      orderId: "order_refunded",
      outboxId: "outbox_refund_1",
      enqueued: true,
    });
    mocks.failStaleQueuedPaymentWebhookEvents.mockResolvedValue({
      scanned: 0,
      failed: 0,
      limit: STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.backfillMissingMediaVariants.mockResolvedValue({ scanned: 0, generated: 0, failed: 0, hasMore: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs inventory expiry, the cache generation mirror sync, and bounded outbox recovery", async () => {
    const now = new Date("2026-06-20T12:00:00.000Z");
    vi.setSystemTime(now);
    const env = createEnv();
    const executionCtx = createExecutionContext();

    mocks.releaseExpiredReservations.mockResolvedValue({
      found: 2,
      released: 1,
      limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
      hasMore: false,
      releasedVariantIds: ["variant_1"],
      availabilityTransitionVariantIds: ["variant_1"],
      errors: [],
    });
    mocks.archiveStaleIncompleteOrders.mockResolvedValue({
      found: 1,
      limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
      hasMore: false,
      archived: 1,
      failed: 0,
      archivedOrderIds: ["order_1"],
      errors: [],
    });
    mocks.cleanupStaleAbandonedCheckouts.mockResolvedValue({
      scannedExpired: 2,
      deletedExpired: 1,
      scannedEmpty: 3,
      deletedEmpty: 2,
      limit: ABANDONED_CHECKOUT_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.flushPendingNotificationOutbox.mockResolvedValue({
      scanned: 1,
      enqueued: 1,
      failed: 0,
      skipped: 0,
      staleQueued: 1,
    });
    mocks.flushPendingMetaPurchaseOutbox.mockResolvedValue({
      scanned: 2,
      sent: 1,
      failed: 0,
      skipped: 1,
      busy: 0,
    });
    mocks.reconcileDueRefundAttempts.mockResolvedValue({
      scanned: 1,
      claimed: 1,
      finalized: 1,
      failed: 0,
      deferred: 0,
      errors: [],
      finalizedOrderIds: ["order_refunded"],
      refundNotifications: [{
        orderId: "order_refunded",
        notificationType: "order_refunded",
        dedupeKey: "refund-reconcile:order_refunded:rfa_1:full",
        amount: 100,
        refundId: "re_1",
      }, {
        orderId: "order_processing",
        notificationType: "refund_processing",
        dedupeKey: "refund:order_processing:refund_order_processing_2:processing",
        amount: 40,
        refundId: "re_pending",
      }, {
        orderId: "order_failed",
        notificationType: "refund_failed",
        dedupeKey: "refund:order_failed:refund_order_failed_2:failed",
        amount: 40,
        refundId: "re_failed",
      }],
      limit: REFUND_ATTEMPT_RECONCILIATION_LIMIT,
      hasMore: false,
    });
    mocks.failStaleQueuedPaymentWebhookEvents.mockResolvedValue({
      scanned: 2,
      failed: 2,
      limit: STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.cleanupExpiredCustomerAuthOtpChallenges.mockResolvedValue({
      scanned: 2,
      deleted: 2,
      limit: CUSTOMER_AUTH_OTP_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.cleanupExpiredOrderPaymentRecoveryChallenges.mockResolvedValue({
      scanned: 2,
      deleted: 2,
      limit: ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.cleanupExpiredCustomerAuthOtpRateLimits.mockResolvedValue({
      scanned: 2,
      deleted: 2,
      limit: CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.cleanupExpiredScannerTokenClaims.mockResolvedValue({
      scanned: 2,
      deleted: 2,
      limit: SCANNER_TOKEN_CLAIM_SWEEP_LIMIT,
      hasMore: false,
    });
    mocks.pruneExpiredIdentityHandoffEvents.mockResolvedValue(3);
    mocks.cleanupExpiredCustomerSessions.mockResolvedValue({
      scanned: 2,
      deleted: 2,
      limit: CUSTOMER_SESSION_SWEEP_LIMIT,
      hasMore: false,
    });

    await runScheduledMaintenance(env, executionCtx, {
      cron: "*/15 * * * *",
      scheduledTime: now.getTime(),
    });

    expect(mocks.getDb).toHaveBeenCalledWith(env);
    expect(mocks.syncCacheGenerationMirror).toHaveBeenCalledWith(env, mocks.db);
    expect(mocks.releaseExpiredReservations).toHaveBeenCalledWith(mocks.db, 30, {
      limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
    });
    expect(mocks.archiveStaleIncompleteOrders).toHaveBeenCalledWith(
      mocks.db,
      Math.floor(now.getTime() / 1000) - STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES * 60,
      { limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT },
    );
    expect(mocks.cleanupStaleAbandonedCheckouts).toHaveBeenCalledWith(
      mocks.db,
      Math.floor(now.getTime() / 1000),
      {
        retentionDays: ABANDONED_CHECKOUT_RETENTION_DAYS,
        emptyMaxAgeMinutes: EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES,
        limit: ABANDONED_CHECKOUT_SWEEP_LIMIT,
      },
    );
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledWith({ env, executionCtx });
    expect(mocks.flushPendingNotificationOutbox).toHaveBeenCalledWith({
      db: mocks.db,
      queue: env.JOBS_QUEUE,
      limit: ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT,
    });
    expect(mocks.flushPendingMetaPurchaseOutbox).toHaveBeenCalledWith({
      db: mocks.db,
      storefrontUrl: undefined,
      encryptionKey: undefined,
      limit: META_PURCHASE_OUTBOX_SWEEP_LIMIT,
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("event=scheduled_run_started"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("cron=*/15 * * * *"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("scheduledTime=2026-06-20T12:00:00.000Z"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("operation=inventory_expiry_sweep"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("event=scheduled_run_completed"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("staleQueued=1"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Meta Purchase outbox flush"));
    expect(mocks.reconcileDueRefundAttempts).toHaveBeenCalledWith(mocks.db, {
      encryptionKey: undefined,
      limit: REFUND_ATTEMPT_RECONCILIATION_LIMIT,
    });
    expect(mocks.reconcileExternalRefundWebhooks).toHaveBeenCalledWith(mocks.db, {
      encryptionKey: undefined,
      limit: EXTERNAL_REFUND_RECONCILIATION_LIMIT,
    });
    expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenNthCalledWith(1, {
      db: mocks.db,
      queue: env.JOBS_QUEUE,
      orderId: "order_refunded",
      notificationType: "order_refunded",
      dedupeKey: "refund-reconcile:order_refunded:rfa_1:full",
      source: "refund-reconciliation",
      data: {
        amount: 100,
        refundId: "re_1",
      },
    });
    expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenNthCalledWith(2, {
      db: mocks.db,
      queue: env.JOBS_QUEUE,
      orderId: "order_processing",
      notificationType: "refund_processing",
      dedupeKey: "refund:order_processing:refund_order_processing_2:processing",
      source: "refund-reconciliation",
      data: {
        amount: 40,
        refundId: "re_pending",
      },
    });
    expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenNthCalledWith(3, {
      db: mocks.db,
      queue: env.JOBS_QUEUE,
      orderId: "order_failed",
      notificationType: "refund_failed",
      dedupeKey: "refund:order_failed:refund_order_failed_2:failed",
      source: "refund-reconciliation",
      data: {
        amount: 40,
        refundId: "re_failed",
      },
    });
    expect(mocks.failStaleQueuedPaymentWebhookEvents).toHaveBeenCalledWith(
      mocks.db,
      Math.floor(now.getTime() / 1000) - STALE_QUEUED_PAYMENT_WEBHOOK_MAX_AGE_MINUTES * 60,
      { limit: STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT },
    );
    expect(mocks.cleanupExpiredCustomerAuthOtpChallenges).toHaveBeenCalledWith(
      mocks.db,
      Math.floor(now.getTime() / 1000),
      { limit: CUSTOMER_AUTH_OTP_SWEEP_LIMIT },
    );
    expect(mocks.cleanupExpiredOrderPaymentRecoveryChallenges).toHaveBeenCalledWith(
      mocks.db,
      Math.floor(now.getTime() / 1000),
      { limit: ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT },
    );
    expect(mocks.cleanupExpiredCustomerAuthOtpRateLimits).toHaveBeenCalledWith(
      mocks.db,
      Math.floor(now.getTime() / 1000),
      { limit: CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT },
    );
    expect(mocks.cleanupExpiredCustomerSessions).toHaveBeenCalledWith(
      mocks.db,
      Math.floor(now.getTime() / 1000),
      { limit: CUSTOMER_SESSION_SWEEP_LIMIT },
    );
    expect(mocks.pruneExpiredIdentityHandoffEvents).toHaveBeenCalledWith(mocks.db);
    expect(mocks.cleanupExpiredScannerTokenClaims).toHaveBeenCalledWith(
      mocks.db,
      {
        nowSeconds: Math.floor(now.getTime() / 1000),
        limit: SCANNER_TOKEN_CLAIM_SWEEP_LIMIT,
      },
    );
  });

  it("invalidates and enqueues notifications after Stripe external refunds are locally reconciled", async () => {
    const env = createEnv();
    const executionCtx = createExecutionContext();
    mocks.reconcileExternalRefundWebhooks.mockResolvedValue({
      scanned: 1,
      imported: 1,
      finalized: 1,
      skipped: 0,
      deferred: 0,
      errors: [],
      finalizedOrderIds: ["order_stripe_refunded"],
      refundNotifications: [{
        orderId: "order_stripe_refunded",
        notificationType: "order_partially_refunded",
        dedupeKey: "refund-reconcile:order_stripe_refunded:rfa_stripe_external_re_1:partial",
        amount: 15,
        refundId: "re_1",
      }],
      limit: EXTERNAL_REFUND_RECONCILIATION_LIMIT,
      hasMore: false,
    });

    await runScheduledMaintenance(env, executionCtx);

    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
    expect(mocks.enqueueOrderRefundNotificationForOrder).toHaveBeenCalledWith({
      db: mocks.db,
      queue: env.JOBS_QUEUE,
      orderId: "order_stripe_refunded",
      notificationType: "order_partially_refunded",
      dedupeKey: "refund-reconcile:order_stripe_refunded:rfa_stripe_external_re_1:partial",
      source: "refund-reconciliation",
      data: {
        amount: 15,
        refundId: "re_1",
      },
    });
  });

  it("does not invalidate availability caches when a sweep has no affected subjects", async () => {
    vi.setSystemTime(new Date("2026-06-20T12:00:00.000Z"));

    await runScheduledMaintenance(createEnv(), createExecutionContext());

    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
    expect(mocks.cleanupStaleAbandonedCheckouts).toHaveBeenCalled();
    expect(mocks.flushPendingNotificationOutbox).toHaveBeenCalled();
    expect(mocks.reconcileDueRefundAttempts).toHaveBeenCalled();
    expect(mocks.enqueueOrderRefundNotificationForOrder).not.toHaveBeenCalled();
    expect(mocks.failStaleQueuedPaymentWebhookEvents).toHaveBeenCalled();
    expect(mocks.cleanupExpiredCustomerAuthOtpChallenges).toHaveBeenCalled();
    expect(mocks.cleanupExpiredCustomerAuthOtpRateLimits).toHaveBeenCalled();
    expect(mocks.cleanupExpiredCustomerSessions).toHaveBeenCalled();
    expect(mocks.cleanupExpiredScannerTokenClaims).toHaveBeenCalled();
  });

  it("backfills media renditions only with the Images binding and bumps the generation only when one was saved", async () => {
    const images = { info: vi.fn() };
    const env = { ...createEnv(), IMAGES: images } as unknown as Env;

    await runScheduledMaintenance(createEnv(), createExecutionContext());
    expect(mocks.backfillMissingMediaVariants).not.toHaveBeenCalled();

    const startedAt = new Date("2026-06-20T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    mocks.backfillMissingMediaVariants.mockResolvedValueOnce({ scanned: 2, generated: 0, failed: 2, hasMore: false });
    await runScheduledMaintenance(env, createExecutionContext());
    expect(mocks.backfillMissingMediaVariants).toHaveBeenCalledWith(
      mocks.db,
      env.BUCKET,
      images,
      {
        deadline: startedAt.getTime() + MEDIA_RENDITION_BACKFILL_DEADLINE_MS,
        concurrency: MEDIA_RENDITION_BACKFILL_CONCURRENCY,
        maxImages: MEDIA_RENDITION_BACKFILL_MAX_PER_RUN,
      },
    );
    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();

    const executionCtx = createExecutionContext();
    mocks.backfillMissingMediaVariants.mockResolvedValueOnce({ scanned: 158, generated: 157, failed: 1, hasMore: false });
    await runScheduledMaintenance(env, executionCtx);
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledTimes(1);
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledWith({ env, executionCtx });
  });

  it("runs the time-budgeted rendition backfill last, after every commerce sweep", async () => {
    const env = { ...createEnv(), IMAGES: { info: vi.fn() } } as unknown as Env;

    await runScheduledMaintenance(env, createExecutionContext());

    const backfillOrder = mocks.backfillMissingMediaVariants.mock.invocationCallOrder[0]!;
    for (const sweep of [
      mocks.releaseExpiredReservations,
      mocks.flushPendingNotificationOutbox,
      mocks.reconcileDueRefundAttempts,
      mocks.cleanupExpiredCustomerSessions,
      mocks.pruneExpiredIdentityHandoffEvents,
    ]) {
      expect(sweep.mock.invocationCallOrder[0]).toBeLessThan(backfillOrder);
    }
    // The deadline leaves the rest of the 15-minute cron wall window as slack.
    expect(MEDIA_RENDITION_BACKFILL_DEADLINE_MS).toBeLessThanOrEqual(10 * 60 * 1_000);
    expect(MEDIA_RENDITION_BACKFILL_CONCURRENCY).toBeLessThanOrEqual(3);
  });

  it("logs operation and run failure timings before rethrowing scheduled errors", async () => {
    const error = new Error("D1 queue overloaded");
    mocks.cleanupStaleAbandonedCheckouts.mockRejectedValueOnce(error);

    await expect(runScheduledMaintenance(createEnv(), createExecutionContext())).rejects.toThrow("D1 queue overloaded");

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("event=scheduled_operation_failed"),
      error,
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("operation=abandoned_checkout_cleanup"),
      error,
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("event=scheduled_run_failed"),
      error,
    );
  });
});
