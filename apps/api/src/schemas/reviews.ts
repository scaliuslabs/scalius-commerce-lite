// OpenAPI schemas for reviews (Wave B §7): the public review list and the
// product page's `reviews` field, the buyer's reviews and lines to review,
// and the dashboard moderation shapes. Review text is buyer content: it is
// only ever in response bodies and POST/PATCH bodies, never in URLs.
import { z } from "@hono/zod-openapi";
import {
  REVIEW_AUTHOR_TYPES,
  REVIEW_MODERATION_ACTIONS,
  REVIEW_MODERATION_BATCH_MAX,
  REVIEW_MODERATION_MODES,
  REVIEW_MODERATION_REASONS,
  REVIEW_STATUSES,
} from "@scalius/core/modules/reviews/browser";
import { REVIEW_LIMITS } from "@scalius/shared/reviews";

const iso = z.string().openapi({ format: "date-time" });
const rating = z.number().int().min(1).max(5);

export const reviewStatusSchema = z.enum(REVIEW_STATUSES);

// ── Public ────────────────────────────────────────────────────────────────

export const publicReviewSummarySchema = z.object({
  average: z.number().min(0).max(5).openapi({ description: "Average of published reviews, truncated to two decimals; 0 with none." }),
  count: z.number().int().nonnegative(),
  histogram: z.array(z.object({ rating, count: z.number().int().nonnegative() })).length(5)
    .openapi({ description: "Published reviews per star, 5★ first." }),
}).openapi("PublicReviewSummary");

export const publicReviewSchema = z.object({
  id: z.string(),
  rating,
  title: z.string().nullable(),
  body: z.string().nullable(),
  authorName: z.string(),
  variantLabel: z.string().nullable(),
  verifiedPurchase: z.literal(true),
  publishedAt: iso,
  editedAt: iso.nullable(),
  reply: z.object({ body: z.string(), repliedAt: iso }).nullable()
    .openapi({ description: "The merchant's public reply (\"Response from <store>\")." }),
}).openapi("PublicReview");

export const productReviewsSchema = z.object({
  summary: publicReviewSummarySchema,
  items: z.array(publicReviewSchema),
  nextCursor: z.string().nullable(),
}).openapi("ProductReviews");

/** Spread into the product page's product object. */
export const productPageReviewFields = {
  reviews: productReviewsSchema.nullable().openapi({
    description: "Published reviews: the summary and the five most recent (the same reviews the page shows and describes in JSON-LD). Null when the store's reviews are off; `count: 0` shows the zero state.",
  }),
  warranty: z.object({
    name: z.string(),
    provider: z.enum(["brand", "store"]),
    duration: z.object({ value: z.number().int().positive(), unit: z.enum(["days", "months", "years"]) }),
    replacementDays: z.number().int().nonnegative().nullable(),
    terms: z.string().nullable(),
  }).nullable().openapi({ description: "The product's warranty policy (its current terms); null without one." }),
};

// ── Buyer ─────────────────────────────────────────────────────────────────

export const buyerReviewSchema = z.object({
  id: z.string(),
  orderId: z.string(),
  orderItemId: z.string(),
  productId: z.string(),
  productName: z.string(),
  productSlug: z.string().nullable(),
  variantLabel: z.string().nullable(),
  rating,
  title: z.string().nullable(),
  body: z.string().nullable(),
  displayName: z.string(),
  status: reviewStatusSchema,
  reply: z.object({ body: z.string(), repliedAt: iso }).nullable(),
  createdAt: iso,
  publishedAt: iso.nullable(),
  editedAt: iso.nullable(),
  version: z.number().int().positive(),
  canEdit: z.boolean(),
}).openapi("BuyerReview");

export const reviewableLineSchema = z.object({
  orderId: z.string(),
  orderNumber: z.string(),
  orderItemId: z.string(),
  productId: z.string(),
  productName: z.string(),
  productSlug: z.string().nullable(),
  variantLabel: z.string().nullable(),
  imageUrl: z.string().nullable(),
  fulfilledAt: iso.nullable(),
}).openapi("ReviewableLine");

export const buyerReviewsResponseSchema = z.object({
  /** Lines waiting for a review (one per product). */
  toReview: z.array(reviewableLineSchema),
  reviews: z.array(buyerReviewSchema),
}).openapi("BuyerReviews");

export const reviewWriteResponseSchema = z.object({
  review: buyerReviewSchema,
  /** False when this line already had its review (an idempotent retry). */
  created: z.boolean(),
  /** Live on the product page now; false while it waits for moderation. */
  published: z.boolean(),
}).openapi("ReviewWriteResult");

const textInput = (max: number) => z.string().max(max * 2).nullable().optional();

export const submitReviewBodySchema = z.object({
  orderItemId: z.string().trim().min(1).max(128),
  rating,
  title: textInput(REVIEW_LIMITS.titleLength),
  body: textInput(REVIEW_LIMITS.bodyLength),
  displayName: textInput(REVIEW_LIMITS.displayNameLength),
  /** A per-attempt key from the form; a retry of the same line returns the same review. */
  clientKey: z.string().trim().min(8).max(64).optional(),
}).strict().openapi("SubmitReviewBody");

export const editReviewBodySchema = z.object({
  version: z.number().int().positive(),
  /** `true` withdraws the review (it leaves the product page; the buyer can't restore it). */
  withdraw: z.literal(true).optional(),
  rating: rating.optional(),
  title: textInput(REVIEW_LIMITS.titleLength),
  body: textInput(REVIEW_LIMITS.bodyLength),
  displayName: textInput(REVIEW_LIMITS.displayNameLength),
}).strict().openapi("EditReviewBody");

// ── Dashboard ─────────────────────────────────────────────────────────────

export const adminReviewSchema = z.object({
  id: z.string(),
  status: reviewStatusSchema,
  rating,
  title: z.string().nullable(),
  body: z.string().nullable(),
  authorName: z.string(),
  authorType: z.enum(REVIEW_AUTHOR_TYPES),
  variantLabel: z.string().nullable(),
  product: z.object({ id: z.string(), name: z.string(), slug: z.string().nullable(), imageUrl: z.string().nullable() }),
  order: z.object({ id: z.string(), orderNumber: z.string() }),
  checkFlags: z.array(z.string()).openapi({ description: "Why the automatic check held it: url, email, phone, repeated_characters, block_word." }),
  moderationReason: z.enum(REVIEW_MODERATION_REASONS).nullable(),
  reply: z.object({ body: z.string(), repliedAt: iso, authorName: z.string().nullable() }).nullable(),
  conversationId: z.string().nullable(),
  createdAt: iso,
  publishedAt: iso.nullable(),
  editedAt: iso.nullable(),
  updatedAt: iso,
  version: z.number().int().positive(),
}).openapi("AdminReview");

export const adminReviewListQuerySchema = z.object({
  status: reviewStatusSchema.optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  productId: z.string().trim().min(1).max(128).optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().max(200).optional(),
});

export const adminReviewPageSchema = z.object({
  items: z.array(adminReviewSchema),
  nextCursor: z.string().nullable(),
}).openapi("AdminReviewPage");

export const productReviewStatsSummarySchema = z.object({
  productId: z.string(),
  productName: z.string(),
  count: z.number().int().nonnegative(),
  average: z.number().min(0).max(5),
  histogram: z.array(z.object({ rating, count: z.number().int().nonnegative() })),
}).openapi("ProductReviewStatsSummary");

export const adminReviewSummarySchema = z.object({
  pending: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  product: productReviewStatsSummarySchema.nullable(),
}).openapi("AdminReviewSummary");

export const moderateReviewsBodySchema = z.object({
  ids: z.array(z.string().trim().min(1).max(80)).min(1).max(REVIEW_MODERATION_BATCH_MAX),
  action: z.enum(REVIEW_MODERATION_ACTIONS),
  reason: z.enum(REVIEW_MODERATION_REASONS).optional().openapi({ description: "Required to reject. A content reason; a low rating is never one." }),
  requestKey: z.string().trim().min(8).max(64),
}).strict().openapi("ModerateReviewsBody");

export const moderateReviewsResultSchema = z.object({
  updated: z.array(z.object({ id: z.string(), previousStatus: reviewStatusSchema })),
  skipped: z.array(z.string()),
}).openapi("ModerateReviewsResult");

export const reviewReplyBodySchema = z.object({
  body: z.string().max(REVIEW_LIMITS.replyLength * 2).nullable(),
  version: z.number().int().positive(),
}).strict().openapi("ReviewReplyBody");

export const reviewSettingsSchema = z.object({
  enabled: z.boolean(),
  moderation: z.enum(REVIEW_MODERATION_MODES),
  requestsEnabled: z.boolean(),
  requestDelayDays: z.number().int().min(1).max(60),
  blockWords: z.array(z.string()).max(REVIEW_LIMITS.blockWords),
  revision: z.number().int().nonnegative(),
}).openapi("ReviewSettings");

export const reviewSettingsBodySchema = z.object({
  enabled: z.boolean().optional(),
  moderation: z.enum(REVIEW_MODERATION_MODES).optional(),
  requestsEnabled: z.boolean().optional(),
  requestDelayDays: z.number().int().min(1).max(60).optional(),
  blockWords: z.array(z.string().max(REVIEW_LIMITS.blockWordLength * 2)).max(REVIEW_LIMITS.blockWords * 2).optional(),
  expectedRevision: z.number().int().nonnegative(),
}).strict().openapi("ReviewSettingsBody");
