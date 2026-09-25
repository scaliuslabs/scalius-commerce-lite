// Line-level review reads: the per-line `extras.review` fact on order pages,
// the account's "reviews to write" count and list, and the one line read the
// submit path trusts. Each is bounded by an order (≤ 90 ids per statement) or
// by the account-owner index on orders.
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
  media,
  orderItems,
  orders,
  productReviews,
  products,
} from "@scalius/database/schema";
import { LIVE_REVIEW_STATUSES } from "@scalius/shared/reviews";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { publishedMediaObjectKey } from "../media/media.presentation";
import type { LineExtrasInput } from "../../utils/line-extras";
import type { LineReviewExtra, ReviewStatus } from "./browser";
import {
  buyerOrderCondition,
  firstFulfilledAtSql,
  isoFromSeconds,
  nowSeconds,
  readEnabledReviewSettings,
  reviewableLineConditions,
  type ReviewBuyer,
} from "./shared";

const ID_CHUNK = 90;
/** The account's "to review" list shows at most this many lines. */
export const REVIEWABLE_LINES_MAX = 50;

/** `coalesce(account owner, order customer, 'order:<id>')`: the reviewer key of an order's lines. */
function reviewerKeySql(): SQL<string> {
  return sql<string>`coalesce(${orders.accountOwnerCustomerId}, ${orders.customerId}, 'order:' || ${orders.id})`;
}

/** No review on this line and no live review of this product by the same buyer. */
function unreviewedLineCondition(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${productReviews} own_review WHERE own_review.order_item_id = ${orderItems.id}
  ) AND NOT EXISTS (
    SELECT 1 FROM ${productReviews} live_review
    WHERE live_review.product_id = ${orderItems.productId}
      AND live_review.reviewer_key = ${reviewerKeySql()}
      AND live_review.status IN ('pending', 'published')
  )`;
}

function chunks<T>(values: readonly T[], size = ID_CHUNK): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

/**
 * Review state per order line, keyed by order item id (`extras.review`). A
 * line reviewed on another order of the same product shows that live review
 * ("Edit your review"). Empty when reviews are off or unreadable. The caller
 * has already proven access to the order.
 */
export async function listLineReviewStates(
  db: Database,
  input: LineExtrasInput,
): Promise<ReadonlyMap<string, LineReviewExtra>> {
  const result = new Map<string, LineReviewExtra>();
  if (input.orderItemIds.length === 0) return result;
  if (!await readEnabledReviewSettings(db)) return result;
  const now = nowSeconds();

  type LineRow = {
    id: string;
    productId: string;
    eligibleLine: number;
    reviewerKey: string;
    reviewId: string | null;
    reviewRating: number | null;
    reviewStatus: ReviewStatus | null;
  };
  const rows: LineRow[] = [];
  for (const ids of chunks(input.orderItemIds)) {
    rows.push(...await db
      .select({
        id: orderItems.id,
        productId: orderItems.productId,
        eligibleLine: sql<number>`CASE WHEN ${and(...reviewableLineConditions(now))} THEN 1 ELSE 0 END`,
        reviewerKey: reviewerKeySql(),
        reviewId: productReviews.id,
        reviewRating: productReviews.rating,
        reviewStatus: productReviews.status,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(productReviews, eq(productReviews.orderItemId, orderItems.id))
      .where(and(eq(orderItems.orderId, input.orderId), inArray(orderItems.id, ids)))
      .all() as LineRow[]);
  }
  if (rows.length === 0) return result;

  // Live reviews of these products by this order's buyer, written on another line.
  const reviewerKey = rows[0]!.reviewerKey;
  const productIds = [...new Set(rows.map((row) => row.productId))];
  const liveByProduct = new Map<string, { id: string; rating: number; status: ReviewStatus }>();
  for (const ids of chunks(productIds)) {
    const live = await db
      .select({ id: productReviews.id, productId: productReviews.productId, rating: productReviews.rating, status: productReviews.status })
      .from(productReviews)
      .where(and(
        inArray(productReviews.productId, ids),
        eq(productReviews.reviewerKey, reviewerKey),
        inArray(productReviews.status, [...LIVE_REVIEW_STATUSES]),
      ))
      .all();
    for (const { productId, ...review } of live) liveByProduct.set(productId, review);
  }

  for (const row of rows) {
    const own = row.reviewId && row.reviewRating !== null && row.reviewStatus
      ? { id: row.reviewId, rating: row.reviewRating, status: row.reviewStatus }
      : null;
    // A withdrawn or rejected review on this line never blocks a new one on
    // another line, but this line itself keeps its one review.
    const live = liveByProduct.get(row.productId) ?? null;
    const review = own && own.status !== "withdrawn" ? own : live ?? own;
    const eligible = row.eligibleLine === 1 && !own && !live;
    if (!eligible && !review) continue;
    result.set(row.id, { eligible, review });
  }
  return result;
}

/** Lines the signed-in customer can still review (the account "Reviews" tab count). 0 when reviews are off. */
export async function countReviewableLinesForCustomer(db: Database, customerId: string): Promise<number> {
  if (!await readEnabledReviewSettings(db)) return 0;
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      eq(orders.accountOwnerCustomerId, customerId),
      ...reviewableLineConditions(nowSeconds()),
      unreviewedLineCondition(),
    ))
    .get();
  return Number(row?.count ?? 0);
}

export interface ReviewableLine {
  orderId: string;
  orderNumber: string;
  orderItemId: string;
  productId: string;
  productName: string;
  productSlug: string | null;
  variantLabel: string | null;
  /** The published image object key (the API turns it into a URL). */
  imageObjectKey: string | null;
  /** When the line was first handed over. */
  fulfilledAt: string | null;
}

/**
 * Lines the buyer can review now, newest order first: every owned order for
 * an account, the receipt's own order for a guest. Empty when reviews are off.
 */
export async function listReviewableLines(db: Database, buyer: ReviewBuyer): Promise<ReviewableLine[]> {
  if (!await readEnabledReviewSettings(db)) return [];
  const rows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderItemId: orderItems.id,
      productId: orderItems.productId,
      productName: sql<string>`coalesce(${orderItems.productName}, ${products.name}, '')`,
      productSlug: products.slug,
      variantLabel: orderItems.variantLabel,
      imageObjectKey: sql<string | null>`CASE WHEN ${media.status} IN ('ready', 'trashed') THEN ${publishedMediaObjectKey()} END`,
      fulfilledAt: firstFulfilledAtSql(),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(products, and(eq(products.id, orderItems.productId), isNull(products.deletedAt)))
    .leftJoin(media, eq(media.id, orderItems.productImageMediaId))
    .where(and(
      buyerOrderCondition(buyer),
      ...reviewableLineConditions(nowSeconds()),
      unreviewedLineCondition(),
    ))
    .orderBy(desc(orders.createdAt), orderItems.id)
    .limit(REVIEWABLE_LINES_MAX)
    .all();
  // One line per product: a repeat purchase is one review.
  const seen = new Set<string>();
  const lines: ReviewableLine[] = [];
  for (const row of rows) {
    if (seen.has(row.productId)) continue;
    seen.add(row.productId);
    lines.push({
      ...row,
      orderNumber: formatOrderNumber(row.orderNumber, row.orderId),
      fulfilledAt: isoFromSeconds(row.fulfilledAt),
    });
  }
  return lines;
}

/**
 * The newest line of this product the buyer can review now (the product
 * page's "Write a review"), or null. Same rules as the account's list, scoped
 * to one product so a long order history never hides it.
 */
export async function findReviewableLineForProduct(
  db: Database,
  buyer: ReviewBuyer,
  productId: string,
): Promise<{ orderItemId: string; customerName: string | null } | null> {
  const row = await db
    .select({ orderItemId: orderItems.id, customerName: orders.customerName })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(
      buyerOrderCondition(buyer),
      eq(orderItems.productId, productId),
      ...reviewableLineConditions(nowSeconds()),
      unreviewedLineCondition(),
    ))
    .orderBy(desc(orders.createdAt), orderItems.id)
    .limit(1)
    .get();
  return row ?? null;
}

/** Reviews the signed-in customer wrote that still show on the account (not withdrawn). 0 when reviews are off. */
export async function countWrittenReviewsForCustomer(db: Database, customerId: string): Promise<number> {
  if (!await readEnabledReviewSettings(db)) return 0;
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(productReviews)
    .innerJoin(orders, eq(orders.id, productReviews.orderId))
    .where(and(
      eq(orders.accountOwnerCustomerId, customerId),
      inArray(productReviews.status, ["pending", "published", "rejected"]),
    ))
    .get();
  return Number(row?.count ?? 0);
}

/** The line a buyer is reviewing, if it belongs to the buyer (else nothing: 404). */
export async function readBuyerLine(db: Database, buyer: ReviewBuyer, orderItemId: string) {
  return await db
    .select({
      orderItemId: orderItems.id,
      orderId: orders.id,
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      variantLabel: orderItems.variantLabel,
      customerName: orders.customerName,
      customerId: orders.customerId,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
      reviewable: sql<number>`CASE WHEN ${and(...reviewableLineConditions(nowSeconds()))} THEN 1 ELSE 0 END`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orderItems.id, orderItemId), buyerOrderCondition(buyer), isNotNull(orderItems.productId)))
    .get();
}
