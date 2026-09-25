// Guest review routes under /orders/receipt/{id}/reviews (Wave B §7.1). The
// receipt proof travels in the X-Receipt-Token header only (the storefront
// keeps it in an HttpOnly cookie and adds the header server-side), never the
// URL. A guest reviews the lines of the receipt's own order. Mounted by
// ./index.ts.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ReviewBuyer } from "@scalius/core/modules/reviews";
import { created, ok } from "../../utils/api-response";
import { conflictResponse, errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import {
  buyerReviewsResponseSchema,
  editReviewBodySchema,
  reviewWriteResponseSchema,
  submitReviewBodySchema,
} from "../../schemas/reviews";
import { patchBuyerReview, readBuyerReviewsResponse, submitBuyerReview } from "../shared/review-http";
import { validateReceiptToken } from "../../utils/order-receipt-token";

const app = new OpenAPIHono<{ Bindings: Env }>();

const RECEIPT_TOKEN_HEADER = "X-Receipt-Token";
const orderIdParam = z.object({ id: z.string().trim().min(1).max(128) });
const receiptHeaders = z.object({ "x-receipt-token": z.string().optional() });
const writeResponses = { ...errorResponses, 409: conflictResponse, 503: serviceUnavailableResponse };
const writeEnvelope = successEnvelope(reviewWriteResponseSchema);

function noStore(c: Context) {
  c.header("Cache-Control", "private, no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
}

/** Validates the receipt proof for this order and returns the guest buyer. */
async function receiptBuyer(c: Context<{ Bindings: Env }>, orderId: string): Promise<ReviewBuyer> {
  const token = c.req.header(RECEIPT_TOKEN_HEADER)?.trim() || undefined;
  await validateReceiptToken(c.env.CACHE, orderId, token, c.get("db"));
  return { kind: "guest_receipt", orderId };
}

app.openapi(createRoute({
  method: "get",
  path: "/receipt/{id}/reviews",
  tags: ["Orders"],
  summary: "The order's delivered items waiting for a review, and their reviews (receipt proof in a header)",
  request: { params: orderIdParam, headers: receiptHeaders },
  responses: {
    200: { description: "Reviews", content: { "application/json": { schema: successEnvelope(buyerReviewsResponseSchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  noStore(c);
  return ok(c, await readBuyerReviewsResponse(c, await receiptBuyer(c, c.req.valid("param").id)));
});

app.openapi(createRoute({
  method: "post",
  path: "/receipt/{id}/reviews",
  tags: ["Orders"],
  summary: "Review a delivered item of the order (receipt proof in a header)",
  request: {
    params: orderIdParam,
    headers: receiptHeaders,
    body: { required: true, content: { "application/json": { schema: submitReviewBodySchema } } },
  },
  responses: {
    200: { description: "This line already had its review (idempotent retry)", content: { "application/json": { schema: writeEnvelope } } },
    201: { description: "Review submitted", content: { "application/json": { schema: writeEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const buyer = await receiptBuyer(c, c.req.valid("param").id);
  const result = await submitBuyerReview(c, buyer, c.req.valid("json"));
  return result.created ? created(c, result) : ok(c, result);
});

app.openapi(createRoute({
  method: "patch",
  path: "/receipt/{id}/reviews/{reviewId}",
  tags: ["Orders"],
  summary: "Edit or withdraw a review of the order (receipt proof in a header)",
  request: {
    params: orderIdParam.extend({ reviewId: z.string().trim().min(1).max(80) }),
    headers: receiptHeaders,
    body: { required: true, content: { "application/json": { schema: editReviewBodySchema } } },
  },
  responses: {
    200: { description: "The review", content: { "application/json": { schema: writeEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  noStore(c);
  const params = c.req.valid("param");
  const buyer = await receiptBuyer(c, params.id);
  return ok(c, await patchBuyerReview(c, buyer, params.reviewId, c.req.valid("json")));
});

export { app as receiptReviewRoutes };
