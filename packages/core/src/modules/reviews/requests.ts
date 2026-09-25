// Review requests (Wave B §2.3) and the coalesced cache bump (§2.5).
//
// A trigger records every order -> delivered transition in
// `order_review_requests`. The 15-minute sweep turns due rows (the store's
// delay after delivery) into `review_request` outbox rows, one per order, and
// the send-time check decides again whether there is anything to ask about.
// Links point at the order page or /track-order, never at a token.
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import {
  orderItems,
  orderReviewRequests,
  orders,
  productReviewStats,
} from "@scalius/database/schema";
import { readReviewSettings } from "../settings/documents";
import { buildNotificationOutboxInsert } from "../notifications/notification-outbox";
import {
  DAY_SECONDS,
  nowSeconds,
  reviewableLineConditions,
} from "./shared";

const SWEEP_LIMIT_MAX = 100;
/** Outbox insert + request update per order: 50 orders per batch. */
const SWEEP_BATCH_ORDERS = 50;

/** A reviewable line with no review and no live review of its product by the same buyer. */
function openReviewableLineExists(now: number) {
  return sql`EXISTS (
    SELECT 1 FROM ${orderItems}
    WHERE ${orderItems.orderId} = ${orders.id}
      AND ${and(...reviewableLineConditions(now))}
      AND NOT EXISTS (SELECT 1 FROM product_reviews own_review WHERE own_review.order_item_id = ${orderItems.id})
      AND NOT EXISTS (
        SELECT 1 FROM product_reviews live_review
        WHERE live_review.product_id = ${orderItems.productId}
          AND live_review.reviewer_key = coalesce(${orders.accountOwnerCustomerId}, ${orders.customerId}, 'order:' || ${orders.id})
          AND live_review.status IN ('pending', 'published')
      )
  )`;
}

/**
 * Turns due review requests into `review_request` outbox rows (subject the
 * order, dedupe `order:<id>:review_request`), one batch per 50 orders. Due
 * orders with nothing left to review, and every due order while reviews or
 * requests are off, are marked `skipped` (terminal: one request per order).
 * Unreadable settings leave every row scheduled for the next run.
 */
export async function sweepReviewRequests(
  db: Database,
  options: { now?: number; limit?: number } = {},
): Promise<{ queued: number; skipped: number }> {
  const settings = await readReviewSettings(db);
  if (!settings.ok) return { queued: 0, skipped: 0 };
  const now = options.now ?? nowSeconds();
  const limit = Math.max(1, Math.min(SWEEP_LIMIT_MAX, options.limit ?? SWEEP_LIMIT_MAX));
  const dueBefore = now - settings.value.requestDelayDays * DAY_SECONDS;
  const requestsOn = settings.value.enabled && settings.value.requestsEnabled;

  const due = await db
    .select({
      orderId: orderReviewRequests.orderId,
      askable: sql<number>`CASE WHEN ${orders.id} IS NOT NULL AND ${openReviewableLineExists(now)} THEN 1 ELSE 0 END`,
    })
    .from(orderReviewRequests)
    .leftJoin(orders, eq(orders.id, orderReviewRequests.orderId))
    .where(and(eq(orderReviewRequests.status, "scheduled"), lte(orderReviewRequests.deliveredAt, dueBefore)))
    .orderBy(asc(orderReviewRequests.deliveredAt), asc(orderReviewRequests.orderId))
    .limit(limit)
    .all();
  if (due.length === 0) return { queued: 0, skipped: 0 };

  const ask = requestsOn ? due.filter((row) => row.askable === 1).map((row) => row.orderId) : [];
  const skip = due.filter((row) => !ask.includes(row.orderId)).map((row) => row.orderId);

  if (skip.length > 0) {
    await db.update(orderReviewRequests)
      .set({ status: "skipped", updatedAt: now })
      .where(and(inArray(orderReviewRequests.orderId, skip), eq(orderReviewRequests.status, "scheduled")));
  }
  for (let index = 0; index < ask.length; index += SWEEP_BATCH_ORDERS) {
    const statements = ask.slice(index, index + SWEEP_BATCH_ORDERS).flatMap((orderId) => {
      const outbox = buildNotificationOutboxInsert(db, {
        subjectType: "order",
        subjectId: orderId,
        audience: "customer",
        notificationType: "review_request",
        dedupeKey: `order:${orderId}:review_request`,
        source: "review_request_sweep",
        data: { orderId },
      });
      return [
        outbox.statement,
        db.update(orderReviewRequests)
          .set({ status: "queued", outboxId: outbox.outboxId, updatedAt: now })
          .where(and(eq(orderReviewRequests.orderId, orderId), eq(orderReviewRequests.status, "scheduled"))),
      ];
    });
    await safeBatch(db, statements as never);
  }
  return { queued: ask.length, skipped: skip.length };
}

export interface ReviewRequestContent {
  /** Names of the lines still waiting for a review (at most five, in order). */
  productNames: string[];
  /** The order belongs to a verified account (link to the account order page), else a guest (link to track-order). */
  accountOwned: boolean;
}

/**
 * The send-time recheck: reviews and requests are still on, the order is
 * still delivered or completed, and at least one handed-over line is still
 * waiting for its review. `null` = nothing to send (terminal).
 */
export async function reviewRequestSendCheck(db: Database, orderId: string): Promise<ReviewRequestContent | null> {
  const settings = await readReviewSettings(db);
  if (!settings.ok) throw new Error("Review settings are unreadable; retry the review request later.");
  if (!settings.value.enabled || !settings.value.requestsEnabled) return null;
  const now = nowSeconds();
  const rows = await db
    .select({
      productName: sql<string>`coalesce(${orderItems.productName}, '')`,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(orders.id, orderId),
      ...reviewableLineConditions(now),
      sql`NOT EXISTS (SELECT 1 FROM product_reviews own_review WHERE own_review.order_item_id = ${orderItems.id})`,
      sql`NOT EXISTS (
        SELECT 1 FROM product_reviews live_review
        WHERE live_review.product_id = ${orderItems.productId}
          AND live_review.reviewer_key = coalesce(${orders.accountOwnerCustomerId}, ${orders.customerId}, 'order:' || ${orders.id})
          AND live_review.status IN ('pending', 'published')
      )`,
    ))
    .orderBy(asc(orderItems.id))
    .all();
  if (rows.length === 0) return null;
  const names = [...new Set(rows.map((row) => row.productName.trim()).filter(Boolean))].slice(0, 5);
  return { productNames: names, accountOwned: Boolean(rows[0]!.accountOwnerCustomerId) };
}

/**
 * Whether any published review changed at or after `sinceEpochSeconds` (the
 * stats projection's indexed `updated_at`; every change to a published
 * review, including a text-only edit, rewrites its product's row). The cron
 * bumps the cache generation once when this is true (§2.5). `>=`, because
 * the generation and a review can move in the same second.
 */
export async function reviewsChangedSince(db: Database, sinceEpochSeconds: number): Promise<boolean> {
  const row = await db
    .select({ productId: productReviewStats.productId })
    .from(productReviewStats)
    .where(gte(productReviewStats.updatedAt, sinceEpochSeconds))
    .limit(1)
    .get();
  return Boolean(row);
}
