// src/server/routes/admin/shipments.ts
import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { getShipment, deleteShipmentRecord } from "@scalius/core/modules/delivery/delivery.service";
import { NotFoundError } from "../../utils/api-error";

import { ok } from "../../utils/api-response";
import { getEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope, messageResponse, errorResponses } from "../../schemas/responses";
import { deliveryShipmentSchema } from "../../schemas/entities";
import { checkAndSyncShipmentStatus } from "./shipment-status-sync";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

// ─── Inline schemas ──

const statusCheckSchema = deliveryShipmentSchema.extend({
    providerName: z.string().nullable(),
    providerType: z.string().nullable(),
    lastChecked: z.string(),
    statusChanged: z.boolean(),
    orderStatusUpdate: z.boolean(),
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

    const currentShipment = await getShipment(db, shipmentId);

    if (!currentShipment) {
        throw new NotFoundError(`Shipment with ID ${shipmentId} not found`);
    }

    const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
    const result = await checkAndSyncShipmentStatus({
        db,
        shipment: currentShipment,
        encryptionKey,
        c,
        source: "shipments",
    });

    if (result.payload.statusChanged) {
        return ok(c, {
            message: `Shipment status updated from ${result.previousStatus} to ${result.payload.status}`,
            statusCheck: result.payload,
        });
    }

    return ok(c, {
        message: "Shipment status checked successfully",
        statusCheck: result.payload,
    });
}) as unknown as AdminRouteHandler<typeof checkStatusRoute>);

export { app as adminShipmentRoutes };
