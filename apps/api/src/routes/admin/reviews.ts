// Dashboard review moderation routes, mounted at /admin/reviews (admin catalog
// family; Wave B design §7.2). Permissions live in
// packages/core/src/auth/rbac/route-permissions/reviews.ts. Staff never author
// or edit buyer text: the only writes are status, reason, reply, settings and
// opening a private thread with the reviewer. Database triggers advance
// dependencies when a write changes what buyers see.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  getAdminReview,
  getAdminReviewSummary,
  getReviewSettingsForAdmin,
  listAdminReviews,
  moderateReviews,
  openReviewThread,
  saveReviewSettings,
  setReviewReply,
  type AdminReview,
} from "@scalius/core/modules/reviews";
import { getCurrentPublicMediaUrl } from "@scalius/core/integrations/storage";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";
import {
  adminReviewListQuerySchema,
  adminReviewPageSchema,
  adminReviewSchema,
  adminReviewSummarySchema,
  moderateReviewsBodySchema,
  moderateReviewsResultSchema,
  reviewReplyBodySchema,
  reviewSettingsBodySchema,
  reviewSettingsSchema,
} from "../../schemas/reviews";

import { UnauthorizedError } from "../../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

const TAG = "Admin - Reviews";
const reviewParam = z.object({ id: z.string().trim().min(1).max(80) });
const writeResponses = { ...errorResponses, 409: conflictResponse };

function staffUserId(c: Context<{ Bindings: Env }>): string {
  const user = c.get("user") as { id?: string } | undefined;
  if (!user?.id) throw new UnauthorizedError("Sign in again to moderate reviews.");
  return user.id;
}

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-store");
}

function presentReview({ product, ...review }: AdminReview) {
  const { imageObjectKey, ...rest } = product;
  return { ...review, product: { ...rest, imageUrl: imageObjectKey ? getCurrentPublicMediaUrl(imageObjectKey) : null } };
}

app.openapi(createRoute({
  operationId: "dashboard.reviews.list",
  method: "get",
  path: "/",
  tags: [TAG],
  summary: "The review moderation queue, newest first (25 per page)",
  request: { query: adminReviewListQuerySchema },
  responses: {
    200: { description: "Reviews", content: { "application/json": { schema: successEnvelope(adminReviewPageSchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  const page = await listAdminReviews(c.get("db"), c.req.valid("query"));
  return ok(c, { items: page.items.map(presentReview), nextCursor: page.nextCursor });
});

app.openapi(createRoute({
  operationId: "dashboard.reviews.summary",
  method: "get",
  path: "/summary",
  tags: [TAG],
  summary: "Review counts per status, and one product's rating stats when asked",
  request: { query: z.object({ productId: z.string().trim().min(1).max(128).optional() }) },
  responses: {
    200: { description: "Counts", content: { "application/json": { schema: successEnvelope(adminReviewSummarySchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, await getAdminReviewSummary(c.get("db"), { productId: c.req.valid("query").productId }));
});

app.openapi(createRoute({
  operationId: "dashboard.reviews.settings_get",
  method: "get",
  path: "/settings",
  tags: [TAG],
  summary: "Review settings: on or off, moderation mode, review requests and block words",
  responses: {
    200: { description: "Settings", content: { "application/json": { schema: successEnvelope(reviewSettingsSchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, await getReviewSettingsForAdmin(c.get("db")));
});

app.openapi(createRoute({
  operationId: "dashboard.reviews.settings_update",
  method: "put",
  path: "/settings",
  tags: [TAG],
  summary: "Save review settings against the revision the editor loaded",
  request: { body: { required: true, content: { "application/json": { schema: reviewSettingsBodySchema } } } },
  responses: {
    200: { description: "Saved settings", content: { "application/json": { schema: successEnvelope(reviewSettingsSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const { expectedRevision, ...patch } = c.req.valid("json");
  const saved = await saveReviewSettings(c.get("db"), patch, expectedRevision);
  // Turning reviews on or off changes every product page and the store shape.

  return ok(c, saved);
});

app.openapi(createRoute({
  operationId: "dashboard.reviews.moderate",
  method: "post",
  path: "/moderate",
  tags: [TAG],
  summary: "Publish, reject (with a content reason) or restore up to 90 reviews",
  request: { body: { required: true, content: { "application/json": { schema: moderateReviewsBodySchema } } } },
  responses: {
    200: { description: "Moderated", content: { "application/json": { schema: successEnvelope(moderateReviewsResultSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const body = c.req.valid("json");
  const result = await moderateReviews(c.get("db"), { ids: body.ids, action: body.action, reason: body.reason });

  return ok(c, { updated: result.updated, skipped: result.skipped });
});

app.openapi(createRoute({
  operationId: "dashboard.reviews.get",
  method: "get",
  path: "/{id}",
  tags: [TAG],
  summary: "One review with its product, order, reply and reviewer thread",
  request: { params: reviewParam },
  responses: {
    200: { description: "Review", content: { "application/json": { schema: successEnvelope(adminReviewSchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, presentReview(await getAdminReview(c.get("db"), c.req.valid("param").id)));
});

app.openapi(createRoute({
  operationId: "dashboard.reviews.reply",
  method: "put",
  path: "/{id}/reply",
  tags: [TAG],
  summary: "Set or remove the store's public reply (guarded by the review version)",
  request: {
    params: reviewParam,
    body: { required: true, content: { "application/json": { schema: reviewReplyBodySchema } } },
  },
  responses: {
    200: { description: "The review", content: { "application/json": { schema: successEnvelope(adminReviewSchema) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const body = c.req.valid("json");
  const result = await setReviewReply(c.get("db"), {
    reviewId: c.req.valid("param").id,
    body: body.body,
    version: body.version,
    userId: staffUserId(c),
  });

  return ok(c, presentReview(result.review));
});

app.openapi(createRoute({
  operationId: "dashboard.reviews.conversation",
  method: "post",
  path: "/{id}/conversation",
  tags: [TAG],
  summary: "Open (or reuse) the private conversation with the reviewer",
  request: { params: reviewParam },
  responses: {
    201: { description: "The review's thread", content: { "application/json": { schema: successEnvelope(z.object({ conversationId: z.string() })) } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  staffUserId(c);
  return created(c, await openReviewThread(c.get("db"), c.req.valid("param").id));
});

export { app as adminReviewRoutes };
