// Guest support requests on a receipt: a case on the order's conversation.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createReceiptOrderSupportRequest } from "@scalius/core/modules/conversations";
import {
  CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES,
  getOrderSupportRequestStatusLabel,
} from "@scalius/core/modules/orders";
import { enforceBuyerWriteLimits } from "../../utils/conversation-http";
import { validateReceiptToken } from "../../utils/order-receipt-token";
import { created } from "../../utils/api-response";
import { successEnvelope, errorResponses, conflictResponse, serviceUnavailableResponse } from "../../schemas/responses";
import { enqueueOrderSupportRequestNotificationForOrder } from "../../utils/order-notification-queue";
import { receiptSupportRequestSchema, receiptSupportRequestActionSchema } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

const receiptSupportRequestResponseSchema = z.object({
  request: receiptSupportRequestSchema,
  supportRequests: z.array(receiptSupportRequestSchema),
  supportRequestActions: z.array(receiptSupportRequestActionSchema),
  supportRequestIntro: z.string(),
  /** The order thread the case was recorded on. */
  conversationId: z.string(),
});

const createReceiptSupportRequestRoute = createRoute({
  method: "post",
  path: "/receipt/{id}/support-requests",
  tags: ["Orders"],
  summary: "Create a receipt-token support request for an order",
  request: {
    params: z.object({
      id: z.string(),
    }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            token: z.string(),
            type: z.enum(CUSTOMER_ORDER_SUPPORT_REQUEST_TYPES),
            reason: z.string().trim().min(3).max(500),
            message: z.string().trim().max(1000).nullable().optional(),
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Receipt support request created",
      content: {
        "application/json": {
          schema: successEnvelope(receiptSupportRequestResponseSchema),
        },
      },
    },
    409: conflictResponse,
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

app.openapi(createReceiptSupportRequestRoute, async (c) => {
  const db = c.get("db");
  const id = c.req.valid("param").id;
  const body = c.req.valid("json");

  c.header("Cache-Control", "no-cache, no-store, must-revalidate");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");

  await validateReceiptToken(c.env.CACHE, id, body.token, db);
  await enforceBuyerWriteLimits(c, "support-request", { orderId: id });
  const result = await createReceiptOrderSupportRequest(db, id, {
    type: body.type,
    reason: body.reason,
    message: body.message,
  });
  await enqueueOrderSupportRequestNotificationForOrder({
    db,
    queue: c.env.JOBS_QUEUE,
    orderId: id,
    requestId: result.request.id,
    notificationType: "support_request_submitted",
    source: "receipt-support-request",
    status: result.request.status,
    data: {
      supportRequestType: result.request.type,
      supportRequestTypeLabel: result.request.label,
      supportRequestStatus: result.request.status,
      supportRequestStatusLabel: getOrderSupportRequestStatusLabel(result.request.status),
    },
  });

  return created(c, result);
});

export { app as receiptSupportRequestRoutes };
