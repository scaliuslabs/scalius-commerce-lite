import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";
import { ShipmentTracker } from "@/lib/delivery/tracking";
import { db } from "@/db";
import { deliveryShipments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { safeErrorResponse } from "@/lib/error-utils";

// Initialize the service
const deliveryService = new DeliveryService();

export const POST: APIRoute = async ({ params }) => {
  try {
    // Authentication is handled by middleware
    const { id: orderId, shipmentId } = params;

    if (!orderId || !shipmentId) {
      return new Response(
        JSON.stringify({ error: "Order ID and Shipment ID are required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Check if shipment exists and belongs to the order
    const shipment = await deliveryService.getShipment(shipmentId);

    if (!shipment) {
      return new Response(JSON.stringify({ error: "Shipment not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    if (shipment.orderId !== orderId) {
      return new Response(
        JSON.stringify({ error: "Shipment does not belong to this order" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Save the previous status to check if it changes
    const previousStatus = shipment.status;

    // Check shipment status
    try {
      // Just update the status - no need to check the result structure
      await deliveryService.checkShipmentStatus(shipmentId);
    } catch (statusError) {
      return new Response(
        JSON.stringify({
          error: "Failed to refresh shipment status",
          message:
            statusError instanceof Error
              ? statusError.message
              : "Unknown error occurred",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Update lastChecked timestamp
    const now = new Date();
    await db
      .update(deliveryShipments)
      .set({
        lastChecked: now,
      })
      .where(eq(deliveryShipments.id, shipmentId));

    // Get the updated shipment
    const updatedShipment = await deliveryService.getShipment(shipmentId);

    if (!updatedShipment) {
      return new Response(
        JSON.stringify({ error: "Failed to retrieve updated shipment" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Get the provider for the response
    const provider = updatedShipment.providerId
      ? await deliveryService.getProvider(updatedShipment.providerId)
      : null;

    // Check if the status changed
    const statusChanged = previousStatus !== updatedShipment.status;

    // If status changed, update the order status via ShipmentTracker
    let orderStatusUpdate = false;
    if (statusChanged) {
      try {
        console.log(
          `Shipment status changed from ${previousStatus} to ${updatedShipment.status}, updating order status`,
        );
        const orderUpdate = await ShipmentTracker.updateOrderStatusFromShipment(
          shipmentId,
          updatedShipment.status,
        );
        orderStatusUpdate = !!orderUpdate && !!orderUpdate.orderId;
        console.log(
          `Order status update: ${orderStatusUpdate ? "Updated" : "No change"}`,
        );
      } catch (orderUpdateError) {
        console.error("Error updating order status:", orderUpdateError);
        // Continue with the response even if order update fails
      }
    }

    return new Response(
      JSON.stringify({
        ...updatedShipment,
        providerName: provider?.name || updatedShipment.providerType,
        providerType: updatedShipment.providerType,
        lastChecked: now.toISOString(),
        statusChanged,
        orderStatusUpdate,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};
