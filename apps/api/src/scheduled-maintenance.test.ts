import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = { id: "db", select: vi.fn() };
  return {
    db,
    sweepReviewRequests: vi.fn(),
    sweepDigitalUploads: vi.fn(),
    sweepAutoFulfilment: vi.fn(),
    getDb: vi.fn(() => db),
    releaseExpiredReservations: vi.fn(),
    cleanupStaleAbandonedCheckouts: vi.fn(),
    cleanupExpiredOrderPaymentRecoveryChallenges: vi.fn(),
    archiveStaleIncompleteOrders: vi.fn(),
    drainNotificationOutbox: vi.fn(),
    drainPaymentEvents: vi.fn(),
    drainCatalogProjectionRebuild: vi.fn(),
    rotateRecommendations: vi.fn(),
    cursorSave: vi.fn(async () => true),
    flushPendingMetaPurchaseOutbox: vi.fn(),
    cleanupExpiredCustomerAuthOtpChallenges: vi.fn(),
    cleanupExpiredCustomerAuthOtpRateLimits: vi.fn(),
    cleanupExpiredCustomerSessions: vi.fn(),
    cleanupExpiredScannerTokenClaims: vi.fn(),
    pruneExpiredIdentityHandoffEvents: vi.fn(),
    reconcileDueRefundAttempts: vi.fn(),
    reconcileExternalRefundWebhooks: vi.fn(),
    sendOrderRefundNotification: vi.fn(),
    backfillMissingMediaVariants: vi.fn(),
    runScheduledEventMaintenance: vi.fn(),
    runScheduledEventRetention: vi.fn(async () => ({ events: 0, deliveries: 0, pluginDeliveries: 0 })),
    runScheduledPluginMaintenance: vi.fn(),
    measurePluginStorage: vi.fn(async () => 0),
    runNightlyCatalogMaintenance: vi.fn(async () => ({ salesStatsProducts: 0, soldRecommendations: 0 })),
    purgeExpiredOAuthData: vi.fn(),
    purgeExpiredAgentArtifacts: vi.fn(),
    expireAgentBrowserHandoffs: vi.fn(),
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
  pruneStaffAlerts: vi.fn(async () => ({ inbox: 0, alerts: 0 })),
}));
vi.mock("./background/notifications", () => ({ drainNotificationOutbox: mocks.drainNotificationOutbox }));
vi.mock("./background/payment-events", () => ({ drainPaymentEvents: mocks.drainPaymentEvents }));
vi.mock("./background/catalog", () => ({
  drainCatalogProjectionRebuild: mocks.drainCatalogProjectionRebuild,
  rotateRecommendations: mocks.rotateRecommendations,
}));
// Scan positions are their own D1 tests (scheduled/cursor.ts); here every scan starts fresh.
vi.mock("./scheduled/cursor", () => ({ readMaintenanceCursor: vi.fn(async () => ({ value: {}, save: mocks.cursorSave })) }));

// The projection sweeps have their own D1 tests (derived-projections.test.ts).
vi.mock("@scalius/core/modules/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/analytics")>()),
  sealAnalyticsDays: vi.fn(async () => 0),
}));
vi.mock("./scheduled/derived-projections", () => ({
  maintainDerivedProjections: vi.fn(async () => ({ analytics: { drift: 0 }, recommendations: { drift: 0 }, inbox: { drift: 0 } })),
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
}));

vi.mock("./utils/order-notifications", () => ({
  sendOrderRefundNotification: mocks.sendOrderRefundNotification,
}));

vi.mock("./events/dispatch", () => ({
  runScheduledEventMaintenance: mocks.runScheduledEventMaintenance,
  runScheduledEventRetention: mocks.runScheduledEventRetention,
}));

vi.mock("./plugins/scheduled", () => ({
  runScheduledPluginMaintenance: mocks.runScheduledPluginMaintenance,
  measurePluginStorage: mocks.measurePluginStorage,
}));

vi.mock("./scheduled/catalog-projections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scheduled/catalog-projections")>()),
  runNightlyCatalogMaintenance: mocks.runNightlyCatalogMaintenance,
}));

vi.mock("./agent-access/oauth", () => ({ purgeExpiredOAuthData: mocks.purgeExpiredOAuthData }));
vi.mock("./agent-access/artifact-delivery", () => ({ purgeExpiredAgentArtifacts: mocks.purgeExpiredAgentArtifacts }));
vi.mock("./agent-access/browser-handoffs", () => ({ expireAgentBrowserHandoffs: mocks.expireAgentBrowserHandoffs }));

import {
  ABANDONED_CHECKOUT_RETENTION_DAYS,
  ABANDONED_CHECKOUT_SWEEP_LIMIT,
  EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES,
  MEDIA_RENDITION_BACKFILL_CONCURRENCY,
  MEDIA_RENDITION_BACKFILL_DEADLINE_MS,
  MAINTENANCE_SWEEPS,
  DRAIN_TICK_MS,
  dueSweepIndexes,
  firstSweepRunOfHour,
  sweepPeriodMinutes,
  CUSTOMER_AUTH_OTP_SWEEP_LIMIT,
  CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT,
  CUSTOMER_SESSION_SWEEP_LIMIT,
  META_PURCHASE_OUTBOX_SWEEP_LIMIT,
  ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT,
  REVIEW_REQUEST_SWEEP_LIMIT,
  REFUND_ATTEMPT_RECONCILIATION_LIMIT,
  SCANNER_TOKEN_CLAIM_SWEEP_LIMIT,
  EXTERNAL_REFUND_RECONCILIATION_LIMIT,
  STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES,
  STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
  runScheduledMaintenance,
} from "./scheduled-maintenance";
import { PLAN_LIMITS } from "@scalius/shared/plan-limits";

/** What the Paid profile runs per tick: every sweep at its full limit (the behaviour before the profile). */
const MEDIA_RENDITION_BACKFILL_MAX_PER_RUN = PLAN_LIMITS.paid.maintenance.inlineRenditionsPerRun;
const INVENTORY_EXPIRY_SWEEP_LIMIT = PLAN_LIMITS.paid.maintenance.inventoryExpiryPerRun;

function createEnv() {
  return {
    BUCKET: { id: "generated-media-bucket" },
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
    mocks.drainNotificationOutbox.mockResolvedValue({ scanned: 0 });
    mocks.drainPaymentEvents.mockResolvedValue({ scanned: 0, processed: 0 });
    mocks.drainCatalogProjectionRebuild.mockResolvedValue(0);
    mocks.rotateRecommendations.mockResolvedValue(0);
    mocks.runScheduledEventMaintenance.mockResolvedValue({
      events: { scanned: 0, dispatched: 0, settledWithoutSubscribers: 0, failed: 0, skipped: 0, deliveries: [] },
      deliveries: 0,
      pluginDeliveries: 0,
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
    mocks.sendOrderRefundNotification.mockResolvedValue({
      orderId: "order_refunded",
      outboxId: "outbox_refund_1",
      enqueued: false,
      skippedReason: "no_sender",
    });
    mocks.backfillMissingMediaVariants.mockResolvedValue({ scanned: 0, generated: 0, failed: 0, hasMore: false });
    mocks.sweepReviewRequests.mockResolvedValue({ queued: 0, skipped: 0 });
    mocks.sweepDigitalUploads.mockResolvedValue({ aborted: 0 });
    mocks.sweepAutoFulfilment.mockResolvedValue({ scanned: 0, fulfilled: 0, failed: 0, lastOrderId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs the drains, inventory expiry and the sweeps of a sweep tick", async () => {
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
      cron: "* * * * *",
      scheduledTime: now.getTime(),
    });

    expect(mocks.getDb).toHaveBeenCalledWith(env);
    expect(mocks.drainNotificationOutbox).toHaveBeenCalledWith(mocks.db, env);

    expect(mocks.releaseExpiredReservations).toHaveBeenCalledWith(mocks.db, 30, {
      limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
    });
    expect(mocks.archiveStaleIncompleteOrders).toHaveBeenCalledWith(
      mocks.db,
      Math.floor(now.getTime() / 1000) - STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES * 60,
      { limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT, afterOrderId: undefined, afterGiftCardOrderId: undefined },
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

    expect(mocks.flushPendingMetaPurchaseOutbox).toHaveBeenCalledWith({
      db: mocks.db,
      storefrontUrl: undefined,
      encryptionKey: undefined,
      limit: META_PURCHASE_OUTBOX_SWEEP_LIMIT,
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("event=scheduled_run_started"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("cron=* * * * *"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("scheduledTime=2026-06-20T12:00:00.000Z"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("operation=inventory_expiry_sweep"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("event=scheduled_run_completed"));
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
    expect(mocks.sendOrderRefundNotification).toHaveBeenNthCalledWith(1, {
      db: mocks.db,
      send: undefined,
      orderId: "order_refunded",
      notificationType: "order_refunded",
      dedupeKey: "refund-reconcile:order_refunded:rfa_1:full",
      source: "refund-reconciliation",
      data: {
        amount: 100,
        refundId: "re_1",
      },
    });
    expect(mocks.sendOrderRefundNotification).toHaveBeenNthCalledWith(2, {
      db: mocks.db,
      send: undefined,
      orderId: "order_processing",
      notificationType: "refund_processing",
      dedupeKey: "refund:order_processing:refund_order_processing_2:processing",
      source: "refund-reconciliation",
      data: {
        amount: 40,
        refundId: "re_pending",
      },
    });
    expect(mocks.sendOrderRefundNotification).toHaveBeenNthCalledWith(3, {
      db: mocks.db,
      send: undefined,
      orderId: "order_failed",
      notificationType: "refund_failed",
      dedupeKey: "refund:order_failed:refund_order_failed_2:failed",
      source: "refund-reconciliation",
      data: {
        amount: 40,
        refundId: "re_failed",
      },
    });
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

  it("records notifications for the drain after Stripe external refunds are locally reconciled", async () => {
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

    expect(mocks.sendOrderRefundNotification).toHaveBeenCalledWith({
      db: mocks.db,
      send: undefined,
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
    expect(mocks.drainNotificationOutbox).toHaveBeenCalled();
    expect(mocks.reconcileDueRefundAttempts).toHaveBeenCalled();
    expect(mocks.sendOrderRefundNotification).not.toHaveBeenCalled();
    expect(mocks.cleanupExpiredCustomerAuthOtpChallenges).toHaveBeenCalled();
    expect(mocks.cleanupExpiredCustomerAuthOtpRateLimits).toHaveBeenCalled();
    expect(mocks.cleanupExpiredCustomerSessions).toHaveBeenCalled();
    expect(mocks.cleanupExpiredScannerTokenClaims).toHaveBeenCalled();
  });

  it("turns due review requests into outbox rows the notification drain sends", async () => {
    const env = createEnv();
    await runScheduledMaintenance(env, createExecutionContext());

    expect(mocks.sweepReviewRequests).toHaveBeenCalledWith(mocks.db, { limit: REVIEW_REQUEST_SWEEP_LIMIT });
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
    expect(mocks.drainNotificationOutbox).toHaveBeenCalled();
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

    const executionCtx = createExecutionContext();
    mocks.backfillMissingMediaVariants.mockResolvedValueOnce({ scanned: 158, generated: 157, failed: 1, hasMore: false });
    await runScheduledMaintenance(env, executionCtx);

  });

  it("runs the background drains on every tick and the sweeps only on the 15-minute tick", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const sweepTick = Date.parse("2026-10-02T10:15:00.000Z");
    await runScheduledMaintenance(env, ctx, { cron: "* * * * *", scheduledTime: sweepTick });
    expect(mocks.drainNotificationOutbox).toHaveBeenCalledWith(mocks.db, env);
    expect(mocks.runScheduledEventMaintenance).toHaveBeenCalledWith(mocks.db, env, ctx);
    expect(mocks.drainPaymentEvents).toHaveBeenCalledWith(mocks.db, env, ctx);
    expect(mocks.drainCatalogProjectionRebuild).toHaveBeenCalledWith(mocks.db);
    // The drains go first: a sweep that keeps failing never delays them.
    expect(mocks.drainCatalogProjectionRebuild.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.releaseExpiredReservations.mock.invocationCallOrder[0]!);
    expect(mocks.rotateRecommendations).toHaveBeenCalledWith(mocks.db);

    vi.clearAllMocks();
    for (const minute of [1, 7, 14]) {
      await runScheduledMaintenance(env, ctx, { cron: "* * * * *", scheduledTime: sweepTick + minute * 60_000 });
    }
    expect(mocks.drainNotificationOutbox).toHaveBeenCalledTimes(3);
    expect(mocks.runScheduledEventMaintenance).toHaveBeenCalledTimes(3);
    expect(mocks.releaseExpiredReservations).not.toHaveBeenCalled();
    expect(mocks.runScheduledPluginMaintenance).not.toHaveBeenCalled();
    expect(mocks.rotateRecommendations).not.toHaveBeenCalled();
  });

  it("keeps draining when one drain fails, then fails the run", async () => {
    const broken = new Error("event drain broken");
    mocks.runScheduledEventMaintenance.mockRejectedValueOnce(broken);
    await expect(runScheduledMaintenance(createEnv(), createExecutionContext())).rejects.toBe(broken);
    expect(mocks.drainPaymentEvents).toHaveBeenCalled();
    expect(mocks.drainCatalogProjectionRebuild).toHaveBeenCalled();
    expect(mocks.releaseExpiredReservations).toHaveBeenCalled();
  });

  it("prunes settled events after dispatching the due ones", async () => {
    await runScheduledMaintenance(createEnv(), createExecutionContext());
    expect(mocks.runScheduledEventRetention).toHaveBeenCalledWith(mocks.db);
    expect(mocks.runScheduledEventMaintenance.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runScheduledEventRetention.mock.invocationCallOrder[0]!);
  });

  it("runs the agent-access housekeeping as a rotation job, each part isolated", async () => {
    const env = createEnv();
    mocks.purgeExpiredOAuthData.mockRejectedValueOnce(new Error("oauth storage down"));
    await runScheduledMaintenance(env, createExecutionContext());
    expect(mocks.purgeExpiredOAuthData).toHaveBeenCalledWith(env);
    expect(mocks.purgeExpiredAgentArtifacts).toHaveBeenCalledWith(env);
    expect(mocks.expireAgentBrowserHandoffs).toHaveBeenCalledWith(mocks.db);
  });

  it("gives the 02:00 store-time minute to the nightly pass alone", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    // 20:00 UTC is 02:00 in Dhaka (the store zone without a platform document).
    const nightly = Date.parse("2026-10-02T20:00:00.000Z");
    await runScheduledMaintenance(env, ctx, { cron: "* * * * *", scheduledTime: nightly });
    expect(mocks.runNightlyCatalogMaintenance).toHaveBeenCalledWith(mocks.db, nightly);
    expect(mocks.measurePluginStorage).toHaveBeenCalledWith(mocks.db);
    expect(mocks.drainNotificationOutbox).not.toHaveBeenCalled();
    expect(mocks.releaseExpiredReservations).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runScheduledMaintenance(env, ctx, { cron: "* * * * *", scheduledTime: nightly + DRAIN_TICK_MS });
    expect(mocks.runNightlyCatalogMaintenance).not.toHaveBeenCalled();
    expect(mocks.drainNotificationOutbox).toHaveBeenCalledTimes(1);
  });

  it("runs the plugin tick (bundled sync, due cron slots) at the scheduled time, after the event sweep", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    await runScheduledMaintenance(env, ctx, { cron: "* * * * *", scheduledTime: Date.parse("2026-10-02T10:15:00.000Z") });
    // Paid runs it every 15 minutes: the exchange rates refresh on the :00 run only.
    expect(mocks.runScheduledPluginMaintenance).toHaveBeenCalledWith(mocks.db, env, ctx, Date.parse("2026-10-02T10:15:00.000Z"), { fxDue: false });
    await runScheduledMaintenance(env, ctx, { cron: "* * * * *", scheduledTime: Date.parse("2026-10-02T11:00:00.000Z") });
    expect(mocks.runScheduledPluginMaintenance).toHaveBeenLastCalledWith(mocks.db, env, ctx, Date.parse("2026-10-02T11:00:00.000Z"), { fxDue: true });
    expect(mocks.runScheduledEventMaintenance.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runScheduledPluginMaintenance.mock.invocationCallOrder[0]!);
  });

  it("runs the time-budgeted rendition backfill after the commerce sweeps", async () => {
    const env = { ...createEnv(), IMAGES: { info: vi.fn() } } as unknown as Env;

    await runScheduledMaintenance(env, createExecutionContext());

    const backfillOrder = mocks.backfillMissingMediaVariants.mock.invocationCallOrder[0]!;
    for (const sweep of [
      mocks.releaseExpiredReservations,
      mocks.drainNotificationOutbox,
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

    expect(mocks.drainNotificationOutbox).toHaveBeenCalled();
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

  const count = MAINTENANCE_SWEEPS.length;
  const minuteAt = (minute: number) => minute * DRAIN_TICK_MS;
  const indexOf = (name: string) => MAINTENANCE_SWEEPS.findIndex((sweep) => sweep.name === name);

  it("names every job once, and Paid runs them all on one sweep tick", () => {
    const names = MAINTENANCE_SWEEPS.map((sweep) => sweep.name);
    expect(new Set(names).size).toBe(count);
    expect(PLAN_LIMITS.paid.maintenance.sweepsPerTick).toBeGreaterThanOrEqual(count);
    // docs/FREE-PLAN.md, the plugin SDK and the domain READMEs say a Free job runs every 24 minutes.
    expect(sweepPeriodMinutes(count, PLAN_LIMITS.free.maintenance)).toBe(24);
  });

  it("on Paid runs every job on every fifteenth minute and none between; a manual run runs every job", () => {
    const paid = PLAN_LIMITS.paid.maintenance;
    const all = Array.from({ length: count }, (_, index) => index);
    expect(dueSweepIndexes(minuteAt(1_500), count, paid)).toEqual(all);
    for (const offset of [1, 7, 14]) expect(dueSweepIndexes(minuteAt(1_500 + offset), count, paid)).toEqual([]);
    expect(dueSweepIndexes(undefined, count, PLAN_LIMITS.free.maintenance)).toEqual(all);
    expect(sweepPeriodMinutes(count, paid)).toBe(15);
  });

  it("on Free runs one job a minute, every job once per rotation, each at least hourly", () => {
    const free = PLAN_LIMITS.free.maintenance;
    const seen = new Map<number, number>();
    for (let minute = 7_000; minute < 7_000 + count; minute += 1) {
      const due = dueSweepIndexes(minuteAt(minute), count, free);
      expect(due).toHaveLength(1);
      seen.set(due[0]!, (seen.get(due[0]!) ?? 0) + 1);
    }
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(sweepPeriodMinutes(count, free)).toBe(count);
    expect(sweepPeriodMinutes(count, free)).toBeLessThanOrEqual(60);
  });

  it("marks exactly one run of each job an hour as the hour's first, on both plans", () => {
    for (const limits of [PLAN_LIMITS.free.maintenance, PLAN_LIMITS.paid.maintenance]) {
      for (const job of [0, count - 1]) {
        let first = 0;
        for (let minute = 60 * 500; minute < 60 * 503; minute += 1) {
          if (dueSweepIndexes(minuteAt(minute), count, limits).includes(job) && firstSweepRunOfHour(minuteAt(minute), count, limits)) first += 1;
        }
        expect(first, `job ${job}`).toBe(3);
      }
    }
  });

  it("runs the drains and one job per Free minute, at the Free limits", async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", "free");
    const env = { BUCKET: {} } as unknown as Env;
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    mocks.releaseExpiredReservations.mockResolvedValue({ found: 0, released: 0, limit: 5, hasMore: false, releasedVariantIds: [], availabilityTransitionVariantIds: [], errors: [] });
    mocks.archiveStaleIncompleteOrders.mockResolvedValue({ found: 0, limit: 2, hasMore: false, archived: 0, failed: 0, archivedOrderIds: [], errors: [] });
    mocks.drainNotificationOutbox.mockResolvedValue({ scanned: 0 });
    mocks.drainPaymentEvents.mockResolvedValue({ scanned: 0, processed: 0 });
    mocks.drainCatalogProjectionRebuild.mockResolvedValue(0);
    mocks.runScheduledEventMaintenance.mockResolvedValue({ events: { scanned: 0, dispatched: 0, settledWithoutSubscribers: 0, failed: 0, skipped: 0, deliveries: [] }, deliveries: 0, pluginDeliveries: 0 });

    // The minute whose rotation position is the inventory expiry job.
    const inventoryMinute = count * 1_000 + indexOf("inventory_expiry_sweep");
    await runScheduledMaintenance(env, ctx, { cron: "* * * * *", scheduledTime: minuteAt(inventoryMinute) });
    expect(mocks.releaseExpiredReservations).toHaveBeenCalledWith(mocks.db, 30, { limit: PLAN_LIMITS.free.maintenance.inventoryExpiryPerRun });
    expect(mocks.archiveStaleIncompleteOrders).not.toHaveBeenCalled();
    expect(mocks.cleanupStaleAbandonedCheckouts).not.toHaveBeenCalled();
    expect(mocks.drainNotificationOutbox).toHaveBeenCalledTimes(1);
    expect(mocks.runScheduledEventMaintenance).toHaveBeenCalledTimes(1);

    // The next minute runs the next job.
    vi.clearAllMocks();
    await runScheduledMaintenance(env, ctx, { cron: "* * * * *", scheduledTime: minuteAt(inventoryMinute + 1) });
    expect(mocks.releaseExpiredReservations).not.toHaveBeenCalled();
    const next = MAINTENANCE_SWEEPS[(indexOf("inventory_expiry_sweep") + 1) % count]!.name;
    expect(next).toBe("stale_incomplete_order_cleanup");
    expect(mocks.archiveStaleIncompleteOrders).toHaveBeenCalledWith(mocks.db, expect.any(Number), expect.objectContaining({ limit: PLAN_LIMITS.free.maintenance.staleOrdersPerRun }));
    expect(mocks.drainNotificationOutbox).toHaveBeenCalledTimes(1);
  });

  it("renders the rendition backlog in its turn, at the Free per-run limit", async () => {
    vi.stubGlobal("__SCALIUS_PLAN__", "free");
    const images = { info: vi.fn() };
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    mocks.backfillMissingMediaVariants.mockResolvedValueOnce({ scanned: 1, generated: 1, failed: 0, hasMore: true });
    const minute = count * 1_000 + indexOf("media_rendition_backfill");
    await runScheduledMaintenance({ BUCKET: {}, IMAGES: images } as unknown as Env, ctx, { scheduledTime: minuteAt(minute) });
    expect(mocks.backfillMissingMediaVariants).toHaveBeenCalledWith(
      mocks.db,
      expect.anything(),
      images,
      expect.objectContaining({ maxImages: PLAN_LIMITS.free.maintenance.inlineRenditionsPerRun }),
    );
  });
});
