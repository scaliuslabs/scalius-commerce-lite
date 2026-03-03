import type { APIRoute } from "astro";
import { DeliveryService } from "@/lib/delivery/service";
import { safeErrorResponse } from "@/lib/error-utils";
import { applyInventoryForStatusChange } from "@/lib/inventory/inventory-transitions";
import { db } from "@/db";
import { orders, OrderStatus, FulfillmentStatus } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

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

    // Process shipments sequentially to avoid inventory race conditions
    const results = [];
    for (const orderId of orderIds) {
      try {
        const shipment = await deliveryService.createShipment(
          orderId,
          providerId,
          options,
        );

        // If shipment was successful, update order status to shipped
        // and trigger permanent inventory deduction
        if (shipment.success) {
          const newInventoryAction = await applyInventoryForStatusChange(
            db, orderId, OrderStatus.SHIPPED
          );
          await db
            .update(orders)
            .set({
              status: OrderStatus.SHIPPED,
              fulfillmentStatus: FulfillmentStatus.COMPLETE,
              inventoryAction: newInventoryAction,
              updatedAt: sql`unixepoch()`,
            })
            .where(eq(orders.id, orderId));
        }

        results.push({
          orderId,
          success: shipment.success,
          shipment: shipment.success ? shipment : undefined,
          error: shipment.success ? undefined : shipment.message,
        });
      } catch (error) {
        results.push({
          orderId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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
    return safeErrorResponse(error, 500);
  }
};
