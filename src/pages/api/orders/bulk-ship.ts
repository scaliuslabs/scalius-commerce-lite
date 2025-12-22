import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";

// Initialize the service
const deliveryService = new DeliveryService();

export const POST: APIRoute = async ({ request }) => {
  try {
    // Authentication is handled by middleware
    const data = await request.json();
    const { orderIds, providerId, options } = data;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: "Order IDs array is required and must not be empty",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (!providerId) {
      return new Response(
        JSON.stringify({ error: "Provider ID is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Process shipments in parallel
    const results = await Promise.all(
      orderIds.map(async (orderId) => {
        try {
          const shipment = await deliveryService.createShipment(
            orderId,
            providerId,
            options,
          );

          return {
            orderId,
            success: true,
            shipment,
          };
        } catch (error) {
          return {
            orderId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    // Count successes and failures
    const successCount = results.filter((result) => result.success).length;
    const failureCount = results.length - successCount;

    return new Response(
      JSON.stringify({
        totalProcessed: results.length,
        successCount,
        failureCount,
        results,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error creating bulk shipments:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to process bulk shipments",
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
