// Internal helpers of the reviews domain: ids, time, the fail-closed settings
// read, the buyer actor and the one "reviewable line" predicate every read and
// write uses (the same facts as the `product_reviews_line_eligible` trigger,
// plus the 365-day window the trigger cannot express).
import { nanoid } from "nanoid";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
  orderFulfillmentLines,
  orderFulfillments,
  orderItems,
  orders,
} from "@scalius/database/schema";
import {
  REVIEW_LIMITS,
  REVIEWABLE_FULFILLMENT_TYPES,
} from "@scalius/shared/reviews";
import { AppError, NotFoundError, ServiceUnavailableError } from "../../errors";
import { readReviewSettings, type ReviewSettings } from "../settings/documents";

export const DAY_SECONDS = 24 * 60 * 60;
/** Order statuses whose handed-over lines may be reviewed. */
export const REVIEWABLE_ORDER_STATUSES = ["delivered", "completed"] as const;

export function newReviewId(): string {
  return `rev_${nanoid(20)}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isoFromSeconds(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * Who is writing: the verified account that owns the order, or a guest who
 * presented the order's receipt proof (validated by the route). The same
 * access rule as order threads.
 */
export type ReviewBuyer =
  | { kind: "customer"; customerId: string }
  | { kind: "guest_receipt"; orderId: string };

/** The buyer's order condition: owned by the account, or the receipt's own order. */
export function buyerOrderCondition(buyer: ReviewBuyer): SQL {
  return buyer.kind === "customer"
    ? eq(orders.accountOwnerCustomerId, buyer.customerId)
    : eq(orders.id, buyer.orderId);
}

/** Reviews on and readable, or a 503 (writes refuse when settings cannot be read). */
export async function requireReviewSettings(db: Database): Promise<ReviewSettings> {
  const read = await readReviewSettings(db);
  if (!read.ok) throw new ServiceUnavailableError("Reviews are unavailable right now. Please try again later.");
  if (!read.value.enabled) throw new AppError(403, "REVIEWS_DISABLED", "This store is not taking reviews.");
  return read.value;
}

/** Reviews settings when readable and on; `null` otherwise (reads show nothing). */
export async function readEnabledReviewSettings(db: Database): Promise<ReviewSettings | null> {
  const read = await readReviewSettings(db);
  return read.ok && read.value.enabled ? read.value : null;
}

/**
 * When the line was first handed over (its earliest active fulfilment), or
 * null for a line with no fulfilment record (none is reviewable then: the
 * trigger needs `fulfilled_quantity > 0`, which the fulfilment ledger keeps).
 */
export function firstFulfilledAtSql(): SQL<number | null> {
  return sql<number | null>`(
    SELECT min(${orderFulfillments.createdAt})
    FROM ${orderFulfillmentLines}
    INNER JOIN ${orderFulfillments} ON ${orderFulfillments.id} = ${orderFulfillmentLines.fulfillmentId}
    WHERE ${orderFulfillmentLines.orderItemId} = ${orderItems.id}
      AND ${orderFulfillments.status} = 'active'
  )`;
}

/**
 * A line a buyer may review right now, whatever its review state: a
 * reviewable type, handed over, on a live delivered or completed order,
 * within 365 days of its first handover. Reads `order_items` joined to
 * `orders`.
 */
export function reviewableLineConditions(now: number): SQL[] {
  const windowStart = now - REVIEW_LIMITS.reviewWindowDays * DAY_SECONDS;
  return [
    inArray(orderItems.fulfillmentType, [...REVIEWABLE_FULFILLMENT_TYPES]),
    sql`${orderItems.fulfilledQuantity} > 0`,
    inArray(orders.status, [...REVIEWABLE_ORDER_STATUSES]),
    isNull(orders.deletedAt),
    sql`coalesce(${firstFulfilledAtSql()}, ${now}) >= ${windowStart}`,
  ];
}

/** The reviewer key the partial unique index uses: a customer record id, never PII. */
export function reviewerKeyOf(order: { accountOwnerCustomerId: string | null; customerId: string | null; id: string }): string {
  return order.accountOwnerCustomerId ?? order.customerId ?? `order:${order.id}`;
}

export function notFoundReview(): NotFoundError {
  return new NotFoundError("Review not found");
}

/** `check_flags` JSON (flags only, never text). */
export function encodeCheckFlags(flags: readonly string[]): string | null {
  return flags.length > 0 ? JSON.stringify(flags) : null;
}

export function decodeCheckFlags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((flag): flag is string => typeof flag === "string") : [];
  } catch {
    return [];
  }
}

/** The line's order and item, joined, for the line-level reads. */
export function lineWithOrder(db: Database) {
  return db
    .select({
      orderItemId: orderItems.id,
      orderId: orders.id,
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      productName: orderItems.productName,
      variantLabel: orderItems.variantLabel,
      fulfillmentType: orderItems.fulfillmentType,
      fulfilledQuantity: orderItems.fulfilledQuantity,
      orderStatus: orders.status,
      customerName: orders.customerName,
      customerId: orders.customerId,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
    })
    .from(orderItems)
    .innerJoin(orders, and(eq(orders.id, orderItems.orderId), isNull(orders.deletedAt)));
}
