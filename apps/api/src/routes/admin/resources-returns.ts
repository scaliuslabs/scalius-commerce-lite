// Item returns in the stable app API (operation-registry/README.md), mounted
// at /admin/resources: the dashboard's return commands (orders-returns.ts,
// `runCreateOrderReturn` and the rest: core command, timeline line and
// customer notification) for an RMA app. A return is requested for an
// order's lines, approved (or rejected) per line, received (restocked or
// written off per line, to a location the app names or where the units were
// sent from) and cancelled before receipt. Every write answers `{ return }`,
// the representation `return.*` webhooks carry, under the revision it was
// based on (`expectedRevision`: the order's for a request, the return's after),
// and needs the Idempotency-Key header: the return command's own durable key
// is derived from it, so a repeat never acts twice.
import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "./admin-router";
import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { orderReturns } from "@scalius/database/schema";
import {
  approveOrderReturnSchema,
  cancelOrderReturnSchema,
  createOrderReturnSchema,
  receiveOrderReturnSchema,
} from "@scalius/core/modules/orders";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { created, ok } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";
import { conflictResponse, errorResponses, namedSharedSchema, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { readReturnRepresentation } from "../../events/representations";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";
import {
  runApproveOrderReturn,
  runCancelOrderReturn,
  runCreateOrderReturn,
  runReceiveOrderReturn,
  type ReturnCommandContext,
} from "./orders-returns";

const app = adminRouter();

const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
};
app.use("*", noStore);

const ReturnResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.return, "ReturnResource");
const idParam = z.object({ id: z.string().min(1).max(128) });
const returnEnvelope = successEnvelope(z.object({ return: ReturnResource }));
const writeResponses = { ...errorResponses, 409: conflictResponse, 503: serviceUnavailableResponse };

const returnHeaders = z.object({
  "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
    description: "Required: one key makes one return command; a repeat returns the first result.",
  }),
});

const returnRevision = z.number().int().min(1).openapi({
  description: "The return's `revision` you read; a return changed since is refused with 409 and nothing changes.",
});

const createBody = createOrderReturnSchema.omit({ commandKey: true, expectedOrderVersion: true }).extend({
  expectedRevision: z.number().int().min(1).openapi({
    description: "The order's `revision` you read; an order changed since is refused with 409 and nothing changes.",
  }),
}).strict();
const approveBody = approveOrderReturnSchema.omit({ commandKey: true, expectedVersion: true }).extend({ expectedRevision: returnRevision }).strict();
const receiveBody = receiveOrderReturnSchema.omit({ commandKey: true, expectedVersion: true }).extend({ expectedRevision: returnRevision }).strict();
const cancelBody = cancelOrderReturnSchema.omit({ commandKey: true, expectedVersion: true }).extend({ expectedRevision: returnRevision }).strict();

/** The return command's durable key for this caller's Idempotency-Key (52 characters, within the command key's 8 to 200). */
function commandKey(c: Context, operationId: string): Promise<string> {
  return scopedRequestKey(c, operationId, c.req.header("Idempotency-Key"));
}

async function returnAnswer(c: Context, returnId: string) {
  const found = await readReturnRepresentation(c.get("db"), returnId);
  if (!found) throw new NotFoundError("Return not found");
  return found;
}

/** The order a return belongs to (the commands run per order). */
async function returnOrderId(c: Context, returnId: string): Promise<string> {
  const row = await c.get("db").select({ orderId: orderReturns.orderId }).from(orderReturns).where(eq(orderReturns.id, returnId)).get();
  if (!row) throw new NotFoundError("Return not found");
  return row.orderId;
}

app.openapi(createRoute({
  operationId: "dashboard.resources.returns.create",
  method: "post",
  path: "/orders/{id}/returns",
  tags: ["App API - Orders"],
  summary: "Request an item return",
  description: "Requests the return of a delivered order's lines (`orderItemId` and quantity, at most what is still returnable) with a reason. No stock moves until the return is received. The order timeline records it. Send the order's `revision` as expectedRevision and an Idempotency-Key: a repeat returns the first return.",
  request: {
    params: idParam,
    headers: returnHeaders,
    body: { required: true, content: { "application/json": { schema: createBody } } },
  },
  responses: {
    201: { description: "The return, requested", content: { "application/json": { schema: returnEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const { expectedRevision, ...body } = c.req.valid("json");
  const result = await runCreateOrderReturn(c as unknown as ReturnCommandContext, c.req.valid("param").id, {
    ...body,
    expectedOrderVersion: expectedRevision,
    commandKey: await commandKey(c, "dashboard.resources.returns.create"),
  });
  return created(c, { return: await returnAnswer(c, result.returnId) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.returns.approve",
  method: "post",
  path: "/returns/{id}/approve",
  tags: ["App API - Orders"],
  summary: "Approve or reject an item return",
  description: "Decides every line of a requested return: its approved and rejected units add up to the units requested. A return with no unit approved is rejected. The customer is told once that it was approved and to send the items. Send the return's `revision` as expectedRevision and an Idempotency-Key.",
  request: {
    params: idParam,
    headers: returnHeaders,
    body: { required: true, content: { "application/json": { schema: approveBody } } },
  },
  responses: {
    200: { description: "The return, decided", content: { "application/json": { schema: returnEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const returnId = c.req.valid("param").id;
  const { expectedRevision, ...body } = c.req.valid("json");
  await runApproveOrderReturn(c as unknown as ReturnCommandContext, await returnOrderId(c, returnId), returnId, {
    ...body,
    expectedVersion: expectedRevision,
    commandKey: await commandKey(c, "dashboard.resources.returns.approve"),
  });
  return ok(c, { return: await returnAnswer(c, returnId) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.returns.receive",
  method: "post",
  path: "/returns/{id}/receive",
  tags: ["App API - Orders"],
  summary: "Receive returned items",
  description: "Records units of an approved return arriving back, per line: how many were received, restocked and written off as damaged (a tracked item's received units are each restocked or damaged). Restocked units go to `restockLocationId` (an active location) or, omitted, back to where they were sent from, through the stock ledger. The customer is told once that they arrived; a return that brings the whole order back marks it returned. Send the return's `revision` as expectedRevision and an Idempotency-Key.",
  request: {
    params: idParam,
    headers: returnHeaders,
    body: { required: true, content: { "application/json": { schema: receiveBody } } },
  },
  responses: {
    200: { description: "The return, received", content: { "application/json": { schema: returnEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const returnId = c.req.valid("param").id;
  const { expectedRevision, ...body } = c.req.valid("json");
  await runReceiveOrderReturn(c as unknown as ReturnCommandContext, await returnOrderId(c, returnId), returnId, {
    ...body,
    expectedVersion: expectedRevision,
    commandKey: await commandKey(c, "dashboard.resources.returns.receive"),
  });
  return ok(c, { return: await returnAnswer(c, returnId) });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.returns.cancel",
  method: "post",
  path: "/returns/{id}/cancel",
  tags: ["App API - Orders"],
  summary: "Cancel an item return",
  description: "Cancels a return before any unit is received; no stock moves. Send the return's `revision` as expectedRevision and an Idempotency-Key.",
  request: {
    params: idParam,
    headers: returnHeaders,
    body: { required: true, content: { "application/json": { schema: cancelBody } } },
  },
  responses: {
    200: { description: "The return, cancelled", content: { "application/json": { schema: returnEnvelope } } },
    ...writeResponses,
  },
}), async (c) => {
  const returnId = c.req.valid("param").id;
  const { expectedRevision, ...body } = c.req.valid("json");
  await runCancelOrderReturn(c as unknown as ReturnCommandContext, await returnOrderId(c, returnId), returnId, {
    ...body,
    expectedVersion: expectedRevision,
    commandKey: await commandKey(c, "dashboard.resources.returns.cancel"),
  });
  return ok(c, { return: await returnAnswer(c, returnId) });
});

export { app as adminResourceReturnRoutes };
