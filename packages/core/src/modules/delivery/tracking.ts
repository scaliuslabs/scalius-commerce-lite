import { deliveryShipments, orders, ShipmentStatus } from "@scalius/database/schema";
import { eq, and, sql } from "drizzle-orm";
import { applyInventoryForStatusChangeWithImpact } from "../inventory/inventory-transitions";
import { canTransitionTo } from "../orders/order-state-machine";
import type { Database } from "@scalius/database/client";
import { assertNoActiveShipmentClaim } from "../orders/shipment-claim";
import {
  assertNoActiveRefundAttempt,
  noActiveRefundAttemptForOrderIdCondition,
} from "../payments/refund-attempt-guard";
import {
  assertNoActivePaymentSessionAttempt,
  noActivePaymentSessionAttemptForOrderIdCondition,
} from "../payments/payment-session-attempts";
import { markShipmentReconciliationRequired } from "./delivery.service";

function parseShipmentMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

async function markInventoryReconciliationRequired(
  db: Database,
  shipmentId: string,
  shipmentStatus: string,
  orderStatus: string,
  error: unknown,
): Promise<void> {
  try {
    await markShipmentReconciliationRequired(
      db,
      shipmentId,
      "order_status_inventory_reconcile_failed",
      {
        status: shipmentStatus,
        metadata: {
          orderStatusSync: {
            shipmentStatus,
            orderStatus,
            failedStep: "inventory_reconciliation",
          },
        },
      },
      error,
    );
  } catch (markError: unknown) {
    console.error("Failed to mark shipment reconciliation after inventory sync failure:", {
      shipmentId,
      shipmentStatus,
      orderStatus,
      error: markError instanceof Error ? { message: markError.message, stack: markError.stack } : markError,
    });
  }
}

async function clearShipmentReconciliationIfNeeded(
  db: Database,
  shipment: { id: string; status?: string | null; metadata?: unknown },
  shipmentStatus: string,
): Promise<void> {
  if (shipment.status !== ShipmentStatus.RECONCILE_REQUIRED) return;

  const metadata = parseShipmentMetadata(shipment.metadata);
  delete metadata.reconciliation;
  delete metadata.orderStatusSync;

  await db
    .update(deliveryShipments)
    .set({
      status: shipmentStatus,
      rawStatus: shipmentStatus,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(deliveryShipments.id, shipment.id),
      eq(deliveryShipments.status, ShipmentStatus.RECONCILE_REQUIRED),
    ));
}

async function reconcileShipmentInventory(
  db: Database,
  shipment: { id: string; status?: string | null; metadata?: unknown },
  orderId: string,
  orderStatus: string,
  shipmentStatus: string,
): Promise<string[]> {
  try {
    const impact = await applyInventoryForStatusChangeWithImpact(db, orderId, orderStatus);
    await db
      .update(orders)
      .set({ inventoryAction: impact.inventoryAction })
      .where(eq(orders.id, orderId));
    await clearShipmentReconciliationIfNeeded(db, shipment, shipmentStatus);
    return impact.availabilityTransitionVariantIds;
  } catch (error: unknown) {
    await markInventoryReconciliationRequired(db, shipment.id, shipmentStatus, orderStatus, error);
    throw error;
  }
}

/**
 * Updates the order status based on shipment status if applicable
 * @param db - The database instance
 * @param shipmentId - The ID of the shipment
 * @param newStatus - The new status of the shipment
 */
export async function updateOrderStatusFromShipment(
  db: Database,
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

    // Get the order (include version for CAS locking)
    const [order] = await db
      .select({
        id: orders.id,
        status: orders.status,
        version: orders.version,
        customerPhone: orders.customerPhone,
        customerEmail: orders.customerEmail,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
      })
      .from(orders)
      .where(eq(orders.id, shipment.orderId));

    if (!order) {
      console.error(`Order with ID ${shipment.orderId} not found`);
      return;
    }
    assertNoActiveShipmentClaim(order);
    await assertNoActiveRefundAttempt(db, order.id);
    await assertNoActivePaymentSessionAttempt(db, order.id);

    // Map shipment status to order status
    let newOrderStatus = order.status;

    switch (newStatus.toLowerCase()) {
      case "pickup_assigned":
      case "picked_up":
      case "in_transit":
      case "out_for_delivery":
        if (
          order.status !== "delivered" &&
          order.status !== "returned" &&
          order.status !== "cancelled"
        ) {
          newOrderStatus = "shipped";
        }
        break;
      case "partial_delivered":
      case "delivered":
        newOrderStatus = "delivered";
        break;
      case "returned":
        newOrderStatus = "returned";
        break;
      case "pickup_failed":
      case "delivery_failed":
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
      case "on_hold":
      case "unknown":
      case "pending":
        // No change for pending shipments
        break;
      default:
        console.log(
          `No order status mapping for shipment status: ${newStatus}`,
        );
    }

    // Update order status if it has changed
    if (newOrderStatus !== order.status) {
      // Validate the transition is allowed by the state machine
      if (!canTransitionTo("order", order.status, newOrderStatus)) {
        console.log(
          `Skipping order ${order.id} status update: transition from "${order.status}" to "${newOrderStatus}" not allowed by state machine`,
        );
        return null;
      }

      // CAS update FIRST: only proceed with inventory if we win the version check.
      // This prevents orphaned inventory changes when two concurrent callers
      // (e.g. admin + webhook) both apply inventory before either detects the conflict.
      const result = await db
        .update(orders)
        .set({
          status: newOrderStatus,
          version: order.version + 1,
          updatedAt: sql`(unixepoch())`,
        })
        .where(and(
          eq(orders.id, order.id),
          eq(orders.version, order.version),
          noActiveRefundAttemptForOrderIdCondition(order.id),
          noActivePaymentSessionAttemptForOrderIdCondition(order.id),
        ))
        .returning({ id: orders.id });

      if (result.length === 0) {
        console.log(
          `Skipping order ${order.id} status update: order was modified concurrently (version conflict). Admin change takes priority.`,
        );
        return null;
      }

      // CAS succeeded; if inventory reconciliation fails, the webhook/admin
      // status-check caller can retry and operators see the shipment recovery
      // marker instead of a silent status/inventory split.
      const availabilityTransitionVariantIds = await reconcileShipmentInventory(
        db,
        shipment,
        order.id,
        newOrderStatus,
        newStatus,
      );

      console.log(
        `Updated order ${order.id} status from ${order.status} to ${newOrderStatus}`,
      );
      return {
        statusChange: {
          orderId: order.id,
          previousStatus: order.status,
          newStatus: newOrderStatus,
          version: order.version + 1,
        },
        availabilityTransitionVariantIds,
      };
    }

    const availabilityTransitionVariantIds = await reconcileShipmentInventory(
      db,
      shipment,
      order.id,
      newOrderStatus,
      newStatus,
    );

    return { statusChange: null, availabilityTransitionVariantIds };
  } catch (error: unknown) {
    console.error("Error updating order status from shipment:", {
      shipmentId,
      newStatus,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    });
    throw error;
  }
}

/**
 * Get the public tracking URL for a shipment.
 *
 * @param providerType - The courier provider type (pathao, steadfast)
 * @param trackingId - The tracking ID from the courier
 * @returns The tracking URL, or null if not available
 */
export function getTrackingUrl(
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
