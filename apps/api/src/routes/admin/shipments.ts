// src/server/routes/admin/shipments.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getShipment, deleteShipmentRecord, checkShipmentStatus } from "@scalius/core/modules/delivery/service";
import { updateOrderStatusFromShipment, notifyShipmentStatusChange } from "@scalius/core/modules/delivery/tracking";
import { deliveryShipments } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { NotFoundError } from "../../utils/api-error";

import { ok } from "../../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

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
        200: { description: "Shipment details"  },
        404: { description: "Shipment not found"  }
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
        200: { description: "Shipment deleted"  },
        404: { description: "Shipment not found"  }
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
        200: { description: "Status checked"  },
        404: { description: "Shipment not found"  }
    }
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
    const result = await checkShipmentStatus(db, shipmentId);
    const now = new Date();

    await db
        .update(deliveryShipments)
        .set({ lastChecked: now })
        .where(eq(deliveryShipments.id, shipmentId));

    if (result.status !== previousStatus) {
        const orderStatusUpdate = await updateOrderStatusFromShipment(
            db,
            shipmentId,
            result.status,
        );

        await notifyShipmentStatusChange(
            db,
            shipmentId,
            previousStatus,
            result.status,
        );

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
});

export { app as adminShipmentRoutes };
