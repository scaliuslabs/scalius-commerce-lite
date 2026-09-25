import { getDb } from "@scalius/database/client";
import { releaseExpiredReservations } from "@scalius/core/modules/inventory";
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
import { getCredentialEncryptionKey } from "./utils/encryption-key";
import { failStaleQueuedPaymentWebhookEvents } from "./utils/webhook-idempotency";
import { enqueueOrderRefundNotificationForOrder } from "./utils/order-notification-queue";
import { bumpCacheGeneration, syncCacheGenerationMirror } from "./utils/cache-generation";
import {
  isNightlyCatalogTick,
  queuePostDeployProjectionRebuild,
  runNightlyCatalogMaintenance,
} from "./scheduled/catalog-projections";

export const INVENTORY_EXPIRY_SWEEP_LIMIT = 50;
export const STALE_INCOMPLETE_ORDER_SWEEP_LIMIT = 25;
export const STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES = 60;
export const ABANDONED_CHECKOUT_SWEEP_LIMIT = 100;
export const ABANDONED_CHECKOUT_RETENTION_DAYS = 30;
export const EMPTY_ABANDONED_CHECKOUT_MAX_AGE_MINUTES = 60;
export const ORDER_NOTIFICATION_OUTBOX_SWEEP_LIMIT = 25;
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
 * call, up to eight Images transforms, eight R2 writes and a few D1 queries: a
 * few seconds of wall time but little Worker CPU (the transforms run in the
 * Images service). The backfill runs last and starts no new image once the
 * run is this old, so the run ends well inside the 15-minute cron wall limit
 * and before the next 15-minute tick starts.
 */
export const MEDIA_RENDITION_BACKFILL_DEADLINE_MS = 10 * 60 * 1_000;
/** Two originals (up to 20 MB each) in memory at once, two D1 connections. */
export const MEDIA_RENDITION_BACKFILL_CONCURRENCY = 2;
/** CPU guard against the 30 s cron CPU limit (~tens of ms of our CPU per image). */
export const MEDIA_RENDITION_BACKFILL_MAX_PER_RUN = 240;
/**
 * With the jobs queue, the backlog is fanned out instead of rendered inline
 * two at a time: up to this many images per 15-minute run, 10 `sendBatch`
 * calls of 100 (the Queues per-call limit), no delay. Queue consumers render
 * them in parallel (Queues runs up to 250 concurrent consumer invocations),
 * so a large backlog (the 0094 ladder migration sends every image back to
 * its original) is re-rendered within minutes instead of one 240-image run
 * per 15 minutes. Each job bumps the generation when it renders.
 * Each image is eight Images transforms: 1,000 images are 8,000 unique
 * transformations, billed per unique transformation per month (5,000
 * included; a free account stops transforming beyond that and its cards
 * keep their placeholders until the allowance resets).
 */
export const MEDIA_RENDITION_FANOUT_MAX_PER_RUN = 1_000;

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

async function runScheduledMaintenanceInner(
  env: Env,
  executionCtx: ExecutionContext,
  runContext: ScheduledRunContext,
): Promise<void> {
  const db = getDb(env);
  const timed = <T>(operation: string, fn: () => Promise<T>) =>
    timedScheduledOperation(runContext, operation, fn);
  // Each sweep is isolated: one that keeps failing (logged by `timed`) must
  // not starve the sweeps after it, above all the rendition backfill that runs
  // last. The run still fails with the first error once everything has run.
  const failures: unknown[] = [];
  const isolated = async (sweep: () => Promise<void>) => {
    try {
      await sweep();
    } catch (error) {
      failures.push(error);
    }
  };

  // Backstop for a KV mirror write that every bump pass missed. A KV outage is
  // logged by `timed` and must not block the commerce maintenance below.
  const mirrorRepaired = await timed("cache_generation_mirror_sync", () =>
    syncCacheGenerationMirror(env, db)).catch(() => false);
  if (mirrorRepaired) console.log("[scheduled] Cache generation mirror repaired");

  await isolated(async () => {
    const result = await timed("inventory_expiry_sweep", () =>
      releaseExpiredReservations(db, 30, {
        limit: INVENTORY_EXPIRY_SWEEP_LIMIT,
      }),
    );
    const expiryAvailabilityTransitions = result.availabilityTransitionVariantIds ?? [];
    if (expiryAvailabilityTransitions.length > 0) {
      await timed("inventory_expiry_cache_generation", () =>
        bumpCacheGeneration({ env, executionCtx }),
      );
    }

    console.log(
      `[scheduled] Inventory expiry sweep: found=${result.found}, released=${result.released}` +
        `, limit=${result.limit}, hasMore=${result.hasMore}` +
        (result.errors.length > 0 ? `, errors=${result.errors.length}` : ""),
    );
  });

  await isolated(async () => {
    const staleIncompleteCutoff = Math.floor(Date.now() / 1000) - STALE_INCOMPLETE_ORDER_MAX_AGE_MINUTES * 60;
    const staleIncompleteOrders = await timed("stale_incomplete_order_cleanup", () =>
      archiveStaleIncompleteOrders(db, staleIncompleteCutoff, {
        limit: STALE_INCOMPLETE_ORDER_SWEEP_LIMIT,
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
  });

  await isolated(async () => {
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
  });

  await isolated(async () => {
    const notificationOutbox = await timed("notification_outbox_flush", () =>
      flushPendingNotificationOutbox({
        db,
        queue: env.JOBS_QUEUE,
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
  });

  await isolated(async () => {
    // Automatic fulfilment backstop (Wave A §2.6): settled orders whose digital
    // or gift-card lines were not handed over. A no-op until Wave B registers
    // an automatic fulfiller.
    const autoFulfil = await timed("auto_fulfil_sweep", () => sweepAutoFulfilment(db));
    if (autoFulfil.scanned > 0 || autoFulfil.failed > 0) {
      console.log(
        `[scheduled] Auto-fulfil sweep: scanned=${autoFulfil.scanned}, ` +
          `fulfilled=${autoFulfil.fulfilled}, failed=${autoFulfil.failed}`,
      );
    }
  });

  await isolated(async () => {
    // Conversation images uploaded but never attached within an hour.
    const orphanAttachments = await timed("conversation_attachment_sweep", () =>
      sweepOrphanConversationAttachments(db, env.BUCKET),
    );
    if (orphanAttachments.scanned > 0) {
      console.log(
        `[scheduled] Conversation attachment sweep: scanned=${orphanAttachments.scanned}, deleted=${orphanAttachments.deleted}`,
      );
    }
  });

  await isolated(async () => {
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
  });

  await isolated(async () => {
    const refundReconciliation = await timed("refund_attempt_reconciliation", () =>
      reconcileDueRefundAttempts(db, {
        encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
        limit: REFUND_ATTEMPT_RECONCILIATION_LIMIT,
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
  });

  await isolated(async () => {
    const externalRefunds = await timed("external_refund_reconciliation", () =>
      reconcileExternalRefundWebhooks(db, {
        encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
        limit: EXTERNAL_REFUND_RECONCILIATION_LIMIT,
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
  });

  await isolated(async () => {
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
  });

  await isolated(async () => {
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
  });

  await isolated(async () => {
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
  });

  await isolated(async () => {
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
  });

  await isolated(async () => {
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
  });

  await isolated(async () => {
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
  });

  await isolated(async () => {
    // Identity handoff audit rows double as the single-use token ledger; they
    // are retained for 90 days after the token expired, then pruned by index.
    const handoffEventsPruned = await timed("identity_handoff_audit_prune", () =>
      pruneExpiredIdentityHandoffEvents(db),
    );
    if (handoffEventsPruned > 0) {
      console.log(`[scheduled] Identity handoff audit prune: deleted=${handoffEventsPruned}`);
    }
  });

  // The first tick of a new API version heals writes the previous version
  // committed after the migration (scheduled/catalog-projections.ts).
  const postDeployRebuild = await timed("post_deploy_projection_rebuild", () =>
    queuePostDeployProjectionRebuild(env)).catch(() => false);
  if (postDeployRebuild) console.log("[scheduled] Queued the post-deploy catalogue projection rebuild");

  // Once a day: sales stats, the queued projection rebuild and a bounded
  // recommendation refresh (scheduled/catalog-projections.ts).
  if (isNightlyCatalogTick(runContext.scheduledAt)) {
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
  // Runs even when a sweep above failed. Without the IMAGES binding nothing
  // can render.
  await isolated(async () => {
    const images = env.IMAGES;
    if (images) {
      const queue = env.JOBS_QUEUE;
      if (queue) {
        const fanout = await timed("media_rendition_fanout", () =>
          enqueueMediaVariantsBacklog(db, queue, { skip: 0, limit: MEDIA_RENDITION_FANOUT_MAX_PER_RUN }),
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
          maxImages: MEDIA_RENDITION_BACKFILL_MAX_PER_RUN,
        }),
      );
      if (renditions.scanned > 0) {
        console.log(
          `[scheduled] Media rendition backfill: scanned=${renditions.scanned}, ` +
            `generated=${renditions.generated}, failed=${renditions.failed}, hasMore=${renditions.hasMore}`,
        );
      }
      if (renditions.generated > 0) {
        await timed("media_rendition_cache_generation", () =>
          bumpCacheGeneration({ env, executionCtx }),
        );
      }
    }
  });

  if (failures.length > 0) throw failures[0];
}
