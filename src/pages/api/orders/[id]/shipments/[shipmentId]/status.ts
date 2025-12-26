import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";
import { safeErrorResponse } from "@/lib/error-utils";

// Initialize the service
const deliveryService = new DeliveryService();

export const POST: APIRoute = async ({ params }) => {
  try {
    // Authentication is handled by middleware
    const { id: orderId, shipmentId } = params;

    if (!orderId || !shipmentId) {
      return new Response(
        JSON.stringify({
          error: "Order ID and Shipment ID are required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    const shipment = await deliveryService.getShipment(shipmentId);

    if (!shipment) {
      return new Response(JSON.stringify({ error: "Shipment not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    // Ensure the shipment belongs to the specified order
    if (shipment.orderId !== orderId) {
      return new Response(
        JSON.stringify({
          error: "Shipment does not belong to the specified order",
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Check and update shipment status
    const updatedShipment =
      await deliveryService.checkShipmentStatus(shipmentId);

    return new Response(JSON.stringify(updatedShipment), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};
