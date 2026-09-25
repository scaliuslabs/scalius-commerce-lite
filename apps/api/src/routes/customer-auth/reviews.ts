// Signed-in buyer review routes (Wave B design §7.1): the account's lines to
// review and its reviews, submit, and edit or withdraw. Mounted by ./index.ts.
// Only lines of orders the account owns; every write passes both limiters.
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
import { UnauthorizedError } from "../../utils/api-error";
import { requireCustomerSession, setPrivateNoStoreHeaders } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const writeResponses = { ...errorResponses, 409: conflictResponse, 503: serviceUnavailableResponse };
const writeEnvelope = successEnvelope(reviewWriteResponseSchema);

async function customerBuyer(c: Context<{ Bindings: Env }>): Promise<ReviewBuyer> {
  const { session } = await requireCustomerSession(c);
  if (!session.customerId) throw new UnauthorizedError("Customer profile is incomplete. Please log in again.");
  return { kind: "customer", customerId: session.customerId };
}

app.openapi(createRoute({
  method: "get",
  path: "/reviews",
  tags: ["Customer Auth"],
  summary: "The account's delivered items waiting for a review, and its reviews",
  responses: {
    200: { description: "Reviews", content: { "application/json": { schema: successEnvelope(buyerReviewsResponseSchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  return ok(c, await readBuyerReviewsResponse(c, await customerBuyer(c)));
});

app.openapi(createRoute({
  method: "post",
  path: "/reviews",
  tags: ["Customer Auth"],
  summary: "Review a delivered item (one review per product; a repeat purchase edits it)",
  request: { body: { required: true, content: { "application/json": { schema: submitReviewBodySchema } } } },
  responses: {
    200: { description: "This line already had its review (idempotent retry)", content: { "application/json": { schema: writeEnvelope } } },
    201: { description: "Review submitted", content: { "application/json": { schema: writeEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  const result = await submitBuyerReview(c, await customerBuyer(c), c.req.valid("json"));
  return result.created ? created(c, result) : ok(c, result);
});

app.openapi(createRoute({
  method: "patch",
  path: "/reviews/{id}",
  tags: ["Customer Auth"],
  summary: "Edit or withdraw one of the account's reviews (guarded by its version)",
  request: {
    params: z.object({ id: z.string().trim().min(1).max(80) }),
    body: { required: true, content: { "application/json": { schema: editReviewBodySchema } } },
  },
  responses: {
    200: { description: "The review", content: { "application/json": { schema: writeEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  setPrivateNoStoreHeaders(c);
  return ok(c, await patchBuyerReview(c, await customerBuyer(c), c.req.valid("param").id, c.req.valid("json")));
});

export { app as customerReviewRoutes };
