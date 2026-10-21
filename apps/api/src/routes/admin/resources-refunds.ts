// Refunds in the stable app API (operation-registry/README.md), mounted at
// /admin/resources: the dashboard's refund command (orders-refund.ts,
// `executeOrderRefund`) in integer minor units of the order's currency, with
// the order lines it is for. A refund is a record (`order_refunds`, 0172):
// `refund.created` when it is claimed and `refund.updated` when it settles,
// both carrying its lines, so a marketplace splitter or a subscription app
// knows whose lines the money was for. An app needs the Sensitive
// `write_refunds`; the money goes back through the payments it came from
// (or one store-credit gift card), never anywhere the app names.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { orders } from "@scalius/database/schema";
import { EVENT_REPRESENTATION_SCHEMAS } from "@scalius/shared/events";
import { eq } from "drizzle-orm";
import { created, ok } from "../../utils/api-response";
import { NotFoundError } from "../../utils/api-error";
import { conflictResponse, errorResponses, namedSharedSchema, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { readOrderRefundRepresentations, readRefundRepresentation } from "../../events/representations";
import { executeOrderRefund, refundLinesSchema } from "./orders-refund";
import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";
import { boundedPage, boundedPageQuery, nextCursorSchema } from "../../utils/bounded-page";

/** An order's refunds per page (and by default): an order's refunds are few. */
const REFUNDS_PAGE_BOUND = 100;

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

const RefundResource = namedSharedSchema(EVENT_REPRESENTATION_SCHEMAS.refund, "RefundResource");
const idParam = z.object({ id: z.string().min(1).max(128) });
const readResponses = { 400: errorResponses[400], 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404], 429: errorResponses[429], 500: errorResponses[500] };

const refundHeaders = z.object({
  "idempotency-key": idempotencyKeyHeaderSchema.shape["idempotency-key"].unwrap().openapi({
    description: "Required: one key makes one refund; a repeat returns the first.",
  }),
});

const refundCreateBody = z.object({
  amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).openapi({
    description: "What goes back, in minor units of the order's `currency`; at most what was paid less what was refunded.",
  }),
  lines: refundLinesSchema.optional(),
  reason: z.string().trim().min(1).max(300).openapi({ description: "Why, for the order timeline (staff read it)." }),
  settlement: z.enum(["original", "store_credit"]).default("original").openapi({
    description: "`original`: back to the payments it came from. `store_credit`: one new gift card for the whole amount, sent to the order contact. An app or agent may give store credit only for money a provider captured (or gift-card value); over a cash-on-delivery or recorded payment it is refused with reason `store_credit_needs_staff`.",
  }),
  gateway: z.string().trim().min(1).max(160).optional().openapi({
    description: "Refund only payments taken by this method (`cod`, a gateway id or an app provider's `<plugin id>:<provider id>`).",
  }),
  manualSettlementConfirmed: z.boolean().optional().openapi({
    description: "Required true when part of it goes back to a cash-on-delivery or recorded payment: the buyer already got that money by hand.",
  }),
}).strict();

app.openapi(createRoute({
  operationId: "dashboard.resources.refunds.create",
  method: "post",
  path: "/orders/{id}/refunds",
  tags: ["App API - Orders"],
  summary: "Refund an order",
  description: "Gives money back on an order, through the payments it came from (or as one store-credit gift card), and records the order lines it is for. The refund is claimed before any provider is called: a repeat with the same Idempotency-Key returns the first refund, and a provider whose answer is unknown leaves it pending for reconciliation instead of refunding twice. `refund.created` and `refund.updated` carry its lines; `order.refunded` reports each payment it settles.",
  request: {
    params: idParam,
    headers: refundHeaders,
    body: { required: true, content: { "application/json": { schema: refundCreateBody } } },
  },
  responses: {
    201: { description: "The refund", content: { "application/json": { schema: successEnvelope(z.object({ refund: RefundResource })) } } },
    ...errorResponses,
    409: conflictResponse,
    503: serviceUnavailableResponse,
  },
}), async (c) => {
  const orderId = c.req.valid("param").id;
  const body = c.req.valid("json");
  const appPrincipal = c.get("pluginPrincipal");
  const user = c.get("user") as { id?: string } | undefined;
  const { result } = await executeOrderRefund(c, {
    orderId,
    amountMinor: body.amountMinor,
    reason: body.reason,
    settlement: body.settlement,
    ...(body.gateway ? { gateway: body.gateway } : {}),
    ...(body.manualSettlementConfirmed !== undefined ? { manualSettlementConfirmed: body.manualSettlementConfirmed } : {}),
    ...(body.lines ? { lines: body.lines } : {}),
    requestKey: await scopedRequestKey(c, "dashboard.resources.refunds.create", c.req.valid("header")["idempotency-key"]),
    actorUserId: appPrincipal ? null : user?.id ?? null,
  });
  const refund = result.orderRefundId ? await readRefundRepresentation(c.get("db"), result.orderRefundId) : null;
  if (!refund) throw new NotFoundError("Refund not found");
  return created(c, { refund });
});

app.openapi(createRoute({
  operationId: "dashboard.resources.refunds.list",
  method: "get",
  path: "/orders/{id}/refunds",
  tags: ["App API - Orders"],
  summary: "List an order's refunds",
  description: "Every refund made on the order with a refund command, oldest first: its money in integer minor units of `currency`, its status, the order lines it is for and the refund payments it became.",
  request: { params: idParam, query: z.object(boundedPageQuery(REFUNDS_PAGE_BOUND)) },
  responses: {
    200: { description: "The refunds", content: { "application/json": { schema: successEnvelope(z.object({ refunds: z.array(RefundResource), nextCursor: nextCursorSchema })) } } },
    ...readResponses,
  },
}), async (c) => {
  const orderId = c.req.valid("param").id;
  const db = c.get("db");
  const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new NotFoundError("Order not found");
  const query = c.req.valid("query");
  const page = boundedPage(await readOrderRefundRepresentations(db, orderId), {
    name: "refunds",
    cursor: query.cursor,
    limit: query.limit,
    id: (refund) => refund.id,
    sort: { kind: "text", value: (refund) => refund.createdAt },
  });
  return ok(c, { refunds: page.items, nextCursor: page.nextCursor });
});

export { app as adminResourceRefundRoutes };
