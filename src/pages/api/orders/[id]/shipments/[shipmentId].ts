import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";

// Initialize the service
const deliveryService = new DeliveryService();

export const GET: APIRoute = async ({ params }) => {
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

    return new Response(JSON.stringify(shipment), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error fetching shipment:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to fetch shipment",
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

export const DELETE: APIRoute = async ({ params }) => {
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

    await deliveryService.deleteShipment(shipmentId);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error deleting shipment:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to delete shipment",
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
