// Product reviews in the stable app API (operation-registry/README.md),
// mounted at /admin/resources: each review as its webhooks carry it
// (`ReviewResource`, the `review` representation), listed by cursor in
// (updatedAt, id) order with `updatedSince`, written by an app (an import of
// history, a reviews app) and moderated under its revision.
//
// Only an app writes a review (`reviews.create`): staff never author buyer
// text. The core write (`reviews/apps.ts`) goes through `product_reviews`
// itself, so the stats projection, the cache dependency triggers and the
// review webhooks follow as for a buyer's review, and the app is recorded as
// the author. A review is a verified purchase only on a delivered order line
// of its customer; an app's `verified: true` without one is refused. The
// review's id derives from the required Idempotency-Key (per caller), so a
// repeat, even after a lost response, writes nothing twice. The reviewer's
// name is protected (`read_customer_names`). The dashboard's moderation
// queue and bulk moderation stay `dashboard.reviews.*` (beta).
import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "./admin-router";
import type { MiddlewareHandler } from "hono";
import { eq, gte, type SQL } from "drizzle-orm";
import { productReviews } from "@scalius/database/schema";
import {
  APP_REVIEW_CREATE_STATUSES,
  APP_REVIEW_MODERATION_STATUSES,
  REVIEW_MODERATION_REASONS,
  REVIEW_STATUSES,
  createAppReview,
  setReviewStatus,
} from "@scalius/core/modules/reviews";
import { REVIEW_LIMITS } from "@scalius/shared/reviews";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { sha256Hex } from "@scalius/shared/hash";
import { keysetOrderBy } from "@scalius/core/utils/keyset";
import { created, ok } from "../../utils/api-response";
import { AppError, NotFoundError } from "../../utils/api-error";
import { conflictResponse, errorResponses, namedSharedSchema, successEnvelope } from "../../schemas/responses";
import { nextCursorSchema } from "../../utils/bounded-page";
import { epochSeconds, resourcePage, resourcePageQuery, updatedOrder } from "../../utils/resource-page";
import { readReviewRepresentations } from "../../events/representations";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";
import { requestAppId } from "./request-actor";

const app = adminRouter();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const ReviewResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.review, "ReviewResource");
const reviewEnvelope = successEnvelope(z.object({ review: ReviewResource }));
const idParam = z.object({ id: z.string().min(1).max(80) });
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };
const writeResponses = { ...errorResponses, 409: conflictResponse };
const CREATE_OPERATION = "dashboard.resources.reviews.create";

async function readReview(db: Parameters<typeof readReviewRepresentations>[0], id: string) {
  const review = (await readReviewRepresentations(db, [id]))[0];
  if (!review) throw new NotFoundError("Review not found");
  return review;
}

app.openapi(createRoute({
  operationId: "dashboard.resources.reviews.list",
  method: "get",
  path: "/reviews",
  tags: ["App API - Reviews"],
  summary: "List product reviews, least recently updated first",
  description: "Reviews as webhooks carry them (ReviewResource: status, rating, text, the order line when it is a verified purchase, the app that wrote it, revision), every status, in (updatedAt, id) order. Filter by product, status or customer; start a sync with updatedSince and follow nextCursor. The reviewer's name reads null without read_customer_names.",
  request: {
    query: z.object({
      ...resourcePageQuery,
      productId: z.string().min(1).max(128).optional().openapi({ description: "Only this product's reviews." }),
      status: z.enum(REVIEW_STATUSES).optional().openapi({ description: "Only reviews in this status (`pending` is the moderation queue); omitted, every status." }),
      customerId: z.string().min(1).max(128).optional().openapi({ description: "Only this customer's reviews." }),
    }),
  },
  responses: {
    200: { description: "A page of reviews", content: { "application/json": { schema: successEnvelope(z.object({ reviews: z.array(ReviewResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const query = c.req.valid("query");
  const db = c.get("db");
  const where: SQL[] = [];
  if (query.productId) where.push(eq(productReviews.productId, query.productId));
  if (query.status) where.push(eq(productReviews.status, query.status));
  if (query.customerId) where.push(eq(productReviews.customerId, query.customerId));
  if (query.updatedSince) where.push(gte(productReviews.updatedAt, epochSeconds(query.updatedSince)));
  const order = updatedOrder(productReviews.updatedAt, productReviews.id);
  const page = await resourcePage({
    order,
    cursor: query.cursor,
    limit: query.limit,
    where,
    ids: (condition, limit) => db.select({ id: productReviews.id }).from(productReviews).where(condition).orderBy(...keysetOrderBy(order)).limit(limit).all(),
    load: (ids) => readReviewRepresentations(db, ids),
  });
  return ok(c, { reviews: page.items, nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.reviews.get",
  method: "get",
  path: "/reviews/{id}",
  tags: ["App API - Reviews"],
  summary: "Get a product review",
  description: "One review as its webhooks carry it, with the revision to moderate it at. The reviewer's name reads null without read_customer_names.",
  request: { params: idParam },
  responses: {
    200: { description: "The review", content: { "application/json": { schema: reviewEnvelope } } },
    ...readResponses,
  },
}), async (c) => ok(c, { review: await readReview(c.get("db"), c.req.valid("param").id) }));

const textInput = (max: number) => z.string().max(max * 2).nullable().optional();

app.openapi(createRoute({
  operationId: CREATE_OPERATION,
  method: "post",
  path: "/reviews",
  tags: ["App API - Reviews"],
  summary: "Write a product review (an import or a reviews app)",
  description: "Writes a review of a product as the calling app (only an app writes reviews: 403 `app_principal_required` otherwise). Name the delivered order line it reviews (`orderItemId`) to make it a verified purchase of that line's customer; `verified: true` without one, or on another customer's line, is refused with 422 `review_not_verifiable`. An import of history names no line (and may name a `customerId`), is shown without \"Verified purchase\" and never takes a buyer's one live review of the product. `status: \"published\"` puts it on the product page unless the store's content check holds it (links, emails, phone numbers, blocked words): it then waits as `pending`. A line's buyer has one live review per product (409 `review_exists`). The Idempotency-Key is required: the review's id derives from it, so a repeat answers the same review and writes nothing twice; the key reused for another review is refused (422 `idempotency_key_reused`).",
  request: {
    headers: z.object({
      "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
        description: "Required: one key writes one review; a repeat answers it.",
      }),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            productId: z.string().min(1).max(128),
            variantId: z.string().min(1).max(128).nullable().optional().openapi({ description: "The variant reviewed (one of the product's); a line's own variant when `orderItemId` is set." }),
            orderItemId: z.string().min(1).max(128).nullable().optional().openapi({ description: "The delivered order line reviewed: the review is then a verified purchase of the line's customer." }),
            customerId: z.string().min(1).max(128).nullable().optional().openapi({ description: "The customer who wrote it; with `orderItemId`, the line's order must be theirs." }),
            rating: z.number().int().min(1).max(5),
            title: textInput(REVIEW_LIMITS.titleLength).openapi({ description: `At most ${REVIEW_LIMITS.titleLength} characters.` }),
            body: textInput(REVIEW_LIMITS.bodyLength).openapi({ description: `At most ${REVIEW_LIMITS.bodyLength} characters.` }),
            authorDisplayName: textInput(REVIEW_LIMITS.displayNameLength).openapi({ description: `The name it is shown under (at most ${REVIEW_LIMITS.displayNameLength} characters); defaults to the customer's ("First L."). Required with no customer.` }),
            status: z.enum(APP_REVIEW_CREATE_STATUSES).default("pending").openapi({ description: "`published` puts it on the product page (unless the content check holds it); `pending` sends it to moderation." }),
            createdAt: z.string().datetime({ offset: true }).optional().openapi({ description: "When it was written, for imported history (a past time); omitted, now." }),
            verified: z.boolean().optional().openapi({ description: "Claims a verified purchase: accepted only with an `orderItemId` that proves it." }),
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: { description: "The review", content: { "application/json": { schema: reviewEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const appId = requestAppId(c);
  if (!appId) throw new AppError(403, "app_principal_required", "Only an app writes a review here; staff moderate buyers' reviews.");
  const db = c.get("db");
  const body = c.req.valid("json");
  const scopedKey = await scopedRequestKey(c, CREATE_OPERATION, c.req.valid("header")["idempotency-key"]);
  const id = `rev_${(await sha256Hex(`review\n${scopedKey}`)).slice(0, 24)}`;
  const result = await createAppReview(db, {
    id,
    appId,
    productId: body.productId,
    variantId: body.variantId ?? null,
    orderItemId: body.orderItemId ?? null,
    customerId: body.customerId ?? null,
    rating: body.rating,
    title: body.title,
    body: body.body,
    authorDisplayName: body.authorDisplayName,
    status: body.status,
    createdAt: body.createdAt ? epochSeconds(body.createdAt) : null,
    verified: body.verified,
  });
  return created(c, { review: await readReview(db, result.reviewId) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.reviews.set_status",
  method: "post",
  path: "/reviews/{id}/status",
  tags: ["App API - Reviews"],
  summary: "Publish or reject a product review",
  description: "Moderates one review under the revision read: `published` puts a pending review on the product page or restores a rejected one; `rejected` takes it down (or keeps it off) with a content reason, never the rating. A review changed since is refused with 409 `review_revision_conflict` and nothing changes; a buyer's withdrawn review cannot be moderated (409 `review_state_conflict`). Asking for the status it has changes nothing.",
  request: {
    params: idParam,
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(APP_REVIEW_MODERATION_STATUSES),
            reason: z.enum(REVIEW_MODERATION_REASONS).optional().openapi({ description: "Required to reject: why (spam, abusive, personal_info, off_topic, not_about_product)." }),
            expectedRevision: z.number().int().min(1).openapi({ description: "The review's `revision` you read." }),
          }).strict(),
        },
      },
    },
  },
  responses: {
    200: { description: "The review", content: { "application/json": { schema: reviewEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const id = c.req.valid("param").id;
  await setReviewStatus(db, { reviewId: id, status: body.status, reason: body.reason ?? null, expectedRevision: body.expectedRevision });
  return ok(c, { review: await readReview(db, id) });
});

export { app as adminResourceReviewRoutes };
