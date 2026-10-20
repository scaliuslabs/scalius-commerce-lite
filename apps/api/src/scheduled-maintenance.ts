import { getDb } from "@scalius/database/client";
import { runWithReadObserver } from "@scalius/database/read-observer";
import { createEventWriteObserver } from "./middleware/event-dispatch";
import { publishRealtime, tableChanges } from "./realtime/publish";
import { compactCacheDeps } from "@scalius/database/cache-dep-writes";
import { releaseExpiredReservations } from "@scalius/core/modules/inventory";
import { sweepReviewRequests } from "@scalius/core/modules/reviews";
import { sweepDigitalUploads } from "@scalius/core/modules/digital";
import { cleanupStaleAbandonedCheckouts } from "@scalius/core/modules/checkout";
import {
  cleanupExpiredOrderPaymentRecoveryChallenges,
  archiveStaleIncompleteOrders,
} from "@scalius/core/modules/orders";
import { pruneStaffAlerts } from "@scalius/core/modules/notifications";
import { sealAnalyticsDays } from "@scalius/core/modules/analytics";
import { sweepAutoFulfilment } from "@scalius/core/modules/fulfilment";
import { sweepOrphanConversationAttachments } from "@scalius/core/modules/conversations";
import { flushPendingMetaPurchaseOutbox } from "@scalius/core/integrations/meta/purchase-outbox";
import { planTrackingSweep } from "@scalius/core/integrations/tracking/deliveries";
import {
  cleanupExpiredCustomerAuthOtpChallenges,
  cleanupExpiredCustomerAuthOtpRateLimits,
  cleanupExpiredCustomerSessions,
} from "@scalius/core/modules/customers";
import {
  cleanupExpiredScannerTokenClaims,
  pruneExpiredIdentityHandoffEvents,
} from "@scalius/core/auth";
import { reconcileDueRefundAttempts, reconcileExternalRefundWebhooks } from "@scalius/core/modules/payments";
import { planLimits } from "@scalius/shared/plan-limits";
import { getCredentialEncryptionKey } from "./utils/encryption-key";
import { appPaymentProvidersLoader } from "./plugins/providers/payment";
import { sendOrderRefundNotification } from "./utils/order-notifications";
import { dueSweepIndexes, firstSweepRunOfHour } from "./scheduled/slices";
import {
  isNightlyCatalogTick,
  requestPostDeployProjectionRebuild,
  runNightlyCatalogMaintenance,
} from "./scheduled/catalog-projections";
import { drainCatalogProjectionRebuild, rotateRecommendations } from "./background/catalog";
import { readMaintenanceCursor } from "./scheduled/cursor";
import { maintainDerivedProjections } from "./scheduled/derived-projections";
import { storeTimeZoneOf } from "./utils/store-time-zone";

export const STALE_INCOMPLETE_ORDER_SWEEP_LIMIT = 25;
export const STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES = 60;
export const ABANDONED_CHECKOUT_SWEEP_LIMIT = 100;
export const ABANDONED_CHECKOUT_RETENTION_DAYS = 30;
export const EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES = 60;
/** Due review requests turned into outbox rows per run (Wave B §2.3). */
export const REVIEW_REQUEST_SWEEP_LIMIT = 100;
export const META_PURCHASE_OUTBOX_SWEEP_LIMIT = 25;
export const TRACKING_DELIVERY_SWEEP_LIMIT = 10;
export const TRACKING_PURGE_SWEEP_LIMIT = 200;
export const CUSTOMER_AUTH_OTP_SWEEP_LIMIT = 200;
export const ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT = 200;
export const CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT = 200;
export const CUSTOMER_SESSION_SWEEP_LIMIT = 200;
export const SCANNER_TOKEN_CLAIM_SWEEP_LIMIT = 200;
export const REFUND_ATTEMPT_RECONCILIATION_LIMIT = 5;
export const EXTERNAL_REFUND_RECONCILIATION_LIMIT = 5;
export { DRAIN_TICK_MS, dueSweepIndexes, firstSweepRunOfHour, sweepPeriodMinutes } from "./scheduled/slices";

type ScheduledMaintenanceMetadata = {
  cron?: string;
  scheduledTime?: number;
};

type ScheduledRunContext = {
  runId: string;
  startedAt: number;
  cron: string;
  scheduledTime: string;
  scheduledAt: number | undefined;
};

/** A sweep's row limit under the plan: the full limit on Paid, a fraction on Free. */
function scaled(limit: number): number {
  return Math.max(1, Math.floor(limit * planLimits().maintenance.limitScale));
}

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
    scheduledAt: typeof metadata.scheduledTime === "number" ? metadata.scheduledTime : undefined,
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

async function recordReconciledRefundNotifications(
  db: ReturnType<typeof getDb>,
  notifications: Array<{
    orderId: string;
    notificationType: "refund_processing" | "refund_failed" | "order_refunded" | "order_partially_refunded";
    dedupeKey: string;
    amount: number;
    refundId?: string;
  }>,
): Promise<void> {
  for (const notification of notifications) {
    const result = await sendOrderRefundNotification({
      db,
      // The notification drain sends it on the next tick.
      send: undefined,
      orderId: notification.orderId,
      notificationType: notification.notificationType,
      dedupeKey: notification.dedupeKey,
      source: "refund-reconciliation",
      data: {
        amount: notification.amount,
        ...(notification.refundId ? { refundId: notification.refundId } : {}),
      },
    });

    if (result.skippedReason === "record_failed" || result.skippedReason === "order_missing") {
      console.log(
        `[scheduled] Reconciled refund notification for order ${notification.orderId} ` +
          `not recorded: ${result.skippedReason}`,
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

export interface SweepContext {
  db: ReturnType<typeof getDb>;
  env: Env;
  executionCtx: ExecutionContext;
  runContext: ScheduledRunContext;
  timed: <T>(operation: string, fn: () => Promise<T>) => Promise<T>;
}

export interface MaintenanceSweep {
  name: string;
  run(context: SweepContext): Promise<void>;
}

/**
 * The sweep rotation (scheduled/slices.ts): Paid runs every job every 15
 * minutes; Free runs one job a minute beside the drains, so each job and the
 * drains together fit 50 D1 queries (apps/api/src/maintenance-budget.test.ts).
 * Each job is isolated: one that keeps failing (logged by `timed`) must not
 * starve the jobs after it. The run still fails with the first error once
 * everything has run.
 */
export const MAINTENANCE_SWEEPS: readonly MaintenanceSweep[] = [
  {
    // A reservation expires after 30 minutes; stock waits at most one more rotation.
    name: "inventory_expiry_sweep",
    async run({ db, timed }) {
      const result = await timed("inventory_expiry_sweep", () =>
        releaseExpiredReservations(db, 30, {
          limit: planLimits().maintenance.inventoryExpiryPerRun,
        }),
      );
      console.log(
        `[scheduled] Inventory expiry sweep: found=${result.found}, released=${result.released}` +
          `, limit=${result.limit}, hasMore=${result.hasMore}` +
          (result.errors.length > 0 ? `, errors=${result.errors.length}` : ""),
      );
    },
  },
  {
    // Each order is a bounded repair (inventory, gift cards), a few per run on Free.
    name: "stale_incomplete_order_cleanup",
    async run({ db, timed }) {
      const staleIncompleteCutoff = Math.floor(Date.now() / 1000) - STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES * 60;
      const cursor = await readMaintenanceCursor(db, "stale-orders");
      const staleIncompleteOrders = await timed("stale_incomplete_order_cleanup", () =>
        archiveStaleIncompleteOrders(db, staleIncompleteCutoff, {
          limit: planLimits().maintenance.staleOrdersPerRun,
          afterOrderId: cursor?.value.orders,
          afterGiftCardOrderId: cursor?.value.giftCards,
        }),
      );
      await cursor.save({ orders: staleIncompleteOrders.lastOrderId, giftCards: staleIncompleteOrders.lastGiftCardOrderId });
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
    },
  },
  {
    name: "abandoned_checkout_cleanup",
    async run({ db, timed }) {
      const abandonedCheckoutCleanup = await timed("abandoned_checkout_cleanup", () =>
        cleanupStaleAbandonedCheckouts(db, Math.floor(Date.now() / 1000), {
          retentionDays: ABANDONED_CHECKOUT_RETENTION_DAYS,
          emptyMaxAgeMinutes: EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES,
          limit: scaled(ABANDONED_CHECKOUT_SWEEP_LIMIT),
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
    },
  },
  {
    // Due review requests become outbox rows before the next notification flush sends them.
    name: "review_request_sweep",
    async run({ db, timed }) {
      const reviewRequests = await timed("review_request_sweep", () =>
        sweepReviewRequests(db, { limit: scaled(REVIEW_REQUEST_SWEEP_LIMIT) }),
      );
      if (reviewRequests.queued > 0 || reviewRequests.skipped > 0) {
        console.log(
          `[scheduled] Review request sweep: queued=${reviewRequests.queued}, skipped=${reviewRequests.skipped}`,
        );
      }
    },
  },
  {
    // Automatic fulfilment backstop (Wave A §2.6): settled orders whose digital
    // or gift-card lines were not handed over. A no-op until Wave B registers
    // an automatic fulfiller. The mail it queues (keys, gift cards, the staff
    // key-exhausted alert) goes out with the next notification flush.
    name: "auto_fulfil_sweep",
    async run({ db, env, timed }) {
      // A cursor walks the awaiting orders, so a poison order is retried on
      // wrap without keeping a later healthy order behind it.
      const cursor = await readMaintenanceCursor(db, "auto-fulfil");
      const autoFulfil = await timed("auto_fulfil_sweep", () => sweepAutoFulfilment(db, undefined, {
        credentialEncryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
      }, { limit: planLimits().background.autoFulfilPerRun, afterOrderId: cursor.value.orders }));
      await cursor.save({ orders: autoFulfil.lastOrderId });
      if (autoFulfil.scanned > 0 || autoFulfil.failed > 0) {
        console.log(
          `[scheduled] Auto-fulfil sweep: scanned=${autoFulfil.scanned}, ` +
            `fulfilled=${autoFulfil.fulfilled}, failed=${autoFulfil.failed}`,
        );
      }
    },
  },
  {
    // Conversation images uploaded but never attached within an hour.
    name: "conversation_attachment_sweep",
    async run({ db, env, timed }) {
      const cursor = await readMaintenanceCursor(db, "orphan-attachments");
      const orphanAttachments = await timed("conversation_attachment_sweep", () =>
        sweepOrphanConversationAttachments(db, env.BUCKET, { limit: planLimits().maintenance.orphanAttachmentsPerRun, afterId: cursor.value.rows }),
      );
      await cursor.save({ rows: orphanAttachments.lastId });
      if (orphanAttachments.scanned > 0) {
        console.log(
          `[scheduled] Conversation attachment sweep: scanned=${orphanAttachments.scanned}, deleted=${orphanAttachments.deleted}`,
        );
      }
    },
  },
  {
    // Digital file uploads abandoned for 24 hours (Wave B §3.1).
    name: "digital_upload_sweep",
    async run({ db, env, timed }) {
      const cursor = await readMaintenanceCursor(db, "digital-uploads");
      const digitalUploads = await timed("digital_upload_sweep", () =>
        sweepDigitalUploads(db, env.BUCKET, {
          limit: planLimits().maintenance.digitalUploadsPerState,
          afterUploadingId: cursor.value.uploading,
          afterReplacedId: cursor.value.replaced,
        }),
      );
      await cursor.save({ uploading: digitalUploads.lastUploadingId, replaced: digitalUploads.lastReplacedId });
      if (digitalUploads.aborted > 0) {
        console.log(`[scheduled] Digital upload sweep: aborted=${digitalUploads.aborted}`);
      }
    },
  },
  {
    // Server tracking (audit spec S4): Meta Purchase CAPI rows, then GA4 and
    // TikTok deliveries due a retry, then the tracking snapshots past their
    // 8 days and finished deliveries past 90. One job, so the rotation keeps
    // its length; the GA4/TikTok share stays small on Free (2 rows a run).
    name: "tracking_outbox_flush",
    async run({ db, env, timed, runContext }) {
      const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
      // One D1 call when idle: Meta's due rows, GA4/TikTok's and both purges.
      const trackingSweep = planTrackingSweep(db, {
        storefrontUrl: env.STOREFRONT_URL,
        encryptionKey,
        limit: scaled(TRACKING_DELIVERY_SWEEP_LIMIT),
        purgeLimit: scaled(TRACKING_PURGE_SWEEP_LIMIT),
        // Snapshots live 8 days: purging on the hour's first run is enough.
        purge: firstSweepRunOfHour(runContext.scheduledAt, MAINTENANCE_SWEEPS.length),
      });
      const metaPurchaseOutbox = await timed("meta_purchase_outbox_flush", () =>
        flushPendingMetaPurchaseOutbox({
          db,
          storefrontUrl: env.STOREFRONT_URL,
          encryptionKey,
          limit: scaled(META_PURCHASE_OUTBOX_SWEEP_LIMIT),
          batchWith: trackingSweep.statements,
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
      const tracking = await timed("tracking_delivery_flush", () =>
        trackingSweep.finish(metaPurchaseOutbox.batchedResults),
      );
      if (tracking.scanned > 0 || tracking.signalsPurged > 0 || tracking.deliveriesPurged > 0) {
        console.log(
          `[scheduled] Tracking deliveries: scanned=${tracking.scanned}, sent=${tracking.sent}, ` +
            `failed=${tracking.failed}, skipped=${tracking.skipped}, deferred=${tracking.deferred}, ` +
            `signalsPurged=${tracking.signalsPurged}, deliveriesPurged=${tracking.deliveriesPurged}`,
        );
      }
    },
  },
  {
    name: "refund_attempt_reconciliation",
    async run({ db, env, timed }) {
      const refundReconciliation = await timed("refund_attempt_reconciliation", () =>
        reconcileDueRefundAttempts(db, {
          encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
          limit: scaled(REFUND_ATTEMPT_RECONCILIATION_LIMIT),
          providers: appPaymentProvidersLoader(env, db),
        }),
      );
      if (refundReconciliation.refundNotifications.length > 0) {
        await timed("refund_reconciliation_notification_record", () =>
          recordReconciledRefundNotifications(db, refundReconciliation.refundNotifications),
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
    },
  },
  {
    name: "external_refund_reconciliation",
    async run({ db, env, timed }) {
      const externalRefunds = await timed("external_refund_reconciliation", () =>
        reconcileExternalRefundWebhooks(db, {
          encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
          limit: scaled(EXTERNAL_REFUND_RECONCILIATION_LIMIT),
          providers: appPaymentProvidersLoader(env, db),
        }),
      );
      if (externalRefunds.refundNotifications.length > 0) {
        await timed("external_refund_notification_record", () =>
          recordReconciledRefundNotifications(db, externalRefunds.refundNotifications),
        );
      }
      if (
        externalRefunds.scanned > 0 ||
        externalRefunds.imported > 0 ||
        externalRefunds.deferred > 0 ||
        externalRefunds.errors.length > 0 ||
        externalRefunds.hasMore
      ) {
        console.log(
          `[scheduled] External refund reconciliation: scanned=${externalRefunds.scanned}, ` +
            `imported=${externalRefunds.imported}, finalized=${externalRefunds.finalized}, ` +
            `skipped=${externalRefunds.skipped}, deferred=${externalRefunds.deferred}, ` +
            `errors=${externalRefunds.errors.length}, limit=${externalRefunds.limit}, ` +
            `hasMore=${externalRefunds.hasMore}`,
        );
      }
    },
  },
  {
    name: "customer_auth_otp_challenge_cleanup",
    async run({ db, timed }) {
      const customerAuthOtpCleanup = await timed("customer_auth_otp_challenge_cleanup", () =>
        cleanupExpiredCustomerAuthOtpChallenges(db, Math.floor(Date.now() / 1000), {
          limit: scaled(CUSTOMER_AUTH_OTP_SWEEP_LIMIT),
        }),
      );
      if (customerAuthOtpCleanup.scanned > 0 || customerAuthOtpCleanup.hasMore) {
        console.log(
          `[scheduled] Customer auth OTP cleanup: scanned=${customerAuthOtpCleanup.scanned}, ` +
            `deleted=${customerAuthOtpCleanup.deleted}, limit=${customerAuthOtpCleanup.limit}, ` +
            `hasMore=${customerAuthOtpCleanup.hasMore}`,
        );
      }
    },
  },
  {
    name: "order_payment_recovery_otp_cleanup",
    async run({ db, timed }) {
      const paymentRecoveryOtpCleanup = await timed("order_payment_recovery_otp_cleanup", () =>
        cleanupExpiredOrderPaymentRecoveryChallenges(db, Math.floor(Date.now() / 1000), {
          limit: scaled(ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT),
        }),
      );
      if (paymentRecoveryOtpCleanup.scanned > 0 || paymentRecoveryOtpCleanup.hasMore) {
        console.log(
          `[scheduled] Order payment recovery OTP cleanup: scanned=${paymentRecoveryOtpCleanup.scanned}, ` +
            `deleted=${paymentRecoveryOtpCleanup.deleted}, limit=${paymentRecoveryOtpCleanup.limit}, ` +
            `hasMore=${paymentRecoveryOtpCleanup.hasMore}`,
        );
      }
    },
  },
  {
    name: "customer_auth_otp_rate_limit_cleanup",
    async run({ db, timed }) {
      const customerAuthOtpRateLimitCleanup = await timed("customer_auth_otp_rate_limit_cleanup", () =>
        cleanupExpiredCustomerAuthOtpRateLimits(db, Math.floor(Date.now() / 1000), {
          limit: scaled(CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT),
        }),
      );
      if (customerAuthOtpRateLimitCleanup.scanned > 0 || customerAuthOtpRateLimitCleanup.hasMore) {
        console.log(
          `[scheduled] Customer auth OTP rate-limit cleanup: scanned=${customerAuthOtpRateLimitCleanup.scanned}, ` +
            `deleted=${customerAuthOtpRateLimitCleanup.deleted}, limit=${customerAuthOtpRateLimitCleanup.limit}, ` +
            `hasMore=${customerAuthOtpRateLimitCleanup.hasMore}`,
        );
      }
    },
  },
  {
    name: "customer_session_cleanup",
    async run({ db, timed }) {
      const customerSessionCleanup = await timed("customer_session_cleanup", () =>
        cleanupExpiredCustomerSessions(db, Math.floor(Date.now() / 1000), {
          limit: scaled(CUSTOMER_SESSION_SWEEP_LIMIT),
        }),
      );
      if (customerSessionCleanup.scanned > 0 || customerSessionCleanup.hasMore) {
        console.log(
          `[scheduled] Customer session cleanup: scanned=${customerSessionCleanup.scanned}, ` +
            `deleted=${customerSessionCleanup.deleted}, limit=${customerSessionCleanup.limit}, ` +
            `hasMore=${customerSessionCleanup.hasMore}`,
        );
      }
    },
  },
  {
    name: "scanner_token_claim_cleanup",
    async run({ db, timed }) {
      const scannerTokenClaimsCleanup = await timed("scanner_token_claim_cleanup", () =>
        cleanupExpiredScannerTokenClaims(db, {
          nowSeconds: Math.floor(Date.now() / 1000),
          limit: scaled(SCANNER_TOKEN_CLAIM_SWEEP_LIMIT),
        }),
      );
      if (scannerTokenClaimsCleanup.scanned > 0 || scannerTokenClaimsCleanup.hasMore) {
        console.log(
          `[scheduled] Scanner token claim cleanup: scanned=${scannerTokenClaimsCleanup.scanned}, ` +
            `deleted=${scannerTokenClaimsCleanup.deleted}, limit=${scannerTokenClaimsCleanup.limit}, ` +
            `hasMore=${scannerTokenClaimsCleanup.hasMore}`,
        );
      }
    },
  },
  {
    // Finished UTC days become analytics buckets; until then reports read their facts.
    name: "analytics_seal",
    async run({ db, timed }) {
      const sealed = await timed("analytics_seal", () => sealAnalyticsDays(db));
      if (sealed > 0) console.log(`[scheduled] Analytics seal: days=${sealed}`);
    },
  },
  {
    // Bell history no reader or Undo can reach, and alerts no inbox row shows.
    name: "staff_alert_retention",
    async run({ db, timed }) {
      const pruned = await timed("staff_alert_retention", () => pruneStaffAlerts(db, Math.floor(Date.now() / 1000)));
      if (pruned.inbox > 0 || pruned.alerts > 0) {
        console.log(`[scheduled] Staff alert retention: inbox=${pruned.inbox}, alerts=${pruned.alerts}`);
      }
    },
  },
  {
    // Identity handoff audit rows double as the single-use token ledger; they
    // are retained for 90 days after the token expired, then pruned by index.
    name: "identity_handoff_audit_prune",
    async run({ db, timed }) {
      const handoffEventsPruned = await timed("identity_handoff_audit_prune", () =>
        pruneExpiredIdentityHandoffEvents(db),
      );
      if (handoffEventsPruned > 0) {
        console.log(`[scheduled] Identity handoff audit prune: deleted=${handoffEventsPruned}`);
      }
    },
  },
  {
    // Retention of settled events and deliveries, after the dispatch sweep.
    name: "event_outbox_retention",
    async run({ db, timed }) {
      const { runScheduledEventRetention } = await import("./events/dispatch");
      const pruned = await timed("event_outbox_retention", () => runScheduledEventRetention(db));
      if (pruned.events > 0 || pruned.deliveries > 0 || pruned.pluginDeliveries > 0) {
        console.log(
          `[scheduled] Event outbox retention: prunedEvents=${pruned.events}, prunedDeliveries=${pruned.deliveries}, ` +
            `prunedPluginDeliveries=${pruned.pluginDeliveries}`,
        );
      }
    },
  },
  {
    // Plugins (docs/platform/PLUGINS.md): bundled installations in step with
    // the deployed code, then due cron slots (each claimed once). Every sweep
    // tick: a plugin's schedule is the merchant's, not ours to thin out.
    name: "plugin_maintenance",
    async run({ db, env, executionCtx, runContext, timed }) {
      const { runScheduledPluginMaintenance } = await import("./plugins/scheduled");
      const plugins = await timed("plugin_maintenance", () =>
        runScheduledPluginMaintenance(db, env, executionCtx, runContext.scheduledAt, {
          fxDue: firstSweepRunOfHour(runContext.scheduledAt, MAINTENANCE_SWEEPS.length),
        }));
      const { bundled, cron, fx } = plugins;
      if (fx && fx.markets > 0) {
        console.log(`[scheduled] Market FX refresh: markets=${fx.markets}, changed=${fx.changed}, failed=${fx.failed}`);
      }
      if (bundled.installed.length > 0 || bundled.updated.length > 0 || bundled.failed.length > 0 || cron.due > 0 || cron.expired > 0) {
        console.log(
          `[scheduled] Plugins: installed=${bundled.installed.length}, updated=${bundled.updated.length}, ` +
            `syncFailed=${bundled.failed.length}, cronDue=${cron.due}, cronRan=${cron.ran}, cronFailed=${cron.failed}, ` +
            `cronSkipped=${cron.skipped}, cronDeferred=${cron.deferred}, cronExpired=${cron.expired}, ` +
            `prunedCronRuns=${plugins.prunedCronRuns}`,
        );
      }
    },
  },
  {
    // Every public product's recommendations in turn (background/catalog.ts).
    name: "recommendation_rotation",
    async run({ db, timed }) {
      const refreshed = await timed("recommendation_rotation", () => rotateRecommendations(db));
      if (refreshed > 0) console.log(`[scheduled] Recommendation rotation: refreshed=${refreshed}`);
    },
  },
  {
    // The first run of a new API version heals writes the previous version
    // committed after the migration (scheduled/catalog-projections.ts).
    name: "post_deploy_projection_rebuild",
    async run({ env, timed }) {
      const requested = await timed("post_deploy_projection_rebuild", () => requestPostDeployProjectionRebuild(env));
      if (requested) console.log("[scheduled] Requested the post-deploy catalogue projection rebuild");
    },
  },
  {
    // Agent access: expired OAuth grants and tokens, sealed artifacts and
    // browser handoffs. Cleanup, never on a buyer's path; each part retries
    // on the next turn.
    name: "agent_access_housekeeping",
    async run({ db, env }) {
      const parts: Array<() => Promise<unknown>> = [
        async () => (await import("./agent-access/oauth")).purgeExpiredOAuthData(env),
        async () => (await import("./agent-access/artifact-delivery")).purgeExpiredAgentArtifacts(env),
        async () => (await import("./agent-access/browser-handoffs")).expireAgentBrowserHandoffs(db),
      ];
      for (const part of parts) await part().catch(() => undefined);
    },
  },
];

/**
 * Every tick (every minute): the background drains. Each takes its plan's
 * bounded share of due rows (notifications, events and their deliveries,
 * payment-event retries, a requested projection rebuild) and leaves the rest
 * for the next tick. The first attempt of each happened right after the
 * write that created it; these are the retries and the backstop.
 */
export const BACKGROUND_DRAINS: ReadonlyArray<{ name: string; run(context: SweepContext): Promise<unknown> }> = [
  {
    name: "notification_drain",
    async run({ db, env }) {
      const { drainNotificationOutbox } = await import("./background/notifications");
      return drainNotificationOutbox(db, env);
    },
  },
  {
    name: "event_drain",
    async run({ db, env, executionCtx }) {
      const { runScheduledEventMaintenance } = await import("./events/dispatch");
      return runScheduledEventMaintenance(db, env, executionCtx);
    },
  },
  {
    name: "payment_event_drain",
    async run({ db, env, executionCtx }) {
      const { drainPaymentEvents } = await import("./background/payment-events");
      return drainPaymentEvents(db, env, executionCtx);
    },
  },
  {
    name: "projection_rebuild_drain",
    run: ({ db }) => drainCatalogProjectionRebuild(db),
  },
  {
    // Bulk runs larger than one request (routes/admin/resources-bulk.ts).
    name: "bulk_run_drain",
    async run({ db }) {
      const { drainBulkRuns } = await import("./bulk-runs/engine");
      return drainBulkRuns(db, planLimits().background.bulkRunChunksPerDrain);
    },
  },
  {
    // PostgreSQL's dependency change log keeps each key's newest row (no query on D1 or Turso).
    name: "cache_dep_compaction",
    run: ({ db }) => compactCacheDeps(db),
  },
];

async function runScheduledMaintenanceInner(
  env: Env,
  executionCtx: ExecutionContext,
  runContext: ScheduledRunContext,
): Promise<void> {
  const db = getDb(env);
  const timed = <T>(operation: string, fn: () => Promise<T>) =>
    timedScheduledOperation(runContext, operation, fn);
  const failures: unknown[] = [];
  const writes = createEventWriteObserver();
  const publishChanges = () => publishRealtime(env, tableChanges(writes.realtimeTopics));
  const isolated = async (sweep: () => Promise<unknown>) => {
    try {
      await runWithReadObserver(writes, sweep);
    } catch (error) {
      failures.push(error);
    }
  };
  const context: SweepContext = { db, env, executionCtx, runContext, timed };

  // Once a day (the 02:00 store-time minute) the nightly pass has the
  // invocation to itself; the drains and the rotation continue next minute.
  if (isNightlyCatalogTick(runContext.scheduledAt, storeTimeZoneOf(env))) {
    await isolated(() => runNightlyPass(context));
    await publishChanges();
    if (failures.length > 0) throw failures[0];
    return;
  }

  // Every tick: the background drains, each isolated.
  for (const drain of BACKGROUND_DRAINS) {
    await isolated(() => timed(drain.name, () => drain.run(context)));
  }

  // A sweep tick: the rotation's next jobs (every job on Paid or a manual run).
  for (const index of dueSweepIndexes(runContext.scheduledAt, MAINTENANCE_SWEEPS.length)) {
    const sweep = MAINTENANCE_SWEEPS[index]!;
    await isolated(() => sweep.run(context));
  }

  await publishChanges();
  if (failures.length > 0) throw failures[0];
}

/** Sales stats, a projection rebuild request, sold products' recommendations, app storage sizes and a sampled drift check. */
async function runNightlyPass({ db, runContext, timed }: SweepContext): Promise<void> {
  const nightly = await timed("nightly_catalog_maintenance", () =>
    runNightlyCatalogMaintenance(db, runContext.scheduledAt!),
  );
  console.log(
    `[scheduled] Nightly catalogue: salesStatsProducts=${nightly.salesStatsProducts}, ` +
      `soldRecommendations=${nightly.soldRecommendations}`,
  );
  const { measurePluginStorage } = await import("./plugins/scheduled");
  await timed("plugin_storage_measure", () => measurePluginStorage(db));
  // A sampled drift check of the derived projections, repaired in place.
  const projections = await timed("derived_projection_check", () => maintainDerivedProjections(db));
  if (projections.analytics.drift || projections.recommendations.drift || projections.inbox.drift) {
    console.log(
      `[scheduled] Derived projections repaired: analytics=${projections.analytics.drift}, ` +
        `recommendations=${projections.recommendations.drift}, inbox=${projections.inbox.drift}`,
    );
  }
}
