import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";
import { ShipmentTracker } from "@/lib/delivery/tracking";
import { db } from "@/db";
import { deliveryShipments } from "@/db/schema";
import { eq } from "drizzle-orm";

// Initialize the service
const deliveryService = new DeliveryService();

export const POST: APIRoute = async ({ params }) => {
  try {
    // Authentication is handled by middleware
    const { id: shipmentId } = params;

    if (!shipmentId) {
      return new Response(
        JSON.stringify({ error: "Shipment ID is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Get the current status before checking
    const [currentShipment] = await db
      .select()
      .from(deliveryShipments)
      .where(eq(deliveryShipments.id, shipmentId));

    if (!currentShipment) {
      return new Response(
        JSON.stringify({ error: `Shipment with ID ${shipmentId} not found` }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    const previousStatus = currentShipment.status;

    // Check the shipment status
    const result = await deliveryService.checkShipmentStatus(shipmentId);

    // Update lastChecked timestamp
    const now = new Date();
    await db
      .update(deliveryShipments)
      .set({
        lastChecked: now,
      })
      .where(eq(deliveryShipments.id, shipmentId));

    // If the status has changed, update the order status and send notification
    if (result.status !== previousStatus) {
      // Update the order status if needed
      const orderStatusUpdate =
        await ShipmentTracker.updateOrderStatusFromShipment(
          shipmentId,
          result.status,
        );

      // Send notification about status change
      await ShipmentTracker.notifyStatusChange(
        shipmentId,
        previousStatus,
        result.status,
      );

      return new Response(
        JSON.stringify({
          success: true,
          message: `Shipment status updated from ${previousStatus} to ${result.status}`,
          data: {
            ...result,
            statusChanged: true,
            orderStatusUpdate: orderStatusUpdate || "No change needed",
            lastChecked: now.toISOString(),
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Shipment status checked successfully",
        data: {
          ...result,
          statusChanged: false,
          lastChecked: now.toISOString(),
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error checking shipment status:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to check shipment status",
        details: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
};
