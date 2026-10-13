import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = { id: "db", select: vi.fn() };
  return {
    db,
    sweepReviewRequests: vi.fn(),
    backfillConversationSearch: vi.fn(),
    sweepDigitalUploads: vi.fn(),
    sweepAutoFulfilment: vi.fn(),
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

    enqueueOrderRefundNotificationForOrder: vi.fn(),
    failStaleQueuedPaymentWebhookEvents: vi.fn(),
    backfillMissingMediaVariants: vi.fn(),
    enqueueMediaVariantsBacklog: vi.fn(),
    runScheduledEventMaintenance: vi.fn(),
    runScheduledEventRetention: vi.fn(async () => ({ events: 0, deliveries: 0, pluginDeliveries: 0 })),
    runScheduledPluginMaintenance: vi.fn(),
  };
});

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@scalius/core/modules/inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/inventory")>()),
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

vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/notifications")>()),
  flushPendingNotificationOutbox: mocks.flushPendingNotificationOutbox,
}));


vi.mock("@scalius/core/modules/reviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/reviews")>()),
  sweepReviewRequests: mocks.sweepReviewRequests,
}));

vi.mock("@scalius/core/modules/digital", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/digital")>()),
  sweepDigitalUploads: mocks.sweepDigitalUploads,
}));

// The real fulfillers are registered (Wave B); the sweep itself has its own D1 tests.
vi.mock("@scalius/core/modules/fulfilment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/fulfilment")>()),
  sweepAutoFulfilment: mocks.sweepAutoFulfilment,
}));

vi.mock("@scalius/core/modules/conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/conversations")>()),
  backfillConversationSearch: mocks.backfillConversationSearch,
  sweepOrphanConversationAttachments: vi.fn(async () => ({ scanned: 0, deleted: 0 })),
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

vi.mock("@scalius/core/modules/payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments")>()),
  reconcileDueRefundAttempts: mocks.reconcileDueRefundAttempts,
  reconcileExternalRefundWebhooks: mocks.reconcileExternalRefundWebhooks,
}));

vi.mock("@scalius/core/modules/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/media")>()),
  backfillMissingMediaVariants: mocks.backfillMissingMediaVariants,
  enqueueMediaVariantsBacklog: mocks.enqueueMediaVariantsBacklog,
}));

vi.mock("./utils/order-notification-queue", () => ({
  enqueueOrderRefundNotificationForOrder: mocks.enqueueOrderRefundNotificationForOrder,
}));

vi.mock("./events/dispatch", () => ({
  runScheduledEventMaintenance: mocks.runScheduledEventMaintenance,
  runScheduledEventRetention: mocks.runScheduledEventRetention,
}));

vi.mock("./plugins/scheduled", () => ({
  runScheduledPluginMaintenance: mocks.runScheduledPluginMaintenance,
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
  MAINTENANCE_SWEEPS,
  MAINTENANCE_TICK_MS,
  maintenanceSliceDue,
  CUSTOMER_AUTH_OTP_SWEEP_LIMIT,
  CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT,
  CUSTOMER_SESSION_SWEEP_LIMIT,
  META_PURCHASE_OUTBOX_SWEEP_LIMIT,
  ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT,
  ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT,
  REVIEW_REQUEST_SWEEP_LIMIT,
  REFUND_ATTEMPT_RECONCILIATION_LIMIT,
  SCANNER_TOKEN_CLAIM_SWEEP_LIMIT,
  EXTERNAL_REFUND_RECONCILIATION_LIMIT,
  STALE_QUEUED_PAYMENT_WEBHOOK_MAX_AGE_MINUTES,
  STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT,
  STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES,
  STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
  runScheduledMaintenance,
  runQueuedMaintenance,
} from "./scheduled-maintenance";
import { PLAN_LIMITS } from "@scalius/shared/plan-limits";

/** What the Paid profile runs per tick: every sweep at its full limit (the behaviour before the profile). */
const MEDIA_RENDITION_BACKFILL_MAX_PER_RUN = PLAN_LIMITS.paid.maintenance.inlineRenditionsPerRun;
const MEDIA_RENDITION_FANOUT_MAX_PER_RUN = PLAN_LIMITS.paid.queue.bulkPageSize;

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
    // Every sweep every tick at its full limit is the Paid profile; the Free rotation is the describe below.
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
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
    mocks.runScheduledEventMaintenance.mockResolvedValue({
      events: { scanned: 0, enqueued: 0, settledWithoutSubscribers: 0, failed: 0, skipped: 0 },
      deliveries: { scanned: 0, enqueued: 0, failed: 0, skipped: 0 },
      pluginDeliveries: { scanned: 0, enqueued: 0, failed: 0, skipped: 0 },
      pruned: { events: 0, deliveries: 0, pluginDeliveries: 0 },
    });
    mocks.runScheduledPluginMaintenance.mockResolvedValue({
      bundled: { installed: [], updated: [], removed: [], failed: [], fxApps: false },
      cron: { due: 0, ran: 0, failed: 0, skipped: 0, deferred: 0, expired: 0 },
      prunedCronRuns: 0,
    });
    mocks.flushPendingMetaPurchaseOutbox.mockResolvedValue({
      scanned: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      busy: 0,
    });

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
    mocks.enqueueMediaVariantsBacklog.mockResolvedValue({ queued: 0, hasMore: false });
    mocks.sweepReviewRequests.mockResolvedValue({ queued: 0, skipped: 0 });
    mocks.sweepDigitalUploads.mockResolvedValue({ aborted: 0 });
    mocks.sweepAutoFulfilment.mockResolvedValue({ scanned: 0, fulfilled: 0, failed: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs inventory expiry and bounded outbox recovery", async () => {
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
    // App gateways load only when a due row names one.
    expect(mocks.reconcileDueRefundAttempts).toHaveBeenCalledWith(mocks.db, {
      encryptionKey: undefined,
      limit: REFUND_ATTEMPT_RECONCILIATION_LIMIT,
      providers: expect.any(Function),
    });
    expect(mocks.reconcileExternalRefundWebhooks).toHaveBeenCalledWith(mocks.db, {
      encryptionKey: undefined,
      limit: EXTERNAL_REFUND_RECONCILIATION_LIMIT,
      providers: expect.any(Function),
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

  it("queues due review requests before the outbox flush sends up to 200 rows", async () => {
    const env = createEnv();
    await runScheduledMaintenance(env, createExecutionContext());

    expect(mocks.sweepReviewRequests).toHaveBeenCalledWith(mocks.db, { limit: REVIEW_REQUEST_SWEEP_LIMIT });
    expect(mocks.sweepReviewRequests.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.flushPendingNotificationOutbox.mock.invocationCallOrder[0]!);
    expect(ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT).toBe(200);
    expect(mocks.sweepDigitalUploads).toHaveBeenCalledWith(mocks.db, env.BUCKET, {
      limit: 25,
      afterUploadingId: undefined,
      afterReplacedId: undefined,
    });
  });

  it("leaves public freshness to database dependency triggers without generation reads", async () => {
    await runScheduledMaintenance(createEnv(), createExecutionContext());
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it("keeps running the other sweeps when a Wave B sweep fails", async () => {
    const first = new Error("review requests broken");
    mocks.sweepReviewRequests.mockRejectedValueOnce(first);
    mocks.sweepDigitalUploads.mockRejectedValueOnce(new Error("R2 down"));

    await expect(runScheduledMaintenance(createEnv(), createExecutionContext())).rejects.toBe(first);
    expect(mocks.flushPendingNotificationOutbox).toHaveBeenCalled();
    expect(mocks.flushPendingMetaPurchaseOutbox).toHaveBeenCalled();
    expect(mocks.cleanupExpiredCustomerSessions).toHaveBeenCalled();

  });

  it("backfills media renditions only with the Images binding", async () => {
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

    // The backlog goes to the jobs queue first; nothing queued, the run renders inline.
    expect(mocks.enqueueMediaVariantsBacklog).toHaveBeenCalledWith(mocks.db, env.JOBS_QUEUE, {
      skip: 0,
      limit: MEDIA_RENDITION_FANOUT_MAX_PER_RUN,
    });

    const executionCtx = createExecutionContext();
    mocks.backfillMissingMediaVariants.mockResolvedValueOnce({ scanned: 158, generated: 157, failed: 1, hasMore: false });
    await runScheduledMaintenance(env, executionCtx);

  });

  it("fans a rendition backlog out to the jobs queue instead of rendering it inline", async () => {
    const env = { ...createEnv(), IMAGES: { info: vi.fn() } } as unknown as Env;
    mocks.enqueueMediaVariantsBacklog.mockResolvedValueOnce({ queued: 1_000, hasMore: true });
    await runScheduledMaintenance(env, createExecutionContext());
    expect(mocks.backfillMissingMediaVariants).not.toHaveBeenCalled();

    // A queue that refuses the batch leaves the inline backfill to render.
    mocks.enqueueMediaVariantsBacklog.mockRejectedValueOnce(new Error("queue down"));
    await runScheduledMaintenance(env, createExecutionContext());
    expect(mocks.backfillMissingMediaVariants).toHaveBeenCalledTimes(1);
  });

  it("runs the event outbox backstop (due events, webhook retries, retention) after the refund sweeps", async () => {
    const env = createEnv();
    await runScheduledMaintenance(env, createExecutionContext());
    expect(mocks.runScheduledEventMaintenance).toHaveBeenCalledWith(mocks.db, env);
    // Refund reconciliation writes refunds whose events this run should hand over.
    expect(mocks.reconcileExternalRefundWebhooks.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runScheduledEventMaintenance.mock.invocationCallOrder[0]!);
  });

  it("prunes settled events after dispatching the due ones, in the last slice of the rotation", async () => {
    await runScheduledMaintenance(createEnv(), createExecutionContext());
    expect(mocks.runScheduledEventRetention).toHaveBeenCalledWith(mocks.db);
    expect(mocks.runScheduledEventMaintenance.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runScheduledEventRetention.mock.invocationCallOrder[0]!);
    expect(MAINTENANCE_SWEEPS.find((sweep) => sweep.name === "event_outbox_retention")?.slice).toBe(3);
  });

  it("runs the plugin tick (bundled sync, due cron slots) at the scheduled time, after the event sweep", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    await runScheduledMaintenance(env, ctx, { cron: "*/15 * * * *", scheduledTime: Date.parse("2026-10-02T10:15:00.000Z") });
    expect(mocks.runScheduledPluginMaintenance).toHaveBeenCalledWith(mocks.db, env, ctx, Date.parse("2026-10-02T10:15:00.000Z"), { nightly: false });
    expect(mocks.runScheduledEventMaintenance.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runScheduledPluginMaintenance.mock.invocationCallOrder[0]!);
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
      mocks.runScheduledEventMaintenance,
    ]) {
      expect(sweep.mock.invocationCallOrder[0]).toBeLessThan(backfillOrder);
    }
    // The deadline leaves the rest of the 15-minute cron wall window as slack.
    expect(MEDIA_RENDITION_BACKFILL_DEADLINE_MS).toBeLessThanOrEqual(10 * 60 * 1_000);
    expect(MEDIA_RENDITION_BACKFILL_CONCURRENCY).toBeLessThanOrEqual(3);
  });

  it("still runs the later sweeps and the rendition backfill when a sweep keeps failing, then fails the run", async () => {
    const env = { ...createEnv(), IMAGES: { info: vi.fn() } } as unknown as Env;
    const first = new Error("abandoned checkout sweep broken");
    mocks.cleanupStaleAbandonedCheckouts.mockRejectedValueOnce(first);
    mocks.reconcileDueRefundAttempts.mockRejectedValueOnce(new Error("refund provider down"));
    mocks.backfillMissingMediaVariants.mockResolvedValueOnce({ scanned: 3, generated: 3, failed: 0, hasMore: false });

    await expect(runScheduledMaintenance(env, createExecutionContext())).rejects.toBe(first);

    expect(mocks.flushPendingNotificationOutbox).toHaveBeenCalled();
    expect(mocks.cleanupExpiredCustomerSessions).toHaveBeenCalled();
    expect(mocks.pruneExpiredIdentityHandoffEvents).toHaveBeenCalled();
    expect(mocks.backfillMissingMediaVariants).toHaveBeenCalledTimes(1);

  });

  it("fails the run when only the rendition backfill fails", async () => {
    const env = { ...createEnv(), IMAGES: { info: vi.fn() } } as unknown as Env;
    mocks.backfillMissingMediaVariants.mockRejectedValueOnce(new Error("D1 read failed"));

    await expect(runScheduledMaintenance(env, createExecutionContext())).rejects.toThrow("D1 read failed");
    expect(mocks.cleanupExpiredCustomerSessions).toHaveBeenCalled();
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

describe("the sweep rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  const tickAt = (tick: number) => tick * MAINTENANCE_TICK_MS;

  it("names every sweep once, in a slice of the rotation or on every tick", () => {
    const names = MAINTENANCE_SWEEPS.map((sweep) => sweep.name);
    expect(new Set(names).size).toBe(names.length);
    for (const sweep of MAINTENANCE_SWEEPS) expect([0, 1, 2, 3, "every"]).toContain(sweep.slice);
    // Time-sensitive work is never thinned out: buyers' notifications, webhooks, the merchant's plugin schedules.
    for (const name of ["notification_outbox_flush", "event_outbox_maintenance", "plugin_maintenance"]) {
      expect(MAINTENANCE_SWEEPS.find((sweep) => sweep.name === name)?.slice).toBe("every");
    }
  });

  it("on one slice (Paid) every sweep is due on every tick, and on an unknown time (a manual run)", () => {
    for (const sweep of MAINTENANCE_SWEEPS) {
      for (let tick = 0; tick < 8; tick += 1) expect(maintenanceSliceDue(tickAt(tick), sweep.slice, 1)).toBe(true);
      expect(maintenanceSliceDue(undefined, sweep.slice, 4)).toBe(true);
    }
  });

  it("on four slices (Free) each sweep runs once an hour, and the four ticks of an hour together run every sweep", () => {
    const perSweep = new Map<string, number>();
    for (let tick = 100; tick < 104; tick += 1) {
      for (const sweep of MAINTENANCE_SWEEPS) {
        if (maintenanceSliceDue(tickAt(tick), sweep.slice, 4)) perSweep.set(sweep.name, (perSweep.get(sweep.name) ?? 0) + 1);
      }
    }
    for (const sweep of MAINTENANCE_SWEEPS) expect(perSweep.get(sweep.name), sweep.name).toBe(sweep.slice === "every" ? 4 : 1);
  });

  it("keeps a Free tick light: no tick runs more than a third of the sweeps that rotate", () => {
    const rotating = MAINTENANCE_SWEEPS.filter((sweep) => sweep.slice !== "every");
    for (let tick = 0; tick < 4; tick += 1) {
      const due = rotating.filter((sweep) => maintenanceSliceDue(tickAt(tick), sweep.slice, 4));
      expect(due.length, `tick ${tick}`).toBeLessThanOrEqual(Math.ceil(rotating.length / 3));
    }
  });

  it("runs only the due slice on Free, at a fraction of each sweep's limit, and still the every-tick sweeps", async () => {
    const env = { BUCKET: {}, JOBS_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } } as unknown as Env;
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    mocks.releaseExpiredReservations.mockResolvedValue({ found: 0, released: 0, limit: 10, hasMore: false, releasedVariantIds: [], availabilityTransitionVariantIds: [], errors: [] });
    mocks.flushPendingNotificationOutbox.mockResolvedValue({ scanned: 0, enqueued: 0, failed: 0, skipped: 0, staleQueued: 0 });
    mocks.reconcileDueRefundAttempts.mockResolvedValue({ refundNotifications: [], scanned: 0, claimed: 0, finalized: 0, failed: 0, deferred: 0, errors: [], limit: 1, hasMore: false });
    mocks.reconcileExternalRefundWebhooks.mockResolvedValue({ refundNotifications: [], scanned: 0, imported: 0, finalized: 0, skipped: 0, deferred: 0, errors: [], limit: 1, hasMore: false });
    mocks.failStaleQueuedPaymentWebhookEvents.mockResolvedValue({ scanned: 0, failed: 0, limit: 5, hasMore: false });
    mocks.runScheduledEventMaintenance.mockResolvedValue({ events: { scanned: 0, enqueued: 0, settledWithoutSubscribers: 0, failed: 0 }, deliveries: { scanned: 0, enqueued: 0 }, pluginDeliveries: { scanned: 0, enqueued: 0 }, pruned: { events: 0, deliveries: 0, pluginDeliveries: 0 } });
    mocks.runScheduledPluginMaintenance.mockResolvedValue({ bundled: { installed: [], updated: [], removed: [], failed: [], fxApps: false }, cron: { due: 0, ran: 0, failed: 0, skipped: 0, deferred: 0, expired: 0 }, prunedCronRuns: 0 });

    // Slice 0 (inventory, refunds, stale webhooks) on tick 0; nothing of slices 1-3.
    await runScheduledMaintenance(env, ctx, { cron: "*/15 * * * *", scheduledTime: tickAt(4_000) });
    expect(mocks.releaseExpiredReservations).not.toHaveBeenCalled();
    expect(mocks.reconcileDueRefundAttempts).not.toHaveBeenCalled();
    expect(env.JOBS_QUEUE!.sendBatch).toHaveBeenCalledWith([
      ...["inventory_expiry_sweep", "refund_attempt_reconciliation", "external_refund_reconciliation", "plugin_maintenance"].map((name) => ({ body: { type: "maintenance.sweep", name, scheduledAt: tickAt(4_000) } })),
    ]);
    await runQueuedMaintenance(env, ctx, { type: "maintenance.sweep", name: "inventory_expiry_sweep", scheduledAt: tickAt(4_000) });
    expect(mocks.releaseExpiredReservations).toHaveBeenCalledWith(mocks.db, 30, {
      limit: Math.floor(INVENTORY_EXPIRY_SWEEP_LIMIT * PLAN_LIMITS.free.maintenance.limitScale),
    });
    expect(mocks.cleanupStaleAbandonedCheckouts).not.toHaveBeenCalled();
    expect(mocks.cleanupExpiredCustomerSessions).not.toHaveBeenCalled();
    expect(mocks.flushPendingMetaPurchaseOutbox).not.toHaveBeenCalled();
    // Every tick: the notification flush (at a fraction of its limit), the event outbox, the plugin tick.
    expect(mocks.flushPendingNotificationOutbox).toHaveBeenCalledWith({
      db: mocks.db,
      queue: env.JOBS_QUEUE,
      limit: Math.floor(ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT * PLAN_LIMITS.free.maintenance.limitScale),
    });
    expect(mocks.runScheduledEventMaintenance).toHaveBeenCalledTimes(1);
    expect(mocks.runScheduledPluginMaintenance).not.toHaveBeenCalled();

    // The next tick runs the next slice.
    vi.clearAllMocks();
    await runScheduledMaintenance(env, ctx, { cron: "*/15 * * * *", scheduledTime: tickAt(4_001) });
    expect(mocks.releaseExpiredReservations).not.toHaveBeenCalled();
    expect(mocks.cleanupStaleAbandonedCheckouts).toHaveBeenCalledTimes(1);
    expect(mocks.flushPendingNotificationOutbox).toHaveBeenCalledTimes(1);
  });

  it("leaves a queue that is full of bulk work alone, and renders inline only without a queue or when the queue refuses", async () => {
    const images = { info: vi.fn() };
    const send = vi.fn();
    const full = { send, sendBatch: vi.fn(), metrics: vi.fn(async () => ({ backlogCount: PLAN_LIMITS.free.queue.bulkBacklogLimit })) };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    // Slice 3 of the rotation: the rendition backlog.
    const sliceThree = tickAt(4_003);
    await runScheduledMaintenance({ BUCKET: {}, IMAGES: images, JOBS_QUEUE: full } as unknown as Env, ctx, { scheduledTime: sliceThree });
    expect(mocks.enqueueMediaVariantsBacklog).not.toHaveBeenCalled();
    expect(mocks.backfillMissingMediaVariants).not.toHaveBeenCalled();

    // Room for 4 more: one small page, behind the jobs already queued.
    const roomy = { send, sendBatch: vi.fn(), metrics: vi.fn(async () => ({ backlogCount: PLAN_LIMITS.free.queue.bulkBacklogLimit - 4 })) };
    mocks.enqueueMediaVariantsBacklog.mockResolvedValueOnce({ queued: 4, hasMore: true });
    await runScheduledMaintenance({ BUCKET: {}, IMAGES: images, JOBS_QUEUE: roomy } as unknown as Env, ctx, { scheduledTime: sliceThree });
    expect(mocks.enqueueMediaVariantsBacklog).toHaveBeenCalledWith(mocks.db, roomy, {
      skip: PLAN_LIMITS.free.queue.bulkBacklogLimit - 4,
      limit: 4,
    });
    expect(mocks.backfillMissingMediaVariants).not.toHaveBeenCalled();

    // A queue that refuses falls back to the inline backfill, at the Free inline limit (one image).
    mocks.enqueueMediaVariantsBacklog.mockRejectedValueOnce(new Error("queue down"));
    mocks.backfillMissingMediaVariants.mockResolvedValueOnce({ scanned: 1, generated: 1, failed: 0, hasMore: true });
    await runScheduledMaintenance({ BUCKET: {}, IMAGES: images, JOBS_QUEUE: roomy } as unknown as Env, ctx, { scheduledTime: sliceThree });
    expect(mocks.backfillMissingMediaVariants).toHaveBeenCalledWith(
      mocks.db,
      expect.anything(),
      images,
      expect.objectContaining({ maxImages: PLAN_LIMITS.free.maintenance.inlineRenditionsPerRun }),
    );

    // No queue binding at all: inline too.
    mocks.backfillMissingMediaVariants.mockClear();
    mocks.backfillMissingMediaVariants.mockResolvedValueOnce({ scanned: 0, generated: 0, failed: 0, hasMore: false });
    await expect(runScheduledMaintenance({ BUCKET: {}, IMAGES: images } as unknown as Env, ctx, { scheduledTime: sliceThree })).rejects.toThrow("requires the jobs queue");
    expect(mocks.backfillMissingMediaVariants).toHaveBeenCalledTimes(1);
  });
});
