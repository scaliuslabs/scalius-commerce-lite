// Staff review moderation (Wave B §2.1, §7.2): the moderation queue, one
// review, bulk publish / reject / restore, the merchant's public reply and
// the private "Message the reviewer" thread. Staff never author or edit the
// buyer's text: the only staff writes are status, reason and reply. The
// routes bump the cache generation once per request that changed anything a
// buyer can see.
import { nanoid } from "nanoid";
import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
  conversations,
  media,
  orders,
  productMedia,
  productReviews,
  productReviewStats,
  products,
  user,
} from "@scalius/database/schema";
import {
  isReviewRejectionReason,
  normalizeReviewBlockWords,
  normalizeReviewText,
  REVIEW_RATINGS,
} from "@scalius/shared/reviews";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../errors";
import { publishedMediaObjectKey } from "../media/media.presentation";
import {
  reviewsDocument,
  type ReviewSettings,
} from "../settings/documents";
import { readSettingsDocumentStrict } from "../settings/settings-store";
import {
  ADMIN_REVIEW_PAGE_SIZE,
  REVIEW_MODERATION_BATCH_MAX,
  type ReviewAuthorType,
  type ReviewModerationAction,
  type ReviewModerationReason,
  type ReviewStatus,
} from "./browser";
import {
  decodeCheckFlags,
  isoFromSeconds,
  notFoundReview,
  nowSeconds,
} from "./shared";

export interface AdminReview {
  id: string;
  status: ReviewStatus;
  rating: number;
  title: string | null;
  body: string | null;
  authorName: string;
  authorType: ReviewAuthorType;
  variantLabel: string | null;
  product: { id: string; name: string; slug: string | null; imageObjectKey: string | null };
  order: { id: string; orderNumber: string };
  /** Why the automatic check held it (flags only). */
  checkFlags: string[];
  moderationReason: ReviewModerationReason | null;
  reply: { body: string; repliedAt: string; authorName: string | null } | null;
  /** The private thread with the reviewer, once staff opened it. */
  conversationId: string | null;
  createdAt: string;
  publishedAt: string | null;
  editedAt: string | null;
  updatedAt: string;
  version: number;
}

export interface AdminReviewFilters {
  status?: ReviewStatus;
  rating?: number;
  productId?: string;
  /** Title, text or reviewer name (case-insensitive). */
  q?: string;
  cursor?: string | null;
}

export interface AdminReviewPage {
  items: AdminReview[];
  nextCursor: string | null;
}

function adminReviewSelect() {
  return {
    id: productReviews.id,
    status: productReviews.status,
    rating: productReviews.rating,
    title: productReviews.title,
    body: productReviews.body,
    authorName: productReviews.authorDisplayName,
    authorType: productReviews.authorType,
    variantLabel: productReviews.variantLabel,
    productId: productReviews.productId,
    productName: sql<string>`coalesce(${products.name}, '')`,
    productSlug: products.slug,
    productImageObjectKey: sql<string | null>`(
      SELECT CASE WHEN ${media.status} IN ('ready', 'trashed') THEN ${publishedMediaObjectKey()} END
      FROM ${productMedia}
      INNER JOIN ${media} ON ${media.id} = ${productMedia.mediaId}
      WHERE ${productMedia.productId} = ${productReviews.productId}
      ORDER BY ${productMedia.isPrimary} DESC, ${productMedia.sortOrder}, ${productMedia.id}
      LIMIT 1
    )`,
    orderId: productReviews.orderId,
    orderNumber: orders.orderNumber,
    checkFlags: productReviews.checkFlags,
    moderationReason: productReviews.moderationReason,
    replyBody: productReviews.replyBody,
    repliedAt: productReviews.repliedAt,
    replyAuthorName: user.name,
    conversationId: sql<string | null>`(
      SELECT ${conversations.id} FROM ${conversations}
      WHERE ${conversations.subjectType} = 'review' AND ${conversations.subjectId} = ${productReviews.id}
    )`,
    createdAt: productReviews.createdAt,
    publishedAt: productReviews.publishedAt,
    editedAt: productReviews.editedAt,
    updatedAt: productReviews.updatedAt,
    version: productReviews.version,
  };
}

type AdminReviewRow = {
  id: string;
  status: ReviewStatus;
  rating: number;
  title: string | null;
  body: string | null;
  authorName: string;
  authorType: ReviewAuthorType;
  variantLabel: string | null;
  productId: string;
  productName: string;
  productSlug: string | null;
  productImageObjectKey: string | null;
  orderId: string;
  orderNumber: number | null;
  checkFlags: string | null;
  moderationReason: ReviewModerationReason | null;
  replyBody: string | null;
  repliedAt: number | null;
  replyAuthorName: string | null;
  conversationId: string | null;
  createdAt: number;
  publishedAt: number | null;
  editedAt: number | null;
  updatedAt: number;
  version: number;
};

function presentAdminReview(row: AdminReviewRow): AdminReview {
  return {
    id: row.id,
    status: row.status,
    rating: row.rating,
    title: row.title,
    body: row.body,
    authorName: row.authorName,
    authorType: row.authorType,
    variantLabel: row.variantLabel,
    product: { id: row.productId, name: row.productName, slug: row.productSlug, imageObjectKey: row.productImageObjectKey },
    order: { id: row.orderId, orderNumber: formatOrderNumber(row.orderNumber, row.orderId) },
    checkFlags: decodeCheckFlags(row.checkFlags),
    moderationReason: row.moderationReason,
    reply: row.replyBody && row.repliedAt !== null
      ? { body: row.replyBody, repliedAt: isoFromSeconds(row.repliedAt)!, authorName: row.replyAuthorName }
      : null,
    conversationId: row.conversationId,
    createdAt: isoFromSeconds(row.createdAt)!,
    publishedAt: isoFromSeconds(row.publishedAt),
    editedAt: isoFromSeconds(row.editedAt),
    updatedAt: isoFromSeconds(row.updatedAt)!,
    version: row.version,
  };
}

function adminReviewQuery(db: Database) {
  return db
    .select(adminReviewSelect())
    .from(productReviews)
    .innerJoin(orders, eq(orders.id, productReviews.orderId))
    .leftJoin(products, eq(products.id, productReviews.productId))
    .leftJoin(user, eq(user.id, productReviews.replyUserId));
}

function encodeCursor(row: { createdAt: number; id: string }): string {
  return btoa(JSON.stringify([row.createdAt, row.id])).replace(/=+$/, "");
}

function decodeCursor(value: string | null | undefined): { createdAt: number; id: string } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (Array.isArray(parsed) && Number.isSafeInteger(parsed[0]) && typeof parsed[1] === "string" && parsed[1].length <= 80) {
      return { createdAt: parsed[0] as number, id: parsed[1] };
    }
  } catch {
    // An unreadable cursor restarts the list.
  }
  return null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The moderation queue, newest first (keyset on `(created_at, id)`). */
export async function listAdminReviews(db: Database, filters: AdminReviewFilters = {}): Promise<AdminReviewPage> {
  const conditions: SQL[] = [];
  if (filters.status) conditions.push(eq(productReviews.status, filters.status));
  if (filters.rating !== undefined && (REVIEW_RATINGS as readonly number[]).includes(filters.rating)) {
    conditions.push(eq(productReviews.rating, filters.rating));
  }
  if (filters.productId) conditions.push(eq(productReviews.productId, filters.productId));
  const q = filters.q?.trim().slice(0, 100);
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(or(
      sql`${productReviews.title} LIKE ${pattern} ESCAPE '\\'`,
      sql`${productReviews.body} LIKE ${pattern} ESCAPE '\\'`,
      sql`${productReviews.authorDisplayName} LIKE ${pattern} ESCAPE '\\'`,
      sql`${products.name} LIKE ${pattern} ESCAPE '\\'`,
    )!);
  }
  const cursor = decodeCursor(filters.cursor);
  if (cursor) {
    conditions.push(or(
      lt(productReviews.createdAt, cursor.createdAt),
      and(eq(productReviews.createdAt, cursor.createdAt), lt(productReviews.id, cursor.id)),
    )!);
  }
  const rows = await adminReviewQuery(db)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(productReviews.createdAt), desc(productReviews.id))
    .limit(ADMIN_REVIEW_PAGE_SIZE + 1)
    .all() as AdminReviewRow[];
  const page = rows.slice(0, ADMIN_REVIEW_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    items: page.map(presentAdminReview),
    nextCursor: rows.length > ADMIN_REVIEW_PAGE_SIZE && last ? encodeCursor(last) : null,
  };
}

export async function getAdminReview(db: Database, reviewId: string): Promise<AdminReview> {
  const row = await adminReviewQuery(db).where(eq(productReviews.id, reviewId)).get() as AdminReviewRow | undefined;
  if (!row) throw notFoundReview();
  return presentAdminReview(row);
}

export interface ProductReviewStatsSummary {
  productId: string;
  productName: string;
  /** Published reviews only (the stats projection). */
  count: number;
  average: number;
  histogram: Array<{ rating: number; count: number }>;
}

export interface AdminReviewSummary {
  pending: number;
  published: number;
  rejected: number;
  /** The product's published-review stats when the summary is for one product. */
  product: ProductReviewStatsSummary | null;
}

/** Counts per status (the Pending badge and tabs), and a product's rating stats when asked. */
export async function getAdminReviewSummary(db: Database, options: { productId?: string } = {}): Promise<AdminReviewSummary> {
  const counts = await db
    .select({ status: productReviews.status, count: sql<number>`count(*)` })
    .from(productReviews)
    .where(options.productId ? eq(productReviews.productId, options.productId) : undefined)
    .groupBy(productReviews.status)
    .all();
  const count = (status: ReviewStatus) => Number(counts.find((row) => row.status === status)?.count ?? 0);
  let product: ProductReviewStatsSummary | null = null;
  if (options.productId) {
    const row = await db
      .select({
        productId: products.id,
        productName: products.name,
        reviewCount: productReviewStats.reviewCount,
        ratingAvgCenti: productReviewStats.ratingAvgCenti,
        count1: productReviewStats.count1,
        count2: productReviewStats.count2,
        count3: productReviewStats.count3,
        count4: productReviewStats.count4,
        count5: productReviewStats.count5,
      })
      .from(products)
      .leftJoin(productReviewStats, eq(productReviewStats.productId, products.id))
      .where(eq(products.id, options.productId))
      .get();
    if (!row) throw new NotFoundError("Product not found");
    product = {
      productId: row.productId,
      productName: row.productName,
      count: row.reviewCount ?? 0,
      average: (row.ratingAvgCenti ?? 0) / 100,
      histogram: [
        { rating: 5, count: row.count5 ?? 0 },
        { rating: 4, count: row.count4 ?? 0 },
        { rating: 3, count: row.count3 ?? 0 },
        { rating: 2, count: row.count2 ?? 0 },
        { rating: 1, count: row.count1 ?? 0 },
      ],
    };
  }
  return { pending: count("pending"), published: count("published"), rejected: count("rejected"), product };
}

// ─────────────────────────────────────────
// Moderation
// ─────────────────────────────────────────

const MODERATION_FROM: Record<ReviewModerationAction, readonly ReviewStatus[]> = {
  publish: ["pending"],
  reject: ["pending", "published"],
  restore: ["rejected"],
};

export interface ModerateReviewsInput {
  ids: readonly string[];
  action: ReviewModerationAction;
  /** Required to reject: a content reason, never the rating. */
  reason?: string | null;
}

export interface ModerateReviewsResult {
  /** Reviews this request moved, with the status each had before (for undo). */
  updated: Array<{ id: string; previousStatus: ReviewStatus }>;
  /** Ids that were not in a status the action applies to (or do not exist). */
  skipped: string[];
  /** Whether a published review appeared or disappeared (the route bumps the cache). */
  publicChange: boolean;
}

/**
 * Publish, reject or restore up to 90 reviews in one statement (the stats
 * triggers run per row). Idempotent: a repeat finds the reviews already moved
 * and skips them.
 */
export async function moderateReviews(db: Database, input: ModerateReviewsInput): Promise<ModerateReviewsResult> {
  const ids = [...new Set(input.ids.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new ValidationError("Choose at least one review.");
  if (ids.length > REVIEW_MODERATION_BATCH_MAX) {
    throw new ValidationError(`Moderate at most ${REVIEW_MODERATION_BATCH_MAX} reviews at a time.`);
  }
  let reason: ReviewModerationReason | null = null;
  if (input.action === "reject") {
    if (!isReviewRejectionReason(input.reason)) {
      throw new ValidationError("Choose why the review is rejected.", { field: "reason" });
    }
    reason = input.reason;
  }
  const from = MODERATION_FROM[input.action];
  const before = await db
    .select({ id: productReviews.id, status: productReviews.status })
    .from(productReviews)
    .where(and(inArray(productReviews.id, ids), inArray(productReviews.status, [...from])))
    .all();
  if (before.length === 0) return { updated: [], skipped: ids, publicChange: false };

  const now = nowSeconds();
  const toStatus: ReviewStatus = input.action === "reject" ? "rejected" : "published";
  const moved = await db.update(productReviews)
    .set({
      status: toStatus,
      moderationReason: reason,
      ...(toStatus === "published" ? { publishedAt: sql`coalesce(${productReviews.publishedAt}, ${now})` } : {}),
      version: sql`${productReviews.version} + 1`,
      updatedAt: now,
    })
    .where(and(inArray(productReviews.id, before.map((row) => row.id)), inArray(productReviews.status, [...from])))
    .returning({ id: productReviews.id });
  const movedIds = new Set(moved.map((row) => row.id));
  const previous = new Map(before.map((row) => [row.id, row.status]));
  // In the order the ids were given.
  const updated = ids
    .filter((id) => movedIds.has(id))
    .map((id) => ({ id, previousStatus: previous.get(id)! }));
  return {
    updated,
    skipped: ids.filter((id) => !movedIds.has(id)),
    publicChange: updated.some((row) => row.previousStatus === "published" || toStatus === "published"),
  };
}

/**
 * Sets or removes the merchant's public reply ("Response from <store>"),
 * guarded by the review's version. Returns whether the reply is public now
 * (the review is published), so the route bumps the cache only then.
 */
export async function setReviewReply(
  db: Database,
  input: { reviewId: string; body: unknown; version: number; userId: string },
): Promise<{ review: AdminReview; publicChange: boolean }> {
  const text = normalizeReviewText(input.body, "reply");
  if (!text.ok) {
    throw new ValidationError(text.reason === "too_long" ? "The reply is too long." : "The reply has characters we can't accept.", { field: "body" });
  }
  const now = nowSeconds();
  const updated = await db.update(productReviews)
    .set({
      replyBody: text.value,
      replyUserId: text.value === null ? null : input.userId,
      repliedAt: text.value === null ? null : now,
      version: input.version + 1,
      updatedAt: now,
    })
    .where(and(eq(productReviews.id, input.reviewId), eq(productReviews.version, input.version)))
    .returning({ id: productReviews.id, status: productReviews.status });
  if (updated.length === 0) {
    const exists = await db.select({ id: productReviews.id }).from(productReviews).where(eq(productReviews.id, input.reviewId)).get();
    if (!exists) throw notFoundReview();
    throw new ConflictError("This review changed since you opened it. Reload and try again.");
  }
  return { review: await getAdminReview(db, input.reviewId), publicChange: updated[0]!.status === "published" };
}

/**
 * The private thread with the reviewer ("Message the reviewer"): one per
 * review (`subject_type = 'review'`), on the review's order, so buyer access
 * derives from the order like every order-scoped thread. Creating it never
 * touches the order or the review.
 */
export async function openReviewThread(db: Database, reviewId: string): Promise<{ conversationId: string }> {
  const review = await db
    .select({ id: productReviews.id, orderId: productReviews.orderId, productName: products.name })
    .from(productReviews)
    .leftJoin(products, eq(products.id, productReviews.productId))
    .where(eq(productReviews.id, reviewId))
    .get();
  if (!review) throw notFoundReview();
  const existing = () => db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.subjectType, "review"), eq(conversations.subjectId, review.id)))
    .get();
  const found = await existing();
  if (found) return { conversationId: found.id };
  const now = nowSeconds();
  const subject = Array.from(`Your review of ${review.productName ?? "your order"}`).slice(0, 120).join("");
  await db.insert(conversations).values({
    id: `cnv_${nanoid(20)}`,
    subjectType: "review",
    subjectId: review.id,
    orderId: review.orderId,
    subject,
    status: "open",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const created = await existing();
  if (!created) throw new ConflictError("The conversation could not be started. Please try again.");
  return { conversationId: created.id };
}

// ─────────────────────────────────────────
// Settings
// ─────────────────────────────────────────

export interface ReviewSettingsView extends ReviewSettings {
  revision: number;
}

/** The reviews settings for the dashboard (a 503 when the stored document is unreadable). */
export async function getReviewSettingsForAdmin(db: Database): Promise<ReviewSettingsView> {
  const read = await readSettingsDocumentStrict(reviewsDocument, db);
  if (!read.ok) throw new AppError(503, "REVIEW_SETTINGS_UNREADABLE", "Review settings could not be read. Save them again to repair them.");
  return { ...read.value, revision: read.revision };
}

/**
 * Saves the reviews settings against the revision the editor loaded. Block
 * words are cleaned by the same rule the content check uses.
 */
export async function saveReviewSettings(
  db: Database,
  patch: Partial<ReviewSettings>,
  expectedRevision: number,
): Promise<ReviewSettingsView> {
  const clean: Partial<ReviewSettings> = { ...patch };
  if (patch.blockWords) clean.blockWords = normalizeReviewBlockWords(patch.blockWords);
  const saved = await reviewsDocument.write(db, clean, undefined, { expectedRevision });
  return { ...saved.value, revision: saved.revision };
}
