// Retention of the per-order history that only grows: checkout idempotency
// rows, order receipt proofs, sent notifications and finished review
// requests. Workers Free caps a D1 database at 500 MB, so each is deleted once
// every window that reads it has closed. Each statement walks an index range
// that starts at the oldest expired row and stops at its limit, so a run
// reads about the rows it deletes, never the store's history.
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import {
    checkoutAttempts,
    notificationOutbox,
    orderReceipts,
    orderReviewRequests,
    orders,
} from "@scalius/database/schema";

const DAY = 86_400;

/**
 * How long each row outlives the windows that read it.
 *
 * - A checkout attempt is the request key's replay answer and the
 *   checkout-token receipt fallback (7 days, ORDER_RECEIPT_TOKEN_TTL_SECONDS);
 *   the storefront keeps a checkout for at most 7 days (hosted payment
 *   recovery). 30 days after its order is four times the longest of those, so
 *   a request key never replays into a second order.
 * - A receipt proof is dead at `expires_at` (every reader refuses it); one
 *   more day keeps a clock-skewed reader honest.
 * - A sent or dead-lettered notification's `dedupe_key` stops a second send of
 *   the same fact. Retries end within hours (8 attempts, at most an hour
 *   apart), payment webhooks and refund reconciliation within days; 180 days
 *   also keeps the order page's notification history for every order a
 *   merchant still handles.
 * - A queued or skipped review request is the one request its order gets (a
 *   later delivery of the same order adds none while it exists): kept a year.
 */
export const ORDER_HISTORY_RETENTION_DAYS = {
    checkoutAttempts: 30,
    receiptsAfterExpiry: 1,
    notifications: 180,
    reviewRequests: 365,
} as const;

/** Rows of each table one run deletes at most (Paid; Free scales it). */
export const ORDER_HISTORY_RETENTION_LIMIT = 50;

const FINISHED_NOTIFICATION_STATUSES = ["sent", "dead_lettered"];
const FINISHED_REVIEW_REQUEST_STATUSES = ["queued", "skipped"] as const;

export interface OrderHistoryRetentionResult {
    checkoutAttempts: number;
    receipts: number;
    notifications: number;
    reviewRequests: number;
    /** The checkout-attempt walk's position (an order `created_at`): pass it back next run. */
    checkoutCursor: string | null;
}

/**
 * One bounded retention pass, one D1 round trip. Checkout attempts carry no
 * time index of their own: they commit in their order's batch, so the pass
 * walks orders by `created_at` from `checkoutCursor` and deletes the attempts
 * of the orders it passes (by `order_id`).
 */
export async function pruneOrderHistory(
    db: Database,
    options: { nowSeconds: number; limit: number; checkoutCursor?: string | null },
): Promise<OrderHistoryRetentionResult> {
    const limit = Math.max(1, Math.floor(options.limit));
    const now = Math.floor(options.nowSeconds);
    const after = Number(options.checkoutCursor ?? 0);
    const cursor = Number.isSafeInteger(after) && after > 0 ? after : 0;
    const attemptCutoff = now - ORDER_HISTORY_RETENTION_DAYS.checkoutAttempts * DAY;
    const notificationCutoff = now - ORDER_HISTORY_RETENTION_DAYS.notifications * DAY;

    // The same page twice in one batch (one transaction): read, then its attempts deleted.
    const pageWhere = and(sql`${orders.createdAt} > ${cursor}`, sql`${orders.createdAt} < ${attemptCutoff}`);

    const [page, attempts, receipts, notifications, reviewRequests] = await safeBatch(db, [
        db.select({ id: orders.id, createdAt: sql<number>`${orders.createdAt}`.as("created_at") })
            .from(orders).where(pageWhere).orderBy(asc(orders.createdAt)).limit(limit),
        db.delete(checkoutAttempts)
            .where(inArray(checkoutAttempts.orderId, db.select({ id: orders.id })
                .from(orders).where(pageWhere).orderBy(asc(orders.createdAt)).limit(limit)))
            .returning({ id: checkoutAttempts.id }),
        db.delete(orderReceipts)
            .where(inArray(orderReceipts.tokenHash, db.select({ tokenHash: orderReceipts.tokenHash }).from(orderReceipts)
                .where(and(
                    eq(orderReceipts.status, "active"),
                    lt(orderReceipts.expiresAt, now - ORDER_HISTORY_RETENTION_DAYS.receiptsAfterExpiry * DAY),
                ))
                .limit(limit)))
            .returning({ tokenHash: orderReceipts.tokenHash }),
        db.delete(notificationOutbox)
            .where(inArray(notificationOutbox.id, db.select({ id: notificationOutbox.id }).from(notificationOutbox)
                .where(and(
                    inArray(notificationOutbox.status, FINISHED_NOTIFICATION_STATUSES),
                    lt(notificationOutbox.nextAttemptAt, notificationCutoff),
                    lt(notificationOutbox.createdAt, notificationCutoff),
                ))
                .limit(limit)))
            .returning({ id: notificationOutbox.id }),
        db.delete(orderReviewRequests)
            .where(inArray(orderReviewRequests.orderId, db.select({ orderId: orderReviewRequests.orderId }).from(orderReviewRequests)
                .where(and(
                    inArray(orderReviewRequests.status, [...FINISHED_REVIEW_REQUEST_STATUSES]),
                    lt(orderReviewRequests.deliveredAt, now - ORDER_HISTORY_RETENTION_DAYS.reviewRequests * DAY),
                ))
                .limit(limit)))
            .returning({ orderId: orderReviewRequests.orderId }),
    ] as const);

    const passed = page as Array<{ id: string; createdAt: number }>;
    const last = passed.at(-1);
    let nextCursor = options.checkoutCursor ?? null;
    if (last) {
        const lastAt = Number(last.createdAt);
        // A full page may have left orders of its last second for the next
        // run: start that run inside the second (its deletes are idempotent),
        // unless the whole page is that second (then move past it).
        const full = passed.length === limit;
        nextCursor = String(full && Number(passed[0]!.createdAt) !== lastAt ? lastAt - 1 : lastAt);
    }
    return {
        checkoutAttempts: (attempts as unknown[]).length,
        receipts: (receipts as unknown[]).length,
        notifications: (notifications as unknown[]).length,
        reviewRequests: (reviewRequests as unknown[]).length,
        checkoutCursor: nextCursor,
    };
}
