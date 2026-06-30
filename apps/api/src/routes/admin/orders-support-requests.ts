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
    updateAdminOrderSupportRequestStatus,
} from "@scalius/core/modules/orders/order-support-requests";
import { enqueueOrderSupportRequestNotificationForOrder } from "../../utils/order-notification-queue";
import { ok } from "../../utils/api-response";
import {
    conflictResponse,
    errorResponses,
    successEnvelope,
} from "../../schemas/responses";
import { orderSupportRequestSchema } from "../../schemas/entities";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;

const updateSupportRequestStatusBodySchema = z.object({
    status: z.enum(ADMIN_ORDER_SUPPORT_REQUEST_STATUSES),
    note: z.string().max(1000).nullable().optional(),
});

const updateSupportRequestStatusRoute = createRoute({
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
    const result = await updateAdminOrderSupportRequestStatus(db, orderId, requestId, {
        status: body.status,
        note: body.note ?? null,
        actorId: user?.id ?? null,
    });
    if (result.statusChanged) {
        await enqueueOrderSupportRequestNotificationForOrder({
            db,
            queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
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

app.openapi(updateSupportRequestStatusRoute, updateSupportRequestStatusHandler);

export { app as adminOrdersSupportRequestRoutes };
