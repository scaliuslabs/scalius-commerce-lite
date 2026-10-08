import { getDb } from "@scalius/database/client";
import { releaseExpiredReservations } from "@scalius/core/modules/inventory";
import { sweepReviewRequests } from "@scalius/core/modules/reviews";
import { sweepDigitalUploads } from "@scalius/core/modules/digital";
import { cleanupStaleAbandonedCheckouts } from "@scalius/core/modules/checkout";
import {
  cleanupExpiredOrderPaymentRecoveryChallenges,
  archiveStaleIncompleteOrders,
} from "@scalius/core/modules/orders";
import { flushPendingNotificationOutbox } from "@scalius/core/modules/notifications";
import { sweepAutoFulfilment } from "@scalius/core/modules/fulfilment";
import { sweepOrphanConversationAttachments } from "@scalius/core/modules/conversations";
import { flushPendingMetaPurchaseOutbox } from "@scalius/core/integrations/meta/purchase-outbox";
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
import { backfillMissingMediaVariants, enqueueMediaVariantsBacklog } from "@scalius/core/modules/media";
import { planLimits } from "@scalius/shared/plan-limits";
import { getCredentialEncryptionKey } from "./utils/encryption-key";
import { failStaleQueuedPaymentWebhookEvents } from "./utils/webhook-idempotency";
import { appPaymentProvidersLoader } from "./plugins/providers/payment";
import { enqueueOrderRefundNotificationForOrder } from "./utils/order-notification-queue";
import { bulkQueueState } from "./utils/queue-lanes";
import { maintenanceSliceDue, type SweepSlice } from "./scheduled/slices";
import {
  isNightlyCatalogTick,
  queuePostDeployProjectionRebuild,
  runNightlyCatalogMaintenance,
} from "./scheduled/catalog-projections";
import { storeTimeZoneOf } from "./utils/store-time-zone";

export const INVENTORY_EXPIRY_SWEEP_LIMIT = 50;
export const STALE_INCOMPLETE_ORDER_SWEEP_LIMIT = 25;
export const STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES = 60;
export const ABANDONED_CHECKOUT_SWEEP_LIMIT = 100;
export const ABANDONED_CHECKOUT_RETENTION_DAYS = 30;
export const EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES = 60;
/** Due outbox rows per run, sent by `sendBatch` (Wave B §11.3): 19,200/day at the 15-minute cron. */
export const ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT = 200;
/** Due review requests turned into outbox rows per run (Wave B §2.3). */
export const REVIEW_REQUEST_SWEEP_LIMIT = 100;
export const META_PURCHASE_OUTBOX_SWEEP_LIMIT = 25;
export const CUSTOMER_AUTH_OTP_SWEEP_LIMIT = 200;
export const ORDER_PAYMENT_RECOVERY_OTP_SWEEP_LIMIT = 200;
export const CUSTOMER_AUTH_OTP_RATE_LIMIT_SWEEP_LIMIT = 200;
export const CUSTOMER_SESSION_SWEEP_LIMIT = 200;
export const SCANNER_TOKEN_CLAIM_SWEEP_LIMIT = 200;
export const REFUND_ATTEMPT_RECONCILIATION_LIMIT = 5;
export const EXTERNAL_REFUND_RECONCILIATION_LIMIT = 5;
export const STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT = 25;
export const STALE_QUEUED_PAYMENT_WEBHOOK_MAX_AGE_MINUTES = 6 * 60;
/**
 * Rendition backfill budget. Each image costs one R2 read, one Images info
 * call, up to thirteen Images transforms and R2 writes, and a few D1 queries: a
 * few seconds of wall time but little Worker CPU (the transforms run in the
 * Images service). The backfill runs last and starts no new image once the
 * run is this old, so the run ends well inside the 15-minute cron wall limit
 * and before the next 15-minute tick starts. How many images a run renders
 * itself is `planLimits().maintenance.inlineRenditionsPerRun` (a CPU guard).
 */
export const MEDIA_RENDITION_BACKFILL_DEADLINE_MS = 10 * 60 * 1_000;
/** Two originals (up to 20 MB each) in memory at once, two D1 connections. */
export const MEDIA_RENDITION_BACKFILL_CONCURRENCY = 2;

/**
 * With the jobs queue, the rendition backlog is fanned out instead of rendered
 * inline two at a time: one page of jobs per run
 * (`planLimits().queue.bulkPageSize`, sent in `sendBatch` calls of 100, the
 * Queues per-call limit), and only as many as fit under the plan's bulk backlog
 * limit (utils/queue-lanes.ts), so urgent messages never wait behind a large
 * fan-out. Queue consumers render them in parallel (Queues runs up to 250
 * concurrent consumer invocations), so on a plan with a large page a large
 * backlog (the 0094 ladder migration sends every image back to its original) is
 * re-rendered within minutes. Each job bumps the generation when it renders.
 * Each image is up to thirteen Images transforms (the 1.2x ladder): 1,000
 * images are 13,000 unique transformations, billed per unique transformation
 * per month (5,000 included; a free account stops transforming beyond that
 * and its cards keep their placeholders until the allowance resets). New
 * dashboard uploads encode their ladder in the browser and cost none.
 */

export { MAINTENANCE_TICK_MS, maintenanceSliceDue, maintenanceTick } from "./scheduled/slices";

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
      queue: env.JOBS_QUEUE,
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

export interface SweepContext {
  db: ReturnType<typeof getDb>;
  env: Env;
  executionCtx: ExecutionContext;
  runContext: ScheduledRunContext;
  timed: <T>(operation: string, fn: () => Promise<T>) => Promise<T>;
}

export interface MaintenanceSweep {
  name: string;
  slice: SweepSlice;
  run(context: SweepContext): Promise<void>;
}

/**
 * Each sweep is isolated: one that keeps failing (logged by `timed`) must not
 * starve the sweeps after it, above all the rendition backfill that runs last.
 * The run still fails with the first error once everything has run. Slices
 * hold the sweeps that fit together within a Free invocation (about 12 D1
 * queries and 3 ms of CPU each, measured: scripts/free-plan-budget.mjs).
 */
export const MAINTENANCE_SWEEPS: readonly MaintenanceSweep[] = [
  {
    // A reservation expires after 30 minutes; stock waits at most one more tick on Paid, one hour on Free.
    name: "inventory_expiry_sweep",
    slice: 0,
    async run({ db, timed }) {
      const result = await timed("inventory_expiry_sweep", () =>
        releaseExpiredReservations(db, 30, {
          limit: scaled(INVENTORY_EXPIRY_SWEEP_LIMIT),
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
    name: "stale_incomplete_order_cleanup",
    slice: 1,
    async run({ db, timed }) {
      const staleIncompleteCutoff = Math.floor(Date.now() / 1000) - STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES * 60;
      const staleIncompleteOrders = await timed("stale_incomplete_order_cleanup", () =>
        archiveStaleIncompleteOrders(db, staleIncompleteCutoff, {
          limit: scaled(STALE_INCOMPLETE_ORDER_SWEEP_LIMIT),
        }),
      );
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
    slice: 1,
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
    slice: 1,
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
    slice: 1,
    async run({ db, env, timed }) {
      const autoFulfil = await timed("auto_fulfil_sweep", () => sweepAutoFulfilment(db, undefined, {
        credentialEncryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
      }));
      if (autoFulfil.scanned > 0 || autoFulfil.failed > 0) {
        console.log(
          `[scheduled] Auto-fulfil sweep: scanned=${autoFulfil.scanned}, ` +
            `fulfilled=${autoFulfil.fulfilled}, failed=${autoFulfil.failed}`,
        );
      }
    },
  },
  {
    // Every tick: an order or staff notification a buyer waits for.
    name: "notification_outbox_flush",
    slice: "every",
    async run({ db, env, timed }) {
      const notificationOutbox = await timed("notification_outbox_flush", () =>
        flushPendingNotificationOutbox({
          db,
          queue: env.JOBS_QUEUE,
          limit: scaled(ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT),
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
    },
  },
  {
    // Conversation images uploaded but never attached within an hour.
    name: "conversation_attachment_sweep",
    slice: 2,
    async run({ db, env, timed }) {
      const orphanAttachments = await timed("conversation_attachment_sweep", () =>
        sweepOrphanConversationAttachments(db, env.BUCKET),
      );
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
    slice: 2,
    async run({ db, env, timed }) {
      const digitalUploads = await timed("digital_upload_sweep", () =>
        sweepDigitalUploads(db, env.BUCKET),
      );
      if (digitalUploads.aborted > 0) {
        console.log(`[scheduled] Digital upload sweep: aborted=${digitalUploads.aborted}`);
      }
    },
  },
  {
    name: "meta_purchase_outbox_flush",
    slice: 2,
    async run({ db, env, timed }) {
      const metaPurchaseOutbox = await timed("meta_purchase_outbox_flush", () =>
        flushPendingMetaPurchaseOutbox({
          db,
          storefrontUrl: env.STOREFRONT_URL,
          encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
          limit: scaled(META_PURCHASE_OUTBOX_SWEEP_LIMIT),
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
    },
  },
  {
    name: "refund_attempt_reconciliation",
    slice: 0,
    async run({ db, env, timed }) {
      const refundReconciliation = await timed("refund_attempt_reconciliation", () =>
        reconcileDueRefundAttempts(db, {
          encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
          limit: scaled(REFUND_ATTEMPT_RECONCILIATION_LIMIT),
          providers: appPaymentProvidersLoader(env, db),
        }),
      );
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
    },
  },
  {
    name: "external_refund_reconciliation",
    slice: 0,
    async run({ db, env, timed }) {
      const externalRefunds = await timed("external_refund_reconciliation", () =>
        reconcileExternalRefundWebhooks(db, {
          encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
          limit: scaled(EXTERNAL_REFUND_RECONCILIATION_LIMIT),
          providers: appPaymentProvidersLoader(env, db),
        }),
      );
      if (externalRefunds.refundNotifications.length > 0) {
        await timed("external_refund_notification_enqueue", () =>
          enqueueReconciledRefundNotifications(db, env, externalRefunds.refundNotifications),
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
    name: "stale_queued_payment_webhook_sweep",
    slice: 0,
    async run({ db, timed }) {
      const staleQueuedPaymentWebhookCutoff =
        Math.floor(Date.now() / 1000) - STALE_QUEUED_PAYMENT_WEBHOOK_MAX_AGE_MINUTES * 60;
      const staleQueuedPaymentWebhooks = await timed("stale_queued_payment_webhook_sweep", () =>
        failStaleQueuedPaymentWebhookEvents(
          db,
          staleQueuedPaymentWebhookCutoff,
          { limit: scaled(STALE_QUEUED_PAYMENT_WEBHOOK_SWEEP_LIMIT) },
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
    },
  },
  {
    name: "customer_auth_otp_challenge_cleanup",
    slice: 2,
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
    slice: 2,
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
    slice: 3,
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
    slice: 3,
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
    slice: 3,
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
    // Identity handoff audit rows double as the single-use token ledger; they
    // are retained for 90 days after the token expired, then pruned by index.
    name: "identity_handoff_audit_prune",
    slice: 3,
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
    // Event outbox (COMMERCE-HOOKS H3): the at-least-once backstop for events
    // no post-write flush handed over, due webhook retries, then retention.
    // Every tick: a merchant's webhook consumer is waiting on it.
    name: "event_outbox_maintenance",
    slice: "every",
    async run({ db, env, timed }) {
      const { runScheduledEventMaintenance } = await import("./events/dispatch");
      const events = await timed("event_outbox_maintenance", () => runScheduledEventMaintenance(db, env));
      if (
        events.events.scanned > 0
        || events.deliveries.scanned > 0
        || events.pluginDeliveries.scanned > 0
      ) {
        console.log(
          `[scheduled] Event outbox: scanned=${events.events.scanned}, enqueued=${events.events.enqueued}, ` +
            `settledWithoutSubscribers=${events.events.settledWithoutSubscribers}, failed=${events.events.failed}, ` +
            `deliveriesScanned=${events.deliveries.scanned}, deliveriesEnqueued=${events.deliveries.enqueued}, ` +
            `pluginDeliveriesScanned=${events.pluginDeliveries.scanned}, pluginDeliveriesEnqueued=${events.pluginDeliveries.enqueued}`,
        );
      }
    },
  },
  {
    // Retention of settled events and deliveries, after the dispatch sweep.
    name: "event_outbox_retention",
    slice: 3,
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
    // the deployed code, then due cron slots (each claimed once). Every tick:
    // a plugin's schedule is the merchant's, not ours to thin out.
    name: "plugin_maintenance",
    slice: "every",
    async run({ db, env, executionCtx, runContext, timed }) {
      const { runScheduledPluginMaintenance } = await import("./plugins/scheduled");
      const plugins = await timed("plugin_maintenance", () =>
        runScheduledPluginMaintenance(db, env, executionCtx, runContext.scheduledAt, {
          nightly: isNightlyCatalogTick(runContext.scheduledAt, storeTimeZoneOf(env)),
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
  const isolated = async (sweep: () => Promise<void>) => {
    try {
      await sweep();
    } catch (error) {
      failures.push(error);
    }
  };

  const slices = planLimits().maintenance.slices;
  const context: SweepContext = { db, env, executionCtx, runContext, timed };
  for (const sweep of MAINTENANCE_SWEEPS) {
    if (!maintenanceSliceDue(runContext.scheduledAt, sweep.slice, slices)) continue;
    await isolated(() => sweep.run(context));
  }

  // The first tick of a new API version heals writes the previous version
  // committed after the migration (scheduled/catalog-projections.ts).
  const postDeployRebuild = await timed("post_deploy_projection_rebuild", () =>
    queuePostDeployProjectionRebuild(env)).catch(() => false);
  if (postDeployRebuild) console.log("[scheduled] Queued the post-deploy catalogue projection rebuild");

  // Once a day: sales stats, the queued projection rebuild and a bounded
  // recommendation refresh (scheduled/catalog-projections.ts).
  if (isNightlyCatalogTick(runContext.scheduledAt, storeTimeZoneOf(env))) {
    // Logged by `timed`; a failure must not block the media backfill below.
    const nightly = await timed("nightly_catalog_maintenance", () =>
      runNightlyCatalogMaintenance(db, env, runContext.scheduledAt!),
    ).catch(() => null);
    if (nightly) {
      console.log(
        `[scheduled] Nightly catalogue: salesStatsProducts=${nightly.salesStatsProducts}, ` +
          `recommendationMessages=${nightly.recommendationMessages}, rebuildQueued=${nightly.rebuildQueued}`,
      );
    }
  }

  // Images that still publish only their original get WebP renditions until
  // none are left or the run's time budget is spent. Rendition URLs replace
  // the published image URLs, so one generation bump per run that saved any.
  // Runs even when a sweep above failed, and in its own slice on a plan that
  // rotates them. Without the IMAGES binding nothing can render.
  if (maintenanceSliceDue(runContext.scheduledAt, 3, slices)) {
    await isolated(() => renderRenditionBacklog(context));
  }

  if (failures.length > 0) throw failures[0];
}

/**
 * The rendition backlog: one page of queue jobs, as many as the bulk lane has
 * room for. Only a missing queue, a failing one or one with nothing to take renders inline, and then no more
 * than the plan's inline limit (a full queue is a reason to wait, not to do
 * the queue's work in the cron).
 */
async function renderRenditionBacklog({ db, env, runContext, timed }: SweepContext): Promise<void> {
  const images = env.IMAGES;
  if (!images) return;
  const limits = planLimits();
  const queue = env.JOBS_QUEUE;
  if (queue) {
    const state = await bulkQueueState(queue, limits.queue);
    if (state.capacity === 0) {
      console.log(`[scheduled] Media rendition backlog: queue busy (backlog=${state.backlog ?? "unknown"}), waiting for the next tick`);
      return;
    }
    // Jobs already queued are the oldest candidates: start behind them.
    const fanout = await timed("media_rendition_fanout", () =>
      enqueueMediaVariantsBacklog(db, queue, { skip: state.backlog ?? 0, limit: state.capacity }),
    ).catch(() => null);
    if (fanout && fanout.queued > 0) {
      console.log(`[scheduled] Media rendition backlog: queued=${fanout.queued}, hasMore=${fanout.hasMore}`);
      return;
    }
  }
  // No queue, or it refused the backlog: render inline.
  const renditions = await timed("media_rendition_backfill", () =>
    backfillMissingMediaVariants(db, env.BUCKET, images, {
      deadline: runContext.startedAt + MEDIA_RENDITION_BACKFILL_DEADLINE_MS,
      concurrency: MEDIA_RENDITION_BACKFILL_CONCURRENCY,
      maxImages: limits.maintenance.inlineRenditionsPerRun,
    }),
  );
  if (renditions.scanned > 0) {
    console.log(
      `[scheduled] Media rendition backfill: scanned=${renditions.scanned}, ` +
        `generated=${renditions.generated}, failed=${renditions.failed}, hasMore=${renditions.hasMore}`,
    );
  }
}
