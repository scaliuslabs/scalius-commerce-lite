// src/server/routes/admin/shipments.ts
import { Hono } from "hono";
import { DeliveryService } from "@/modules/delivery/service";
import { ShipmentTracker } from "@/modules/delivery/tracking";
import { deliveryShipments } from "@/db/schema";
import { eq } from "drizzle-orm";

const app = new Hono<{ Bindings: any }>();
const deliveryService = new DeliveryService();

app.get("/:id", async (c) => {
    try {
        const shipmentId = c.req.param("id");
        const shipment = await deliveryService.getShipment(shipmentId);

        if (!shipment) {
            return c.json({ error: "Shipment not found" }, 404);
        }
        return c.json(shipment, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.delete("/:id", async (c) => {
    try {
        const shipmentId = c.req.param("id");
        const shipment = await deliveryService.getShipment(shipmentId);

        if (!shipment) {
            return c.json({ error: "Shipment not found" }, 404);
        }

        await deliveryService.deleteShipment(shipmentId);
        return c.json({ success: true, message: "Shipment deleted successfully" }, 200);
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

app.post("/:id/check-status", async (c) => {
    const db = c.get("db");
    const shipmentId = c.req.param("id");

    try {
        const [currentShipment] = await db
            .select()
            .from(deliveryShipments)
            .where(eq(deliveryShipments.id, shipmentId));

        if (!currentShipment) {
            return c.json({ error: `Shipment with ID ${shipmentId} not found` }, 404);
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
            });
        }

        return c.json({
            success: true,
            message: "Shipment status checked successfully",
            data: {
                ...result,
                statusChanged: false,
                lastChecked: now.toISOString(),
            }
        });
    } catch (error: any) {
        return c.json({ error: "Internal server error" }, 500);
    }
});

export { app as adminShipmentRoutes };
