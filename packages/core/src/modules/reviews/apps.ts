// App review writes (the stable app API's `reviews.create` and
// `reviews.set_status`): an import or reviews app writes a review of a
// product and moderates reviews under their revision.
//
// A review is a verified purchase only when it is on an order line that was
// handed over on a delivered order of the review's customer; the app never
// sets that fact, it names the line and the line proves it (the
// `product_reviews_line_eligible` trigger refuses any other named line). An
// import of history names no line: it is shown without "Verified purchase".
// Writes go through `product_reviews` itself, so the stats projection, the
// cache dependency triggers and the event outbox follow as for a buyer's
// review. The app is recorded as the author (`author_type = 'app'`,
// `app_id`). Review text never enters logs.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { customers, orderItems, orders, productReviews, productVariants, products } from "@scalius/database/schema";
import {
  canTransitionReviewStatus,
  checkReviewContent,
  defaultReviewerDisplayName,
  isReviewRejectionReason,
  LIVE_REVIEW_STATUSES,
  type ReviewRejectionReason,
} from "@scalius/shared/reviews";
import { AppError, NotFoundError, ValidationError } from "../../errors";
import type { ReviewStatus } from "./browser";
import { isConstraintFailure, readRating, readText } from "./buyer";
import { readOrderVariantLabel } from "./lines";
import {
  encodeCheckFlags,
  notFoundReview,
  nowSeconds,
  requireReviewSettings,
  reviewableLineConditions,
  reviewerKeyOf,
} from "./shared";

/** What an app may ask a new review to be: waiting for moderation, or live. */
export const APP_REVIEW_CREATE_STATUSES = ["pending", "published"] as const;
export type AppReviewCreateStatus = (typeof APP_REVIEW_CREATE_STATUSES)[number];

/** Where an app's moderation may move a review (`reviews.set_status`). */
export const APP_REVIEW_MODERATION_STATUSES = ["published", "rejected"] as const;
export type AppReviewModerationStatus = (typeof APP_REVIEW_MODERATION_STATUSES)[number];

export interface AppReviewInput {
  /** The review's id, derived by the caller from its retry key: a repeat finds it. */
  id: string;
  /** The app writing it (its plugin id). */
  appId: string;
  productId: string;
  variantId?: string | null;
  /** The order line reviewed: makes the review a verified purchase, or is refused. */
  orderItemId?: string | null;
  customerId?: string | null;
  rating: unknown;
  title?: unknown;
  body?: unknown;
  /** The name the review is shown under; defaults to the customer's ("First L."). */
  authorDisplayName?: unknown;
  /** `published` is honoured when the content check passes; a flagged review waits. Default `pending`. */
  status?: AppReviewCreateStatus;
  /** When it was written (seconds), for imported history; never in the future. Default now. */
  createdAt?: number | null;
  /** The app's claim that it is a verified purchase: refused unless `orderItemId` proves it. */
  verified?: boolean;
}

export interface AppReviewResult {
  reviewId: string;
  /** True when the id already held this review (a repeat): nothing was written. */
  replayed: boolean;
}

function reviewExists(reviewId: string): AppError {
  return new AppError(409, "review_exists", "That buyer already has a live review of this product, or the order line has its review.", { reviewId });
}

function notVerifiable(message: string): AppError {
  return new AppError(422, "review_not_verifiable", message);
}

function keyReused(): AppError {
  return new AppError(422, "idempotency_key_reused", "This Idempotency-Key already wrote another review.");
}

function revisionConflict(): AppError {
  return new AppError(409, "review_revision_conflict", "The review changed since its revision was read. Read it again.");
}

/** The fields a repeat must match to be the same review. */
function sameReview(
  row: { productId: string; rating: number; title: string | null; body: string | null; appId: string | null; orderItemId: string | null },
  want: { productId: string; rating: number; title: string | null; body: string | null; appId: string; orderItemId: string | null },
): boolean {
  return row.productId === want.productId && row.rating === want.rating && row.title === want.title
    && row.body === want.body && row.appId === want.appId && row.orderItemId === want.orderItemId;
}

/** The order line an app names, with whether a buyer could review it now. */
async function readLine(db: Database, orderItemId: string) {
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
    .where(eq(orderItems.id, orderItemId))
    .get();
}

/**
 * Writes an app's review of a product. Idempotent by `input.id`: a repeat of
 * the same review answers it (`replayed`), another review under the id is
 * refused. A review on an order line is a verified purchase of that line's
 * customer; `verified: true` without such a line is refused
 * (`review_not_verifiable`). A review on a line takes that buyer's one live
 * review of the product, as theirs does (`review_exists`); an import that
 * names no line takes no buyer's.
 */
export async function createAppReview(db: Database, input: AppReviewInput): Promise<AppReviewResult> {
  const settings = await requireReviewSettings(db);
  const rating = readRating(input.rating);
  const title = readText(input.title, "title");
  const body = readText(input.body, "body");
  const chosenName = readText(input.authorDisplayName, "displayName");
  const orderItemId = input.orderItemId?.trim() || null;
  const want = { productId: input.productId, rating, title, body, appId: input.appId, orderItemId };

  const replay = async (): Promise<AppReviewResult | null> => {
    const row = await db
      .select({
        productId: productReviews.productId, rating: productReviews.rating, title: productReviews.title, body: productReviews.body,
        appId: productReviews.appId, orderItemId: productReviews.orderItemId,
      })
      .from(productReviews)
      .where(eq(productReviews.id, input.id))
      .get();
    if (!row) return null;
    if (!sameReview(row, want)) throw keyReused();
    return { reviewId: input.id, replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const product = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, input.productId), isNull(products.deletedAt)))
    .get();
  if (!product) throw new NotFoundError("Product not found");

  const now = nowSeconds();
  const createdAt = input.createdAt ?? now;
  if (!Number.isSafeInteger(createdAt) || createdAt > now + 60 || createdAt < 0) {
    throw new ValidationError("createdAt is a past time.", { field: "createdAt" });
  }

  let orderId: string | null = null;
  let customerId = input.customerId?.trim() || null;
  let variantId = input.variantId?.trim() || null;
  let variantLabel: string | null = null;
  let reviewerKey: string;
  let customerName: string | null = null;
  if (orderItemId) {
    const line = await readLine(db, orderItemId);
    if (!line) throw notVerifiable("No order line has that id.");
    if (line.productId !== input.productId) throw notVerifiable("The order line is of another product.");
    const owners = [line.accountOwnerCustomerId, line.customerId].filter((owner): owner is string => owner !== null);
    if (customerId && !owners.includes(customerId)) throw notVerifiable("The order line belongs to another customer.");
    if (variantId && line.variantId !== variantId) throw notVerifiable("The order line is of another variant.");
    if (line.reviewable !== 1) {
      throw new AppError(409, "review_not_eligible", "The order line was not handed over on a delivered order, or its review window closed.");
    }
    orderId = line.orderId;
    customerId = line.accountOwnerCustomerId ?? line.customerId;
    variantId = line.variantId;
    variantLabel = await readOrderVariantLabel(db, line.orderId, line.productId) ?? line.variantLabel;
    reviewerKey = reviewerKeyOf({ id: line.orderId, accountOwnerCustomerId: line.accountOwnerCustomerId, customerId: line.customerId });
    customerName = line.customerName;
  } else {
    if (input.verified === true) throw notVerifiable("A verified purchase names the delivered order line it reviews (orderItemId).");
    if (variantId) {
      const variant = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(and(eq(productVariants.id, variantId), eq(productVariants.productId, input.productId)))
        .get();
      if (!variant) throw new ValidationError("The variant is not one of the product's.", { field: "variantId" });
    }
    if (customerId) {
      const customer = await db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, customerId)).get();
      if (!customer) throw new NotFoundError("Customer not found");
      customerName = customer.name;
    }
    // An import of history never takes the buyer's one live review of the
    // product: the buyer's account lists reviews by their orders, so they
    // could neither see nor edit it, yet their own verified review would be
    // refused as a second one.
    reviewerKey = `review:${input.id}`;
  }
  const authorDisplayName = chosenName ?? (customerName !== null || customerId ? defaultReviewerDisplayName(customerName) : null);
  if (!authorDisplayName) {
    throw new ValidationError("Give the name the review is shown under (authorDisplayName).", { field: "authorDisplayName" });
  }

  const live = await db
    .select({ id: productReviews.id })
    .from(productReviews)
    .where(sql`(${productReviews.productId} = ${input.productId} AND ${productReviews.reviewerKey} = ${reviewerKey}
      AND ${productReviews.status} IN ('pending', 'published'))${orderItemId ? sql` OR ${productReviews.orderItemId} = ${orderItemId}` : sql``}`)
    .get();
  if (live) throw reviewExists(live.id);

  // The app moderates (write_reviews carries reviews.moderate), but the
  // store's content check still holds a flagged review for a person to see.
  const check = checkReviewContent({ title, body }, { blockWords: settings.blockWords });
  const status: ReviewStatus = input.status === "published" && !check.hold ? "published" : "pending";
  try {
    await db.insert(productReviews).values({
      id: input.id,
      productId: input.productId,
      variantId,
      orderId,
      orderItemId,
      reviewerKey,
      customerId,
      authorType: "app",
      appId: input.appId,
      authorDisplayName,
      variantLabel,
      rating,
      title,
      body,
      status,
      checkFlags: encodeCheckFlags(check.flags),
      publishedAt: status === "published" ? createdAt : null,
      createdAt,
      updatedAt: now,
    }).run();
  } catch (error) {
    if (isConstraintFailure(error, /review requires a fulfilled line/)) {
      throw new AppError(409, "review_not_eligible", "The order line was not handed over on a delivered order.");
    }
    if (isConstraintFailure(error, /UNIQUE|unique|duplicate key/)) {
      // A racing repeat under the same id, or a review that took the slot first.
      const raced = await replay();
      if (raced) return raced;
      const winner = await db
        .select({ id: productReviews.id })
        .from(productReviews)
        .where(sql`(${productReviews.productId} = ${input.productId} AND ${productReviews.reviewerKey} = ${reviewerKey}
          AND ${productReviews.status} IN ('pending', 'published'))${orderItemId ? sql` OR ${productReviews.orderItemId} = ${orderItemId}` : sql``}`)
        .get();
      if (winner) throw reviewExists(winner.id);
    }
    throw error;
  }
  return { reviewId: input.id, replayed: false };
}

export interface SetReviewStatusInput {
  reviewId: string;
  status: AppReviewModerationStatus;
  /** Required to reject: a content reason, never the rating. */
  reason?: string | null;
  expectedRevision: number;
}

/**
 * Moderates one review under its revision: publish (a pending one, or a
 * rejected one restored) or reject with a content reason. A stale revision is
 * refused and changes nothing (`review_revision_conflict`); asking for the
 * status it has, at its revision, changes nothing either. A buyer's withdrawn
 * review stays withdrawn (`review_state_conflict`).
 */
export async function setReviewStatus(db: Database, input: SetReviewStatusInput): Promise<{ changed: boolean }> {
  const current = await db
    .select({
      id: productReviews.id, status: productReviews.status, version: productReviews.version, moderationReason: productReviews.moderationReason,
      productId: productReviews.productId, reviewerKey: productReviews.reviewerKey,
    })
    .from(productReviews)
    .where(eq(productReviews.id, input.reviewId))
    .get();
  if (!current) throw notFoundReview();
  if (current.version !== input.expectedRevision) throw revisionConflict();
  let reason: ReviewRejectionReason | null = null;
  if (input.status === "rejected") {
    if (!isReviewRejectionReason(input.reason)) throw new ValidationError("Choose why the review is rejected (a content reason).", { field: "reason" });
    reason = input.reason;
  }
  if (current.status === input.status && current.moderationReason === reason) return { changed: false };
  if (current.status !== input.status && !canTransitionReviewStatus(current.status, input.status, "staff")) {
    throw new AppError(409, "review_state_conflict", `A ${current.status} review cannot be ${input.status}.`, { status: current.status });
  }
  const now = nowSeconds();
  let moved: { id: string }[];
  try {
    moved = await db.update(productReviews)
      .set({
        status: input.status,
        moderationReason: reason,
        ...(input.status === "published" ? { publishedAt: sql`coalesce(${productReviews.publishedAt}, ${now})` } : {}),
        version: sql`${productReviews.version} + 1`,
        updatedAt: now,
      })
      .where(and(
        eq(productReviews.id, input.reviewId),
        eq(productReviews.version, input.expectedRevision),
        inArray(productReviews.status, [current.status]),
      ))
      .returning({ id: productReviews.id });
  } catch (error) {
    // Restoring a rejected review whose buyer wrote another live one since.
    if (input.status === "published" && isConstraintFailure(error, /UNIQUE|unique|duplicate key/)) {
      const other = await db
        .select({ id: productReviews.id })
        .from(productReviews)
        .where(and(
          eq(productReviews.productId, current.productId),
          eq(productReviews.reviewerKey, current.reviewerKey),
          inArray(productReviews.status, [...LIVE_REVIEW_STATUSES]),
        ))
        .get();
      throw reviewExists(other?.id ?? input.reviewId);
    }
    throw error;
  }
  if (moved.length === 0) throw revisionConflict();
  return { changed: true };
}
