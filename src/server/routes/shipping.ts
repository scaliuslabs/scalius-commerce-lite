import { Hono } from "hono";

import { deliveryShipments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { DeliveryService } from "@/lib/delivery/service";
import { ShipmentTracker } from "@/lib/delivery/tracking";

// Create a Hono app for shipping routes
const app = new Hono<{ Bindings: Env }>();

// Initialize the delivery service
const deliveryService = new DeliveryService();

// Helper function to convert Unix timestamp to Date
const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

// GET - Get all shipments for an order
app.get("/orders/:id/shipments", async (c) => {
  try {
    const db = c.get("db");
    const orderId = c.req.param("id");

    if (!orderId) {
      return c.json({ error: "Order ID is required" }, 400);
    }

    // Get shipments from database
    const shipments = await db
      .select({
        id: deliveryShipments.id,
        orderId: deliveryShipments.orderId,
        providerId: deliveryShipments.providerId,
        providerType: deliveryShipments.providerType,
        externalId: deliveryShipments.externalId,
        trackingId: deliveryShipments.trackingId,
        status: deliveryShipments.status,
        rawStatus: deliveryShipments.rawStatus,
        metadata: deliveryShipments.metadata,
        lastChecked: deliveryShipments.lastChecked,
        createdAt: deliveryShipments.createdAt,
        updatedAt: deliveryShipments.updatedAt,
      })
      .from(deliveryShipments)
      .where(eq(deliveryShipments.orderId, orderId));

    // Format dates and parse metadata
    const formattedShipments = shipments.map((shipment) => ({
      ...shipment,
      metadata: shipment.metadata ? JSON.parse(shipment.metadata) : null,
      lastChecked:
        unixToDate(shipment.lastChecked as unknown as number)?.toISOString() ||
        null,
      createdAt:
        unixToDate(shipment.createdAt as unknown as number)?.toISOString() ||
        null,
      updatedAt:
        unixToDate(shipment.updatedAt as unknown as number)?.toISOString() ||
        null,
    }));

    // Add provider names to the shipments
    const enhancedShipments = await Promise.all(
      formattedShipments.map(async (shipment: any) => {
        const provider = await deliveryService.getProvider(shipment.providerId);
        return {
          ...shipment,
          providerName: provider?.name || shipment.providerType,
        };
      }),
    );

    // Return an array directly to match the original API format
    return c.json(enhancedShipments);
  } catch (error) {
    console.error("Error fetching shipments:", error);
    return c.json({ error: "Failed to fetch shipments" }, 500);
  }
});

// POST - Create a shipment for an order
app.post("/orders/:id/shipments", async (c) => {
  try {
    const db = c.get("db");
    const orderId = c.req.param("id");

    if (!orderId) {
      return c.json({ error: "Order ID is required" }, 400);
    }

    const json = await c.req.json();
    const { providerId, options = {} } = json;

    if (!providerId) {
      return c.json({ error: "Provider ID is required" }, 400);
    }

    // Create shipment using the delivery service
    const result = await deliveryService.createShipment(
      orderId,
      providerId,
      options,
    );

    if (!result.success) {
      return c.json({ error: result.message }, 400);
    }

    // Get the created shipment with provider name to match original API format
    const provider = await deliveryService.getProvider(providerId);
    const createdShipment = await deliveryService.getLatestShipment(orderId);

    if (!createdShipment) {
      return c.json({ error: "Failed to retrieve created shipment" }, 500);
    }

    // Update with lastChecked time
    const now = new Date();
    await db
      .update(deliveryShipments)
      .set({
        lastChecked: now,
      })
      .where(eq(deliveryShipments.id, createdShipment.id));

    // Return shipment with provider details and lastChecked to match original API
    const enhancedShipment = {
      ...createdShipment,
      providerName: provider?.name || createdShipment.providerType,
      lastChecked: now.toISOString(),
    };

    return c.json(enhancedShipment);
  } catch (error) {
    console.error("Error creating shipment:", error);
    return c.json(
      {
        error: "Failed to create shipment",
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// GET - Get a specific shipment
app.get("/orders/:orderId/shipments/:shipmentId", async (c) => {
  try {
    const { orderId, shipmentId } = c.req.param();

    if (!orderId || !shipmentId) {
      return c.json(
        {
          error: "Order ID and Shipment ID are required",
        },
        400,
      );
    }

    // Get shipment from delivery service
    const shipment = await deliveryService.getShipment(shipmentId);

    if (!shipment) {
      return c.json({ error: "Shipment not found" }, 404);
    }

    return c.json({ shipment });
  } catch (error) {
    console.error("Error fetching shipment:", error);
    return c.json({ error: "Failed to fetch shipment" }, 500);
  }
});

// POST - Update shipment status
app.post("/orders/:orderId/shipments/:shipmentId/status", async (c) => {
  try {
    const { orderId, shipmentId } = c.req.param();

    if (!orderId || !shipmentId) {
      return c.json(
        {
          error: "Order ID and Shipment ID are required",
        },
        400,
      );
    }

    // Update shipment status using delivery service
    // Check if the shipment exists first
    const shipment = await deliveryService.getShipment(shipmentId);

    if (!shipment) {
      return c.json({ error: "Shipment not found" }, 404);
    }

    // Update the shipment status
    try {
      const result = await deliveryService.checkShipmentStatus(shipmentId);

      return c.json({
        success: true,
        data: result,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        400,
      );
    }
  } catch (error) {
    console.error("Error updating shipment status:", error);
    return c.json({ error: "Failed to update shipment status" }, 500);
  }
});

// DELETE - Delete a shipment
app.delete("/shipments/:shipmentId", async (c) => {
  try {
    const shipmentId = c.req.param("shipmentId");

    if (!shipmentId) {
      return c.json({ error: "Shipment ID is required" }, 400);
    }

    // Delete shipment using delivery service
    const result = await deliveryService.deleteShipment(shipmentId);

    if (!result) {
      return c.json({ error: "Failed to delete shipment" }, 400);
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting shipment:", error);
    return c.json({ error: "Failed to delete shipment" }, 500);
  }
});

// POST - Bulk create shipments for multiple orders
app.post("/orders/bulk-ship", async (c) => {
  try {
    const json = await c.req.json();
    const { orderIds, providerId, options = {} } = json;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return c.json(
        {
          error: "Order IDs array is required and must not be empty",
        },
        400,
      );
    }

    if (!providerId) {
      return c.json({ error: "Provider ID is required" }, 400);
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

    return c.json({
      totalProcessed: results.length,
      successCount,
      failureCount,
      results,
    });
  } catch (error) {
    console.error("Error creating bulk shipments:", error);
    return c.json(
      {
        error: "Failed to process bulk shipments",
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// Add the refresh endpoint
app.post("/orders/:orderId/shipments/:shipmentId/refresh", async (c) => {
  try {
    const db = c.get("db");
    const { orderId, shipmentId } = c.req.param();

    if (!orderId || !shipmentId) {
      return c.json({ error: "Order ID and Shipment ID are required" }, 400);
    }

    // Check if shipment exists and belongs to the order
    const shipment = await deliveryService.getShipment(shipmentId);

    if (!shipment) {
      return c.json({ error: "Shipment not found" }, 404);
    }

    if (shipment.orderId !== orderId) {
      return c.json({ error: "Shipment does not belong to this order" }, 400);
    }

    // Save the previous status to check if it changes
    const previousStatus = shipment.status;

    // Check shipment status
    try {
      // Just update the status - no need to check the result structure
      await deliveryService.checkShipmentStatus(shipmentId);
    } catch (statusError) {
      return c.json(
        {
          error: "Failed to refresh shipment status",
          message:
            statusError instanceof Error
              ? statusError.message
              : "Unknown error occurred",
        },
        400,
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
      return c.json({ error: "Failed to retrieve updated shipment" }, 500);
    }

    // Get the provider for the response
    const provider = await deliveryService.getProvider(
      updatedShipment.providerId,
    );

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

    // Return direct object instead of nested response to match original API
    return c.json({
      ...updatedShipment,
      providerName: provider?.name || updatedShipment.providerType,
      providerType: updatedShipment.providerType,
      lastChecked: now.toISOString(),
      statusChanged,
      orderStatusUpdate,
    });
  } catch (error) {
    console.error("Error refreshing shipment status:", error);
    return c.json(
      {
        error: "Failed to refresh shipment status",
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// Add this endpoint after the existing refresh endpoint
// POST - Bulk refresh shipments
app.post("/shipments/bulk-refresh", async (c) => {
  try {
    const db = c.get("db");
    const json = await c.req.json();
    const { shipments } = json;

    if (!shipments || !Array.isArray(shipments) || shipments.length === 0) {
      return c.json(
        {
          error: "Shipments array is required and must not be empty",
        },
        400,
      );
    }

    // Process shipments in parallel with a concurrency limit
    const CONCURRENCY_LIMIT = 5; // Process up to 5 shipments at a time
    const results = [];

    // Process shipments in batches to avoid overwhelming the system
    for (let i = 0; i < shipments.length; i += CONCURRENCY_LIMIT) {
      const batch = shipments.slice(i, i + CONCURRENCY_LIMIT);

      // Process each batch in parallel
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          const { orderId, shipmentId } = item;

          try {
            if (!orderId || !shipmentId) {
              return {
                orderId,
                shipmentId,
                success: false,
                error: "Order ID and Shipment ID are required",
              };
            }

            // Check if shipment exists and belongs to the order
            const shipment = await deliveryService.getShipment(shipmentId);

            if (!shipment) {
              return {
                orderId,
                shipmentId,
                success: false,
                error: "Shipment not found",
              };
            }

            if (shipment.orderId !== orderId) {
              return {
                orderId,
                shipmentId,
                success: false,
                error: "Shipment does not belong to this order",
              };
            }

            // Save the previous status to check if it changes
            const previousStatus = shipment.status;

            // Check shipment status
            try {
              await deliveryService.checkShipmentStatus(shipmentId);
            } catch (statusError) {
              return {
                orderId,
                shipmentId,
                success: false,
                error:
                  statusError instanceof Error
                    ? statusError.message
                    : "Unknown error occurred",
              };
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
            const updatedShipment =
              await deliveryService.getShipment(shipmentId);

            if (!updatedShipment) {
              return {
                orderId,
                shipmentId,
                success: false,
                error: "Failed to retrieve updated shipment",
              };
            }

            // Get the provider for the response
            const provider = await deliveryService.getProvider(
              updatedShipment.providerId,
            );

            // Check if the status changed
            const statusChanged = previousStatus !== updatedShipment.status;

            // If status changed, update the order status via ShipmentTracker
            let orderStatusUpdate = false;
            if (statusChanged) {
              try {
                console.log(
                  `Shipment status changed from ${previousStatus} to ${updatedShipment.status}, updating order status`,
                );
                const orderUpdate =
                  await ShipmentTracker.updateOrderStatusFromShipment(
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

            // Return shipment data
            return {
              orderId,
              shipmentId,
              success: true,
              shipment: {
                ...updatedShipment,
                providerName: provider?.name || updatedShipment.providerType,
                providerType: updatedShipment.providerType,
                lastChecked: now.toISOString(),
                statusChanged,
                orderStatusUpdate,
              },
            };
          } catch (error) {
            console.error(`Error refreshing shipment ${shipmentId}:`, error);
            return {
              orderId,
              shipmentId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );

      // Add batch results to overall results
      results.push(...batchResults);
    }

    // Count successes and failures
    const successCount = results.filter((result) => result.success).length;
    const failureCount = results.length - successCount;

    return c.json({
      totalProcessed: results.length,
      successCount,
      failureCount,
      results,
    });
  } catch (error) {
    console.error("Error refreshing bulk shipments:", error);
    return c.json(
      {
        error: "Failed to process bulk refresh",
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

// GET - Get all active delivery providers
app.get("/delivery-providers", async (c) => {
  try {
    const activeProviders = await deliveryService.getActiveProviders();
    return c.json(activeProviders);
  } catch (error) {
    console.error("Error fetching active delivery providers:", error);
    return c.json({ error: "Failed to fetch delivery providers" }, 500);
  }
});

// Export the shipping routes
export { app as shippingRoutes };
