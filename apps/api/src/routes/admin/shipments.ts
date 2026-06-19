// src/server/routes/admin/shipments.ts
import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { getShipment, deleteShipmentRecord, checkShipmentStatus } from "@scalius/core/modules/delivery/delivery.service";
import { updateOrderStatusFromShipment } from "@scalius/core/modules/delivery/tracking";
import { deliveryShipments } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../utils/api-error";

import { ok } from "../../utils/api-response";
import { getEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope, messageResponse, errorResponses } from "../../schemas/responses";
import { deliveryShipmentSchema } from "../../schemas/entities";
import { invalidateProductAvailabilityCaches } from "../../utils/cache-invalidation";
import { enqueueOrderStatusChangeNotification } from "../../utils/order-notification-queue";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

// ─── Inline schemas ──

const statusCheckSchema = z.object({
    status: z.string(),
    statusChanged: z.boolean(),
    orderStatusUpdate: z.object({ status: z.string() }).passthrough().nullable(),
    lastChecked: z.string(),
}).passthrough();

const checkStatusResponseSchema = successEnvelope(z.object({
    message: z.string(),
    statusCheck: statusCheckSchema,
}));

// ─── GET /:id ────────────────────────────────────────────────────────────────

const getShipmentRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Shipments"],
    summary: "Get shipment by ID",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Shipment details",
            content: { "application/json": { schema: successEnvelope(deliveryShipmentSchema) } },
        },
        404: errorResponses[404],
    }
});

app.openapi(getShipmentRoute, async (c) => {
    const db = c.get("db");
    const shipmentId = c.req.valid("param").id;
    const shipment = await getShipment(db, shipmentId);

    if (!shipment) {
        throw new NotFoundError("Shipment not found");
    }
    return ok(c, shipment);
});

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

const deleteShipmentRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Shipments"],
    summary: "Delete a shipment",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Shipment deleted",
            content: { "application/json": { schema: messageResponse } },
        },
        404: errorResponses[404],
    }
});

app.openapi(deleteShipmentRoute, async (c) => {
    const db = c.get("db");
    const shipmentId = c.req.valid("param").id;
    const shipment = await getShipment(db, shipmentId);

    if (!shipment) {
        throw new NotFoundError("Shipment not found");
    }

    await deleteShipmentRecord(db, shipmentId);
    return ok(c, { message: "Shipment deleted successfully" });
});

// ─── POST /:id/check-status ─────────────────────────────────────────────────

const checkStatusRoute = createRoute({
    method: "post",
    path: "/{id}/check-status",
    tags: ["Admin - Shipments"],
    summary: "Check and update shipment status from provider",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Status checked",
            content: { "application/json": { schema: checkStatusResponseSchema } },
        },
        404: errorResponses[404],
    }
});

app.openapi(checkStatusRoute, (async (c: AdminRouteContext<typeof checkStatusRoute>) => {
    const db = c.get("db");
    const shipmentId = c.req.valid("param").id;

    const [currentShipment] = await db
        .select()
        .from(deliveryShipments)
        .where(eq(deliveryShipments.id, shipmentId));

    if (!currentShipment) {
        throw new NotFoundError(`Shipment with ID ${shipmentId} not found`);
    }

    const previousStatus = currentShipment.status;
    const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
    const result = await checkShipmentStatus(db, shipmentId, encryptionKey);
    const now = new Date();

    await db
        .update(deliveryShipments)
        .set({ lastChecked: now })
        .where(eq(deliveryShipments.id, shipmentId));

    const orderStatusUpdate = await updateOrderStatusFromShipment(
        db,
        shipmentId,
        result.status,
    );
    await invalidateProductAvailabilityCaches(db, { orderIds: [currentShipment.orderId] }, c);

    await enqueueOrderStatusChangeNotification({
        db,
        queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
        statusChange: orderStatusUpdate,
        trackingId: result.trackingId ?? currentShipment.trackingId,
        source: "shipments",
    });

    if (result.status !== previousStatus) {
        return ok(c, {
            message: `Shipment status updated from ${previousStatus} to ${result.status}`,
            statusCheck: {
                ...result,
                statusChanged: true,
                orderStatusUpdate: orderStatusUpdate || "No change needed",
                lastChecked: now.toISOString()
            }
        });
    }

    return ok(c, {
        message: "Shipment status checked successfully",
        statusCheck: {
            ...result,
            statusChanged: false,
            lastChecked: now.toISOString()
        }
    });
}) as unknown as AdminRouteHandler<typeof checkStatusRoute>);

export { app as adminShipmentRoutes };
