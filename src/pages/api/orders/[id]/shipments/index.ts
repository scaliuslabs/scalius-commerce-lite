import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";
import { db } from "@/db";
import { deliveryShipments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { safeErrorResponse } from "@/lib/error-utils";

// Initialize the service
const deliveryService = new DeliveryService();

export const GET: APIRoute = async ({ params }) => {
  try {
    // Authentication is handled by middleware
    const { id: orderId } = params;

    if (!orderId) {
      return new Response(JSON.stringify({ error: "Order ID is required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    // Get shipments with provider information
    const shipments = await deliveryService.getShipments(orderId);

    // Add provider names to the shipments
    const enhancedShipments = await Promise.all(
      shipments.map(async (shipment) => {
        const provider = await deliveryService.getProvider(shipment.providerId);
        return {
          ...shipment,
          providerName: provider?.name || shipment.providerType,
          // Add lastChecked time if not already present (defaulting to updatedAt)
          lastChecked: shipment.lastChecked || shipment.updatedAt,
        };
      }),
    );

    return new Response(JSON.stringify(enhancedShipments), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  try {
    // Authentication is handled by middleware
    const { id: orderId } = params;

    if (!orderId) {
      return new Response(JSON.stringify({ error: "Order ID is required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    // Get request body
    const data = await request.json();
    const { providerId, options } = data;

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

    // Create shipment
    const shipment = await deliveryService.createShipment(
      orderId,
      providerId,
      options,
    );

    if (!shipment.success) {
      return new Response(
        JSON.stringify({
          error: "Failed to create shipment",
          message: shipment.message,
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Get the created shipment with provider name
    const provider = await deliveryService.getProvider(providerId);
    const createdShipment = await deliveryService.getLatestShipment(orderId);

    if (!createdShipment) {
      return new Response(
        JSON.stringify({ error: "Failed to retrieve created shipment" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Update with lastChecked time
    const now = new Date();
    await db
      .update(deliveryShipments)
      .set({
        lastChecked: now,
      })
      .where(eq(deliveryShipments.id, createdShipment.id));

    // Return shipment with provider details and lastChecked
    const enhancedShipment = {
      ...createdShipment,
      providerName: provider?.name || createdShipment.providerType,
      lastChecked: now.toISOString(),
    };

    return new Response(JSON.stringify(enhancedShipment), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return safeErrorResponse(error, 500);
  }
};
