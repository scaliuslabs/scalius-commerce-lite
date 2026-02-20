import { db } from "@/db";
import { deliveryShipments, orders } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Utility for tracking shipment status changes
 */
export class ShipmentTracker {
  /**
   * Updates the order status based on shipment status if applicable
   * @param shipmentId - The ID of the shipment
   * @param newStatus - The new status of the shipment
   */
  static async updateOrderStatusFromShipment(
    shipmentId: string,
    newStatus: string,
  ) {
    try {
      // Get the shipment
      const [shipment] = await db
        .select()
        .from(deliveryShipments)
        .where(eq(deliveryShipments.id, shipmentId));

      if (!shipment) {
        console.error(`Shipment with ID ${shipmentId} not found`);
        return;
      }

      // Get the order
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, shipment.orderId));

      if (!order) {
        console.error(`Order with ID ${shipment.orderId} not found`);
        return;
      }

      console.log(
        `Mapping shipment status "${newStatus}" to order status. Current order status: ${order.status}`,
      );

      // Map shipment status to order status
      let newOrderStatus = order.status;

      switch (newStatus.toLowerCase()) {
        case "picked_up":
          if (
            order.status !== "delivered" &&
            order.status !== "returned" &&
            order.status !== "cancelled"
          ) {
            newOrderStatus = "shipped";
          }
          break;
        case "in_transit":
          if (
            order.status !== "delivered" &&
            order.status !== "returned" &&
            order.status !== "cancelled"
          ) {
            newOrderStatus = "shipped";
          }
          break;
        case "delivered":
          newOrderStatus = "delivered";
          break;
        case "returned":
          newOrderStatus = "returned";
          break;
        case "failed":
          // Only update if the order is in shipped or processing status
          if (order.status === "shipped" || order.status === "processing") {
            // For failed deliveries, we revert to confirmed (to try again)
            newOrderStatus = "confirmed";
          }
          break;
        case "cancelled":
          // Cancellation can come from various source points, handle differently
          if (order.status === "shipped") {
            // If it was already shipped, revert to confirmed
            newOrderStatus = "confirmed";
          } else if (
            order.status === "pending" ||
            order.status === "processing"
          ) {
            // If it was in early stages, mark as cancelled
            newOrderStatus = "cancelled";
          }
          // Otherwise keep the current status
          break;
        case "pending":
          // No change for pending shipments
          break;
        default:
          console.log(
            `No order status mapping for shipment status: ${newStatus}`,
          );
      }

      console.log(`New order status will be: ${newOrderStatus}`);

      // Update order status if it has changed
      if (newOrderStatus !== order.status) {
        await db
          .update(orders)
          .set({
            status: newOrderStatus,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, order.id));

        console.log(
          `Updated order ${order.id} status from ${order.status} to ${newOrderStatus}`,
        );
        return {
          orderId: order.id,
          previousStatus: order.status,
          newStatus: newOrderStatus,
        };
      }

      return null;
    } catch (error) {
      console.error("Error updating order status from shipment:", error);
      return null;
    }
  }

  /**
   * Sends a notification about a shipment status change (placeholder for future implementation)
   * @param shipmentId - The ID of the shipment
   * @param previousStatus - The previous status
   * @param newStatus - The new status
   */
  static async notifyStatusChange(
    shipmentId: string,
    previousStatus: string,
    newStatus: string,
  ) {
    try {
      // Get the shipment
      const [shipment] = await db
        .select()
        .from(deliveryShipments)
        .where(eq(deliveryShipments.id, shipmentId));

      if (!shipment) {
        console.error(`Shipment with ID ${shipmentId} not found`);
        return;
      }

      // Get the order
      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.id, shipment.orderId));

      if (!order) {
        console.error(`Order with ID ${shipment.orderId} not found`);
        return;
      }

      // This is a placeholder for future notification implementation
      // Here you would integrate with a notification service like SMS, email, etc.
      console.log(
        `Status change notification for shipment ${shipmentId} (Order #${order.id}): ${previousStatus} -> ${newStatus}`,
      );

      // Return notification info
      return {
        shipmentId,
        orderId: order.id,
        customerPhone: order.customerPhone,
        customerEmail: order.customerEmail,
        previousStatus,
        newStatus,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error("Error sending status change notification:", error);
      return null;
    }
  }

  /**
   * Get the public tracking URL for a shipment.
   *
   * @param providerType - The courier provider type (pathao, steadfast)
   * @param trackingId - The tracking ID from the courier
   * @returns The tracking URL, or null if not available
   */
  static getTrackingUrl(
    providerType: string,
    trackingId: string | null
  ): string | null {
    if (!trackingId) return null;

    switch (providerType) {
      case "pathao":
        return `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(trackingId)}`;
      case "steadfast":
        return `https://steadfast.com.bd/t/${encodeURIComponent(trackingId)}`;
      default:
        return null;
    }
  }
}
