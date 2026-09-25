// Buyer review writes and reads (Wave B §2.1): submit, edit and withdraw a
// review of a delivered order line, and list the buyer's own reviews.
//
// Every review is a verified purchase: the line must be handed over on a
// delivered or completed order the buyer owns (account) or holds the receipt
// of (guest). The database trigger enforces the same fact against raw writes.
// One review per line; one live review per product per buyer (a repeat
// purchase edits). Moderation is the rating-blind content check. Buyer
// auto-publishes never bump the cache generation inline: the 15-minute cron
// does once (`reviewsChangedSince`). Review text never enters logs.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { safeBatch, type Database } from "@scalius/database/client";
import { orders, productReviews, products } from "@scalius/database/schema";
import {
  REVIEW_LIMITS,
  canTransitionReviewStatus,
  checkReviewContent,
  defaultReviewerDisplayName,
  isReviewRating,
  normalizeReviewText,
  reviewStatusAfterCheck,
  type ReviewTextField,
} from "@scalius/shared/reviews";
import { AppError, ConflictError, RateLimitError, ValidationError } from "../../errors";
import {
  buildNotificationOutboxInsert,
  enqueueNotificationOutboxById,
  type NotificationQueue,
} from "../notifications/notification-outbox";
import type { ReviewStatus } from "./browser";
import { readBuyerLine } from "./lines";
import {
  DAY_SECONDS,
  buyerOrderCondition,
  encodeCheckFlags,
  isoFromSeconds,
  newReviewId,
  notFoundReview,
  nowSeconds,
  requireReviewSettings,
  reviewerKeyOf,
  type ReviewBuyer,
} from "./shared";

export interface BuyerReview {
  id: string;
  orderId: string;
  orderItemId: string;
  productId: string;
  productName: string;
  productSlug: string | null;
  variantLabel: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  displayName: string;
  status: ReviewStatus;
  reply: { body: string; repliedAt: string } | null;
  createdAt: string;
  publishedAt: string | null;
  editedAt: string | null;
  version: number;
  /** Pending or published, with edits left today. */
  canEdit: boolean;
}

export interface SubmitReviewInput {
  orderItemId: string;
  rating: unknown;
  title?: unknown;
  body?: unknown;
  displayName?: unknown;
}

export interface EditReviewInput {
  version: number;
  rating?: unknown;
  /** `null` or blank clears it. */
  title?: unknown;
  body?: unknown;
  /** `null` or blank restores the default ("First L."). */
  displayName?: unknown;
}

export interface ReviewWriteOptions {
  /** Hands a staff "review waiting" row to the queue at once (else the scheduled flush sends it). */
  queue?: NotificationQueue;
}

export interface ReviewWriteResult {
  review: BuyerReview;
  /** False when the same line was already reviewed (an idempotent retry). */
  created: boolean;
  /** The review is live on the product page now (its cache catches up within 15 minutes). */
  published: boolean;
}

const TEXT_FIELD_NAMES: Record<ReviewTextField, string> = {
  title: "title",
  body: "review",
  displayName: "name",
  reply: "reply",
};

function readText(input: unknown, field: ReviewTextField): string | null {
  const result = normalizeReviewText(input, field);
  if (result.ok) return result.value;
  const name = TEXT_FIELD_NAMES[field];
  const message = result.reason === "too_long"
    ? `The ${name} is too long.`
    : `The ${name} has characters we can't accept.`;
  throw new ValidationError(message, { field });
}

function readRating(input: unknown): number {
  if (!isReviewRating(input)) throw new ValidationError("Choose a rating from 1 to 5 stars.", { field: "rating" });
  return input;
}

function isConstraintFailure(error: unknown, pattern: RegExp): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return pattern.test(text);
}

function notEligible(): AppError {
  return new AppError(409, "REVIEW_NOT_ELIGIBLE", "This item can be reviewed once it has been delivered.");
}

function alreadyReviewed(reviewId: string): AppError {
  return new AppError(409, "REVIEW_EXISTS", "You've already reviewed this product. You can edit your review instead.", { reviewId });
}

function buyerReviewSelect() {
  return {
    id: productReviews.id,
    orderId: productReviews.orderId,
    orderItemId: productReviews.orderItemId,
    productId: productReviews.productId,
    productName: sql<string>`coalesce((SELECT oi.product_name FROM order_items oi WHERE oi.id = ${productReviews.orderItemId}), ${products.name}, '')`,
    productSlug: products.slug,
    variantLabel: productReviews.variantLabel,
    rating: productReviews.rating,
    title: productReviews.title,
    body: productReviews.body,
    displayName: productReviews.authorDisplayName,
    status: productReviews.status,
    replyBody: productReviews.replyBody,
    repliedAt: productReviews.repliedAt,
    createdAt: productReviews.createdAt,
    publishedAt: productReviews.publishedAt,
    editedAt: productReviews.editedAt,
    version: productReviews.version,
    editDay: productReviews.editDay,
    editCountDay: productReviews.editCountDay,
  };
}

type BuyerReviewRow = {
  id: string;
  orderId: string;
  orderItemId: string;
  productId: string;
  productName: string;
  productSlug: string | null;
  variantLabel: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  displayName: string;
  status: ReviewStatus;
  replyBody: string | null;
  repliedAt: number | null;
  createdAt: number;
  publishedAt: number | null;
  editedAt: number | null;
  version: number;
  editDay: number | null;
  editCountDay: number;
};

function editsUsedToday(row: Pick<BuyerReviewRow, "editDay" | "editCountDay">, today: number): number {
  return row.editDay === today ? row.editCountDay : 0;
}

function presentBuyerReview(row: BuyerReviewRow, now = nowSeconds()): BuyerReview {
  const today = Math.floor(now / DAY_SECONDS);
  return {
    id: row.id,
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    productId: row.productId,
    productName: row.productName,
    productSlug: row.productSlug,
    variantLabel: row.variantLabel,
    rating: row.rating,
    title: row.title,
    body: row.body,
    displayName: row.displayName,
    status: row.status,
    reply: row.replyBody && row.repliedAt !== null ? { body: row.replyBody, repliedAt: isoFromSeconds(row.repliedAt)! } : null,
    createdAt: isoFromSeconds(row.createdAt)!,
    publishedAt: isoFromSeconds(row.publishedAt),
    editedAt: isoFromSeconds(row.editedAt),
    version: row.version,
    canEdit: (row.status === "pending" || row.status === "published")
      && editsUsedToday(row, today) < REVIEW_LIMITS.editsPerDay,
  };
}

async function readBuyerReviewRow(db: Database, buyer: ReviewBuyer, reviewId: string): Promise<BuyerReviewRow | undefined> {
  return await db
    .select(buyerReviewSelect())
    .from(productReviews)
    .innerJoin(orders, eq(orders.id, productReviews.orderId))
    .leftJoin(products, eq(products.id, productReviews.productId))
    .where(and(eq(productReviews.id, reviewId), buyerOrderCondition(buyer)))
    .get() as BuyerReviewRow | undefined;
}

/** One of the buyer's reviews, or a 404 (ids are never confirmed to other buyers). */
export async function getBuyerReview(db: Database, buyer: ReviewBuyer, reviewId: string): Promise<BuyerReview> {
  const row = await readBuyerReviewRow(db, buyer, reviewId);
  if (!row) throw notFoundReview();
  return presentBuyerReview(row);
}

/** The buyer's reviews, newest first (withdrawn ones hidden): every owned order, or the receipt's order. */
export async function listBuyerReviews(db: Database, buyer: ReviewBuyer): Promise<BuyerReview[]> {
  const rows = await db
    .select(buyerReviewSelect())
    .from(productReviews)
    .innerJoin(orders, eq(orders.id, productReviews.orderId))
    .leftJoin(products, eq(products.id, productReviews.productId))
    .where(and(buyerOrderCondition(buyer), inArray(productReviews.status, ["pending", "published", "rejected"])))
    .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
    .limit(100)
    .all() as BuyerReviewRow[];
  const now = nowSeconds();
  return rows.map((row) => presentBuyerReview(row, now));
}

/** The staff "review waiting for approval" row, in the review's own batch. */
function reviewPendingOutbox(db: Database, review: { id: string; orderId: string; version: number }) {
  return buildNotificationOutboxInsert(db, {
    subjectType: "order",
    subjectId: review.orderId,
    audience: "staff",
    notificationType: "review_pending",
    dedupeKey: `order:${review.orderId}:review_pending:${review.id}:${review.version}`,
    source: "reviews",
    data: { reviewId: review.id },
  });
}

async function handOver(db: Database, queue: NotificationQueue | undefined, outboxId: string | null): Promise<void> {
  if (!queue || !outboxId) return;
  try {
    await enqueueNotificationOutboxById({ db, queue, outboxId });
  } catch (error) {
    // The scheduled flush sends it; ids only in the log.
    console.warn(`[Reviews] Staff alert ${outboxId} left for the scheduled flush:`, error instanceof Error ? error.name : "error");
  }
}

/**
 * Submits a review of one delivered line. A retry for a line that already
 * has its live review returns that review (`created: false`); a second review
 * of the same product (another line) is a 409 that names the review to edit.
 */
export async function submitReview(
  db: Database,
  buyer: ReviewBuyer,
  input: SubmitReviewInput,
  options: ReviewWriteOptions = {},
): Promise<ReviewWriteResult> {
  const settings = await requireReviewSettings(db);
  const rating = readRating(input.rating);
  const title = readText(input.title, "title");
  const body = readText(input.body, "body");
  const displayName = readText(input.displayName, "displayName");

  const line = await readBuyerLine(db, buyer, input.orderItemId);
  if (!line) throw notFoundReview();

  const reviewerKey = reviewerKeyOf({ id: line.orderId, accountOwnerCustomerId: line.accountOwnerCustomerId, customerId: line.customerId });
  const existing = await db
    .select({ id: productReviews.id, orderItemId: productReviews.orderItemId, status: productReviews.status })
    .from(productReviews)
    .where(sql`${productReviews.orderItemId} = ${line.orderItemId} OR (
      ${productReviews.productId} = ${line.productId}
      AND ${productReviews.reviewerKey} = ${reviewerKey}
      AND ${productReviews.status} IN ('pending', 'published')
    )`)
    .all();
  const onLine = existing.find((review) => review.orderItemId === line.orderItemId);
  if (onLine && (onLine.status === "pending" || onLine.status === "published")) {
    return { review: await getBuyerReview(db, buyer, onLine.id), created: false, published: onLine.status === "published" };
  }
  if (onLine) throw alreadyReviewed(onLine.id);
  const live = existing.find((review) => review.orderItemId !== line.orderItemId);
  if (live) throw alreadyReviewed(live.id);
  if (line.reviewable !== 1) throw notEligible();

  const check = checkReviewContent({ title, body }, { blockWords: settings.blockWords });
  const status = reviewStatusAfterCheck(settings.moderation, check);
  const now = nowSeconds();
  const id = newReviewId();
  const insert = db.insert(productReviews).values({
    id,
    productId: line.productId,
    variantId: line.variantId,
    orderId: line.orderId,
    orderItemId: line.orderItemId,
    reviewerKey,
    customerId: buyer.kind === "customer" ? buyer.customerId : line.accountOwnerCustomerId,
    authorType: buyer.kind,
    authorDisplayName: displayName ?? defaultReviewerDisplayName(line.customerName),
    variantLabel: line.variantLabel,
    rating,
    title,
    body,
    status,
    checkFlags: encodeCheckFlags(check.flags),
    publishedAt: status === "published" ? now : null,
    createdAt: now,
    updatedAt: now,
  });
  const staffAlert = status === "pending" ? reviewPendingOutbox(db, { id, orderId: line.orderId, version: 1 }) : null;
  try {
    if (staffAlert) await safeBatch(db, [insert, staffAlert.statement] as const);
    else await insert.run();
  } catch (error) {
    if (isConstraintFailure(error, /review requires a fulfilled line/)) throw notEligible();
    if (isConstraintFailure(error, /UNIQUE|unique|duplicate key|constraint/)) {
      // A concurrent submit won: an idempotent retry on the same line, or a 409.
      const winner = await db
        .select({ id: productReviews.id, orderItemId: productReviews.orderItemId, status: productReviews.status })
        .from(productReviews)
        .where(sql`${productReviews.orderItemId} = ${line.orderItemId} OR (
          ${productReviews.productId} = ${line.productId}
          AND ${productReviews.reviewerKey} = ${reviewerKey}
          AND ${productReviews.status} IN ('pending', 'published')
        )`)
        .get();
      if (winner?.orderItemId === line.orderItemId && (winner.status === "pending" || winner.status === "published")) {
        return { review: await getBuyerReview(db, buyer, winner.id), created: false, published: winner.status === "published" };
      }
      if (winner) throw alreadyReviewed(winner.id);
    }
    throw error;
  }
  await handOver(db, options.queue, staffAlert?.outboxId ?? null);
  return { review: await getBuyerReview(db, buyer, id), created: true, published: status === "published" };
}

/**
 * Edits the buyer's review (rating, title, text, display name), at most 10
 * times a day. Auto mode re-runs the content check: a clean edit stays (or
 * becomes) published, a flagged one waits for moderation; hold mode always
 * sends it back to moderation. `rating` is always written, so the stats
 * projection's `updated_at` moves and the cron's coalesced cache bump sees
 * text-only edits of published reviews too.
 */
export async function editReview(
  db: Database,
  buyer: ReviewBuyer,
  reviewId: string,
  input: EditReviewInput,
  options: ReviewWriteOptions = {},
): Promise<ReviewWriteResult> {
  const settings = await requireReviewSettings(db);
  const current = await readBuyerReviewRow(db, buyer, reviewId);
  if (!current) throw notFoundReview();
  if (current.status !== "pending" && current.status !== "published") {
    throw new AppError(409, "REVIEW_NOT_EDITABLE", "This review can no longer be edited.");
  }
  if (current.version !== input.version) {
    throw new ConflictError("This review changed since you opened it. Reload and try again.");
  }
  const now = nowSeconds();
  const today = Math.floor(now / DAY_SECONDS);
  const used = editsUsedToday(current, today);
  if (used >= REVIEW_LIMITS.editsPerDay) {
    throw new RateLimitError("You've edited this review too many times today. Try again tomorrow.");
  }

  const rating = input.rating === undefined ? current.rating : readRating(input.rating);
  const title = input.title === undefined ? current.title : readText(input.title, "title");
  const body = input.body === undefined ? current.body : readText(input.body, "body");
  let displayName = current.displayName;
  if (input.displayName !== undefined) {
    const chosen = readText(input.displayName, "displayName");
    if (chosen) displayName = chosen;
    else {
      const order = await db.select({ customerName: orders.customerName }).from(orders).where(eq(orders.id, current.orderId)).get();
      displayName = defaultReviewerDisplayName(order?.customerName);
    }
  }

  const check = checkReviewContent({ title, body }, { blockWords: settings.blockWords });
  const status = reviewStatusAfterCheck(settings.moderation, check);
  if (status !== current.status && !canTransitionReviewStatus(current.status, status, "system")) {
    throw new AppError(409, "REVIEW_NOT_EDITABLE", "This review can no longer be edited.");
  }
  const nextVersion = current.version + 1;
  const update = db.update(productReviews)
    .set({
      rating,
      title,
      body,
      authorDisplayName: displayName,
      status,
      checkFlags: encodeCheckFlags(check.flags),
      ...(status === "published" ? { publishedAt: sql`coalesce(${productReviews.publishedAt}, ${now})` } : {}),
      editCountDay: used + 1,
      editDay: today,
      editedAt: now,
      version: nextVersion,
      updatedAt: now,
    })
    .where(and(
      eq(productReviews.id, current.id),
      eq(productReviews.version, current.version),
      inArray(productReviews.status, ["pending", "published"]),
    ))
    .returning({ id: productReviews.id });
  const staffAlert = status === "pending"
    ? reviewPendingOutbox(db, { id: current.id, orderId: current.orderId, version: nextVersion })
    : null;
  const updated = staffAlert
    ? (await safeBatch(db, [update, staffAlert.statement] as const))[0]
    : await update;
  if (updated.length === 0) throw new ConflictError("This review changed since you opened it. Reload and try again.");
  await handOver(db, options.queue, staffAlert?.outboxId ?? null);
  return { review: await getBuyerReview(db, buyer, current.id), created: false, published: status === "published" };
}

/** Takes the review down (pending or published → withdrawn). Terminal; the buyer may then review another purchase of the product. */
export async function withdrawReview(
  db: Database,
  buyer: ReviewBuyer,
  reviewId: string,
  input: { version: number },
): Promise<BuyerReview> {
  const current = await readBuyerReviewRow(db, buyer, reviewId);
  if (!current) throw notFoundReview();
  if (!canTransitionReviewStatus(current.status, "withdrawn", "buyer")) {
    throw new AppError(409, "REVIEW_NOT_EDITABLE", "This review can no longer be changed.");
  }
  const now = nowSeconds();
  const updated = await db.update(productReviews)
    .set({ status: "withdrawn", version: current.version + 1, updatedAt: now })
    .where(and(
      eq(productReviews.id, current.id),
      eq(productReviews.version, input.version),
      inArray(productReviews.status, ["pending", "published"]),
    ))
    .returning({ id: productReviews.id });
  if (updated.length === 0) throw new ConflictError("This review changed since you opened it. Reload and try again.");
  return getBuyerReview(db, buyer, current.id);
}
