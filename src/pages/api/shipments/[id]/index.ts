import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";
import { safeErrorResponse } from "@/lib/error-utils";

// Initialize the service
const deliveryService = new DeliveryService();

export const GET: APIRoute = async ({ params }) => {
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

    const shipment = await deliveryService.getShipment(shipmentId);

    if (!shipment) {
      return new Response(JSON.stringify({ error: "Shipment not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    return new Response(JSON.stringify(shipment), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};

export const DELETE: APIRoute = async ({ params }) => {
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

    const shipment = await deliveryService.getShipment(shipmentId);

    if (!shipment) {
      return new Response(JSON.stringify({ error: "Shipment not found" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    await deliveryService.deleteShipment(shipmentId);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Shipment deleted successfully",
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
