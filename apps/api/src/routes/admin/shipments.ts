// src/server/routes/admin/shipments.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { DeliveryService } from "@scalius/core/modules/delivery/service";
import { ShipmentTracker } from "@scalius/core/modules/delivery/tracking";
import { deliveryShipments } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../utils/api-error";

const app = new OpenAPIHono<{ Bindings: any }>();
const deliveryService = new DeliveryService();

// ─── GET /:id ────────────────────────────────────────────────────────────────

const getShipmentRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Shipments"],
    summary: "Get shipment by ID",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Shipment ID" }) }),
    },
    responses: {
        200: { description: "Shipment details", content: { "application/json": { schema: z.any() } } },
        404: { description: "Shipment not found", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getShipmentRoute, async (c) => {
    const shipmentId = c.req.valid("param").id;
    const shipment = await deliveryService.getShipment(shipmentId);

    if (!shipment) {
        throw new NotFoundError("Shipment not found");
    }
    return c.json(shipment, 200);
});

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

const deleteShipmentRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Shipments"],
    summary: "Delete a shipment",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Shipment ID" }) }),
    },
    responses: {
        200: { description: "Shipment deleted", content: { "application/json": { schema: z.any() } } },
        404: { description: "Shipment not found", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(deleteShipmentRoute, async (c) => {
    const shipmentId = c.req.valid("param").id;
    const shipment = await deliveryService.getShipment(shipmentId);

    if (!shipment) {
        throw new NotFoundError("Shipment not found");
    }

    await deliveryService.deleteShipment(shipmentId);
    return c.json({ success: true, message: "Shipment deleted successfully" }, 200);
});

// ─── POST /:id/check-status ─────────────────────────────────────────────────

const checkStatusRoute = createRoute({
    method: "post",
    path: "/{id}/check-status",
    tags: ["Admin - Shipments"],
    summary: "Check and update shipment status from provider",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Shipment ID" }) }),
    },
    responses: {
        200: { description: "Status checked", content: { "application/json": { schema: z.any() } } },
        404: { description: "Shipment not found", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(checkStatusRoute, async (c) => {
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
    const result = await deliveryService.checkShipmentStatus(shipmentId);
    const now = new Date();

    await db
        .update(deliveryShipments)
        .set({ lastChecked: now })
        .where(eq(deliveryShipments.id, shipmentId));

    if (result.status !== previousStatus) {
        const orderStatusUpdate = await ShipmentTracker.updateOrderStatusFromShipment(
            shipmentId,
            result.status,
        );

        await ShipmentTracker.notifyStatusChange(
            shipmentId,
            previousStatus,
            result.status,
        );

        return c.json({
            success: true,
            message: `Shipment status updated from ${previousStatus} to ${result.status}`,
            data: {
                ...result,
                statusChanged: true,
                orderStatusUpdate: orderStatusUpdate || "No change needed",
                lastChecked: now.toISOString(),
            }
        }, 200);
    }

    return c.json({
        success: true,
        message: "Shipment status checked successfully",
        data: {
            ...result,
            statusChanged: false,
            lastChecked: now.toISOString(),
        }
    }, 200);
});

export { app as adminShipmentRoutes };
