import {
    OpenAPIHono,
    createRoute,
    z,
    type RouteConfig,
    type RouteHandler,
} from "@hono/zod-openapi";
import {
    ADMIN_ORDER_SUPPORT_REQUEST_STATUSES,
    getOrderSupportRequestStatusLabel,
    createOrderReturn,
    createOrderReturnSchema,
    listOrderReturns,
    listOrderSupportRequests,
    recordOrderEvent,
    updateOrderStatus,
} from "@scalius/core/modules/orders";
import { updateAdminOrderSupportRequestStatus } from "@scalius/core/modules/conversations";
import { orders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import {
    enqueueOrderNotificationMessage,
    enqueueOrderSupportRequestNotificationForOrder,
} from "../../utils/order-notification-queue";

import { ok } from "../../utils/api-response";
import {
    conflictResponse,
    errorResponses,
    successEnvelope,
} from "../../schemas/responses";
import { orderSupportRequestSchema } from "../../schemas/entities";
import { ForbiddenError, NotFoundError, ValidationError } from "../../utils/api-error";
import { hasPermission } from "@scalius/core/auth/rbac/helpers";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;

const updateSupportRequestStatusBodySchema = z.object({
    status: z.enum(ADMIN_ORDER_SUPPORT_REQUEST_STATUSES),
    note: z.string().max(1000).nullable().optional(),
    /** Required when approving an unlinked buyer return request. */
    returnRequest: createOrderReturnSchema.optional(),
});

const updateSupportRequestStatusRoute = createRoute({
    operationId: "dashboard.orders.support_request_update",
    method: "put",
    path: "/{id}/support-requests/{requestId}/status",
    tags: ["Admin - Orders"],
    summary: "Update an order support request status",
    request: {
        params: z.object({
            id: z.string(),
            requestId: z.string(),
        }),
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: updateSupportRequestStatusBodySchema,
                },
            },
        },
    },
    responses: {
        200: {
            description: "Support request updated",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        request: orderSupportRequestSchema,
                        supportRequests: z.array(orderSupportRequestSchema),
                    })),
                },
            },
        },
        409: conflictResponse,
        ...errorResponses,
    },
});

const updateSupportRequestStatusHandler: AdminRouteHandler<
    typeof updateSupportRequestStatusRoute
> = async (c) => {
    const db = c.get("db");
    const { id: orderId, requestId } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("user") as { id?: string } | undefined;
    let linkedReturnId: string | null = null;
    let targetStatus = body.status;
    // Accepting a cancellation sends the buyer one "Order cancelled" message,
    // not that plus a request update (R2-ORD-08).
    let cancelledForRequest = false;
    if (body.status === "approved") {
        const supportRequest = (await listOrderSupportRequests(db, orderId)).find(
            (request) => request.id === requestId,
        );
        if (!supportRequest) {
            throw new NotFoundError("Support request not found");
        }
        if (supportRequest.type === "cancel_pre_shipment" && supportRequest.active) {
            // Accepting a cancellation request cancels the order: stock goes
            // back and the customer is told. If it can't be cancelled (money
            // was paid, or it already shipped) the request stays open (ORD-08).
            await cancelOrderForRequest(c, orderId, user?.id ?? null);
            targetStatus = "completed";
            cancelledForRequest = true;
        }
        if (supportRequest.type === "return") {
            linkedReturnId = supportRequest.returnId
                ?? (await listOrderReturns(db, orderId)).find(
                    (candidate) => candidate.source === "support_request"
                        && candidate.sourceReferenceId === requestId,
                )?.id
                ?? null;
            if (!linkedReturnId) {
                if (!body.returnRequest) {
                    throw new ValidationError(
                        "Approving a return request requires item quantities and an idempotency command key.",
                    );
                }
                const createdReturn = await createOrderReturn(
                    db,
                    orderId,
                    body.returnRequest,
                    { type: "admin", id: user?.id ?? null },
                    { source: "support_request", sourceReferenceId: requestId },
                );
                linkedReturnId = createdReturn.returnId;
            }
        }
    }
    const result = await updateAdminOrderSupportRequestStatus(db, orderId, requestId, {
        status: targetStatus,
        note: body.note ?? null,
        actorId: user?.id ?? null,
        returnId: linkedReturnId,
    });
    if (result.statusChanged) {
        await recordOrderEvent(db, {
            orderId,
            kind: "request_resolved",
            actorId: user?.id ?? null,
            body: body.note?.trim() || null,
            data: { type: result.request.type, status: result.newStatus },
        });
    }
    if (result.statusChanged && !cancelledForRequest) {
        await enqueueOrderSupportRequestNotificationForOrder({
            db,
            queue: c.env.JOBS_QUEUE,
            orderId,
            requestId: result.request.id,
            notificationType: "support_request_status_updated",
            source: "admin-support-request-status",
            status: result.newStatus,
            data: {
                supportRequestType: result.request.type,
                supportRequestTypeLabel: result.request.label,
                supportRequestStatus: result.newStatus,
                supportRequestStatusLabel: getOrderSupportRequestStatusLabel(result.newStatus),
                previousSupportRequestStatus: result.previousStatus,
            },
        });
    }

    return ok(c, {
        request: result.request,
        supportRequests: result.supportRequests,
    });
};

async function cancelOrderForRequest(
    c: Parameters<typeof updateSupportRequestStatusHandler>[0],
    orderId: string,
    actorId: string | null,
): Promise<void> {
    const db = c.get("db");
    // Accepting cancels the order, so it needs the same right as cancelling.
    if (!actorId || !await hasPermission(db, actorId, PERMISSIONS.ORDERS_CHANGE_STATUS, c.env.CACHE)) {
        throw new ForbiddenError("You don't have permission to cancel orders.");
    }
    const before = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId)).get();
    if (!before) throw new NotFoundError("Order not found");
    if (before.status === "cancelled") return;
    if (!["incomplete", "pending", "processing", "confirmed"].includes(before.status)) {
        throw new ValidationError("This order was already sent, so it can't be cancelled. Reject the request or start a return.");
    }
    const result = await updateOrderStatus(db, orderId, "cancelled");

    await recordOrderEvent(db, {
        orderId,
        kind: "status_changed",
        actorId,
        data: { from: before.status, to: "cancelled", reason: "customer_request" },
    });
    if (result.notification) {
        await enqueueOrderNotificationMessage({
            db,
            queue: c.env.JOBS_QUEUE,
            message: {
                type: "order.notification",
                orderId: result.notification.orderId,
                customerEmail: result.notification.customerEmail,
                customerName: result.notification.customerName,
                notificationType: result.notification.notificationType,
            },
            dedupeKey: result.notification.dedupeKey ?? `order_status:${orderId}:${result.notification.notificationType}`,
            source: "orders-support-request-cancel",
        });
    }
}

app.openapi(updateSupportRequestStatusRoute, updateSupportRequestStatusHandler);

export { app as adminOrdersSupportRequestRoutes };
