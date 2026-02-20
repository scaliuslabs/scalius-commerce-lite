// src/pages/api/orders/[id]/fulfill.ts
// Admin API: Create a shipment for (partial or full) order fulfillment.
//
// POST - Create a new shipment for order items
// GET  - List shipments for an order

import type { APIRoute } from "astro";
import { db } from "@/db";
import {
  orders,
  orderItems,
  deliveryShipments,
  FulfillmentStatus,
  ItemFulfillmentStatus,
  OrderStatus,
} from "@/db/schema";
import { eq, sql, and } from "drizzle-orm";

export const GET: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) return Response.json({ error: "Order ID required" }, { status: 400 });

  try {
    const shipments = await db
      .select()
      .from(deliveryShipments)
      .where(eq(deliveryShipments.orderId, id))
      .all();

    return Response.json({ shipments });
  } catch (error) {
    console.error("Error fetching shipments:", error);
    return Response.json({ error: "Failed to fetch shipments" }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  const { id: orderId } = params;
  if (!orderId) return Response.json({ error: "Order ID required" }, { status: 400 });

  try {
    const body = await request.json() as {
      /** Which order item IDs are in this shipment. Omit to include all unfulfilled items. */
      itemIds?: string[];
      /** Tracking number (e.g. from courier) */
      trackingId?: string;
      trackingUrl?: string;
      courierName?: string;
      note?: string;
      isFinalShipment?: boolean;
      /** Amount for this shipment (used with Stripe multicapture) */
      shipmentAmount?: number;
    };

    // Fetch the order
    const order = await db
      .select({ id: orders.id, status: orders.status, fulfillmentStatus: orders.fulfillmentStatus })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();

    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });

    if (
      order.status === OrderStatus.CANCELLED ||
      order.status === OrderStatus.RETURNED
    ) {
      return Response.json({ error: "Cannot fulfill a cancelled/returned order" }, { status: 400 });
    }

    // Fetch all order items
    const allItems = await db
      .select({ id: orderItems.id, fulfillmentStatus: orderItems.fulfillmentStatus })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .all();

    // Determine which items are in this shipment
    const shipmentItemIds = body.itemIds ?? allItems.map((i) => i.id);

    // Check that none of the selected items are already shipped/delivered
    const alreadyFulfilled = allItems.filter(
      (i) =>
        shipmentItemIds.includes(i.id) &&
        (i.fulfillmentStatus === ItemFulfillmentStatus.SHIPPED ||
          i.fulfillmentStatus === ItemFulfillmentStatus.DELIVERED)
    );
    if (alreadyFulfilled.length > 0) {
      return Response.json(
        { error: `Items already shipped: ${alreadyFulfilled.map((i) => i.id).join(", ")}` },
        { status: 400 }
      );
    }

    const shipmentId = `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date();

    // Detect if this shipment covers all remaining unfulfilled items
    const unfulfilledItemIds = allItems
      .filter((i) => i.fulfillmentStatus === ItemFulfillmentStatus.PENDING || i.fulfillmentStatus === ItemFulfillmentStatus.PICKED || i.fulfillmentStatus === ItemFulfillmentStatus.PACKED)
      .map((i) => i.id);

    const isFinalShipment =
      body.isFinalShipment ??
      (shipmentItemIds.every((sid) => unfulfilledItemIds.includes(sid)) &&
        unfulfilledItemIds.every((uid) => shipmentItemIds.includes(uid)));

    // Determine new order fulfillment status
    const isPartial = !isFinalShipment;
    const newFulfillmentStatus = isPartial
      ? FulfillmentStatus.PARTIAL
      : FulfillmentStatus.COMPLETE;

    // Build batch writes
    const writes: any[] = [];

    // Create the shipment record
    writes.push(
      db.insert(deliveryShipments).values({
        id: shipmentId,
        orderId,
        trackingId: body.trackingId ?? null,
        trackingUrl: body.trackingUrl ?? null,
        courierName: body.courierName ?? null,
        status: "processing",
        note: body.note ?? null,
        shipmentItems: JSON.stringify(shipmentItemIds),
        shipmentAmount: body.shipmentAmount ?? null,
        isFinalShipment,
        createdAt: now,
        updatedAt: now,
      })
    );

    // Mark selected items as shipped
    for (const itemId of shipmentItemIds) {
      writes.push(
        db
          .update(orderItems)
          .set({ fulfillmentStatus: ItemFulfillmentStatus.SHIPPED })
          .where(eq(orderItems.id, itemId))
      );
    }

    // Update order fulfillment status and optionally order status
    const orderUpdate: Record<string, any> = {
      fulfillmentStatus: newFulfillmentStatus,
      updatedAt: sql`unixepoch()`,
    };
    if (isFinalShipment && order.status === OrderStatus.CONFIRMED) {
      orderUpdate.status = OrderStatus.SHIPPED;
    }

    writes.push(db.update(orders).set(orderUpdate).where(eq(orders.id, orderId)));

    await db.batch(writes as any);

    return Response.json({
      success: true,
      shipmentId,
      isFinalShipment,
      fulfillmentStatus: newFulfillmentStatus,
    }, { status: 201 });
  } catch (error) {
    console.error("Error creating shipment:", error);
    return Response.json({ error: "Failed to create shipment" }, { status: 500 });
  }
};
