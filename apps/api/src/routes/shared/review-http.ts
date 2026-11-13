// HTTP helpers shared by the signed-in and guest review routes (Wave B §2.6,
// §7.1): the write limiters, the image URL of a line to review, and the one
// PATCH handler (edit or withdraw). Review text and receipt proof never reach
// a log line, a URL or a limiter key in clear.
import type { Context } from "hono";
import {
  editReview,
  listBuyerReviews,
  listReviewableLines,
  submitReview,
  withdrawReview,
  type ReviewBuyer,
  type ReviewWriteResult,
} from "@scalius/core/modules/reviews";
import { getCurrentPublicMediaUrl } from "@scalius/core/integrations/storage";
import type { z } from "@hono/zod-openapi";
import { requireWithinRateLimit } from "../../utils/rate-limit";
import type { editReviewBodySchema, submitReviewBodySchema } from "../../schemas/reviews";
import { notificationSender } from "../../background/notification-sender";

/**
 * Every review write passes RL_STRICT per buyer (customer or receipt order);
 * the route class adds the per-address budget (runtime/route-limits.ts). A
 * missing binding fails closed (503).
 */
export async function enforceReviewWriteLimits(c: Context<{ Bindings: Env }>, buyer: ReviewBuyer): Promise<void> {
  const subject = buyer.kind === "customer" ? `customer:${buyer.customerId}` : `receipt:${buyer.orderId}`;
  await requireWithinRateLimit(c.env, "RL_STRICT", "review:write", subject, "You're sending too quickly. Please wait a moment and try again.");
}

/** The buyer's lines to review and their reviews. */
export async function readBuyerReviewsResponse(c: Context<{ Bindings: Env }>, buyer: ReviewBuyer) {
  const db = c.get("db");
  const toReview = await listReviewableLines(db, buyer);
  const reviews = await listBuyerReviews(db, buyer);
  return {
    toReview: toReview.map(({ imageObjectKey, ...line }) => ({
      ...line,
      imageUrl: imageObjectKey ? getCurrentPublicMediaUrl(imageObjectKey) : null,
    })),
    reviews,
  };
}

export async function submitBuyerReview(
  c: Context<{ Bindings: Env }>,
  buyer: ReviewBuyer,
  body: z.infer<typeof submitReviewBodySchema>,
): Promise<ReviewWriteResult> {
  await enforceReviewWriteLimits(c, buyer);
  return submitReview(c.get("db"), buyer, {
    orderItemId: body.orderItemId,
    rating: body.rating,
    title: body.title,
    body: body.body,
    displayName: body.displayName,
  }, { send: notificationSender(c) });
}

/** Edit (rating, title, text, name) or `withdraw: true`, guarded by the review version. */
export async function patchBuyerReview(
  c: Context<{ Bindings: Env }>,
  buyer: ReviewBuyer,
  reviewId: string,
  body: z.infer<typeof editReviewBodySchema>,
): Promise<ReviewWriteResult> {
  await enforceReviewWriteLimits(c, buyer);
  const db = c.get("db");
  if (body.withdraw) {
    const review = await withdrawReview(db, buyer, reviewId, { version: body.version });
    return { review, created: false, published: false };
  }
  return editReview(db, buyer, reviewId, {
    version: body.version,
    rating: body.rating,
    title: body.title,
    body: body.body,
    displayName: body.displayName,
  }, { send: notificationSender(c) });
}
